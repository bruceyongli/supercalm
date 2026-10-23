#!/usr/bin/env python3
"""macOS-native, restartable staging copy. Originals are NEVER removed.

copyfile(3) preserves native metadata without openrsync's AppleDouble hardlink bug. Existing
staged files use size/mtime quick-check; independent full integrity verification is mandatory
before cutover. Replaced/extra staging entries are retained in a separate Spark revision tree.
"""
import ctypes
import json
import os
import stat
import sys
import time
import uuid
import fcntl
from concurrent.futures import ThreadPoolExecutor, Future, wait, FIRST_COMPLETED
from collections import deque
from threading import Lock

def same_metadata(source, target, source_info=None, target_info=None):
    a, b = source_info or os.lstat(source), target_info or os.lstat(target)
    # Older rsync staging has second-resolution times. Do not rewrite every unchanged
    # inode merely to add sub-second precision; full integrity checks still cover all
    # persistent permissions/ownership/flags/ACL/xattrs, including directory metadata.
    fields = lambda info: (info.st_mode, info.st_uid, info.st_gid, getattr(info, "st_flags", 0))
    # Staging quick-check only. ACL/xattr/content equivalence is established by the
    # independent verifier, not repeated over the network during every copy retry.
    return fields(a) == fields(b)


def copy_metadata(source, target, force=False, source_info=None, target_info=None):
    if force or not same_metadata(source, target, source_info, target_info):
        native_copy(source, target, metadata=True)

libc = ctypes.CDLL(None, use_errno=True)
libc.copyfile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_uint32]
libc.copyfile.restype = ctypes.c_int
libc.fcopyfile.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
libc.fcopyfile.restype = ctypes.c_int
NOFOLLOW = (1 << 18) | (1 << 19)


def native_copy(source, target, metadata=False):
    info = os.lstat(source)
    if not metadata and stat.S_ISREG(info.st_mode) and info.st_size >= 4 * 1024 * 1024:
        src = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
        dst = None
        try:
            dst = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            fcntl.fcntl(src, 48, 1)  # F_NOCACHE keeps a bulk copy from growing local swap.
            fcntl.fcntl(dst, 48, 1)
            if libc.fcopyfile(src, dst, None, 15) != 0:
                raise OSError(ctypes.get_errno(), "Native streaming copy failed", source)
        finally:
            os.close(src)
            if dst is not None:
                os.close(dst)
        return
    if libc.copyfile(os.fsencode(source), os.fsencode(target), None,
                     NOFOLLOW | (7 if metadata else 15)) != 0:
        raise OSError(ctypes.get_errno(), "Native copy failed", source)


def copy_tree(source, target, revisions, allow_sockets=False, since=None):
    source, target, revisions = map(os.path.abspath, (source, target, revisions))
    if source == target or target.startswith(source + "/") or source.startswith(target + "/"):
        raise ValueError("Overlapping copy roots")
    if os.path.realpath(source) != source or os.path.realpath(target) != target:
        raise ValueError("Copy roots must be physical")
    if revisions.startswith(target + "/") or revisions.startswith(source + "/"):
        raise ValueError("Revisions must be outside both roots")
    device = os.lstat(source).st_dev
    if since is not None and (since <= 0 or since > time.time()):
        raise ValueError("Invalid completed-copy baseline")
    counts = {"files": 0, "copiedBytes": 0, "quickChecked": 0, "unchangedSinceBaseline": 0, "sockets": 0, "unstableSources": []}
    hardlinks = {}
    hardlink_lock = Lock()
    last_progress = time.monotonic()
    progress_lock = Lock()
    workers = max(1, min(16, int(os.environ.get("AIOS_STORAGE_COPY_WORKERS", "8"))))
    pool = ThreadPoolExecutor(max_workers=workers)
    pending = {}
    directories = []

    def retain(path, relative):
        if not os.path.lexists(path):
            return
        saved = os.path.join(revisions, relative or "root")
        os.makedirs(os.path.dirname(saved), exist_ok=True)
        if os.path.lexists(saved):
            saved += "." + str(uuid.uuid4())
        os.rename(path, saved)

    def walk(src, dst, rel):
        nonlocal last_progress
        before = os.lstat(src)
        if before.st_dev != device:
            raise ValueError("Nested filesystem: " + rel)
        unchanged = since is not None and max(before.st_mtime_ns, before.st_ctime_ns) < int(since * 1000000000)
        if unchanged and stat.S_ISDIR(before.st_mode) and rel:
            return before, None, sorted(os.listdir(src)), True
        if unchanged and (stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode)):
            counts["files"] += 1; counts["unchangedSinceBaseline"] += 1
            stable(src, rel, before, os.lstat(src)); progress()
            return
        if since is not None and os.path.realpath(os.path.dirname(dst)) != os.path.dirname(dst):
            raise ValueError("Staging ancestor changed; refusing writes through a symlink: " + rel)
        try:
            previous = os.lstat(dst)
        except FileNotFoundError:
            previous = None
        if stat.S_ISDIR(before.st_mode):
            if previous and not stat.S_ISDIR(previous.st_mode):
                retain(dst, rel)
                previous = None
            if previous is None:
                os.mkdir(dst)
            names = sorted(os.listdir(src))
            # The coordinator schedules children only after their parent exists.
            # Directory stat/mkdir operations must also overlap network latency;
            # doing them on the traversal thread serialized package-heavy trees.
            return before, previous, names, False
        elif stat.S_ISSOCK(before.st_mode) and allow_sockets:
            counts["sockets"] += 1
            retain(dst, rel)
        elif stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode):
            identity = (before.st_dev, before.st_ino)
            future, owner = None, True
            if before.st_nlink > 1 and stat.S_ISREG(before.st_mode):
                with hardlink_lock:
                    future = hardlinks.get(identity)
                    if future is None:
                        future = hardlinks[identity] = Future()
                    else:
                        owner = False
            try:
                if not owner:
                    first, first_info = future.result()
                    if not previous or previous.st_ino != first_info.st_ino or previous.st_dev != first_info.st_dev:
                        retain(dst, rel)
                        os.link(first, dst)
                elif (since is None and previous and stat.S_ISREG(before.st_mode) and stat.S_ISREG(previous.st_mode)
                      and before.st_size == previous.st_size and int(before.st_mtime) == int(previous.st_mtime)):
                    counts["quickChecked"] += 1
                    copy_metadata(src, dst, source_info=before, target_info=previous)
                elif (since is None and previous and stat.S_ISLNK(before.st_mode) and stat.S_ISLNK(previous.st_mode)
                      and os.readlink(src) == os.readlink(dst)):
                    copy_metadata(src, dst, source_info=before, target_info=previous)
                else:
                    temporary = os.path.join(os.path.dirname(dst), ".aios-copy-" + str(uuid.uuid4()))
                    native_copy(src, temporary)
                    retain(dst, rel)
                    os.rename(temporary, dst)
                    if stat.S_ISREG(before.st_mode):
                        counts["copiedBytes"] += before.st_size
                if future and owner:
                    future.set_result((dst, os.lstat(dst)))
            except BaseException as error:
                if future and owner:
                    future.set_exception(error)
                raise
            counts["files"] += 1
        else:
            raise ValueError("Unsupported persistent entry: " + rel)
        after = os.lstat(src)
        stable(src, rel, before, after)
        progress()

    def stable(src, rel, before, after):
        if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            # Staging is not cutover. An active transcript must not prevent unrelated
            # later files from being copied. Record every changed path for a quiesced
            # reconciliation; independent stable verification still gates all removal.
            with progress_lock:
                counts["unstableSources"].append(rel)

    def progress():
        nonlocal last_progress
        with progress_lock:
            if time.monotonic() - last_progress > 15:
                print(json.dumps({"progress": counts}), flush=True)
                last_progress = time.monotonic()

    def finish_directory(src, dst, rel, before, previous, unchanged=False):
        if unchanged:
            stable(src, rel, before, os.lstat(src)); progress()
            return
        if since is not None and os.path.realpath(dst) != dst:
            raise ValueError("Staging directory changed before reconciliation: " + rel)
        for extra in set(os.listdir(dst)) - set(os.listdir(src)):
            retain(os.path.join(dst, extra), os.path.join(rel, extra))
        copy_metadata(src, dst, force=since is not None or previous is None or not rel,
                      source_info=before, target_info=previous)
        stable(src, rel, before, os.lstat(src))
        progress()

    try:
        jobs = deque([(source, target, "")])
        while jobs or pending:
            while jobs and len(pending) < workers * 4:
                args = jobs.popleft()
                pending[pool.submit(walk, *args)] = args
            ready, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in ready:
                src, dst, rel = pending.pop(future)
                result = future.result()
                if result is not None:
                    before, previous, names, unchanged = result
                    directories.append((src, dst, rel, before, previous, unchanged))
                    for name in reversed(names):
                        jobs.appendleft((os.path.join(src, name), os.path.join(dst, name), os.path.join(rel, name)))
        finalized = deque()
        for directory in directories:
            finalized.append(pool.submit(finish_directory, *directory))
            if len(finalized) >= workers * 4:
                finalized.popleft().result()
        while finalized:
            finalized.popleft().result()
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    return counts


if __name__ == "__main__":
    try:
        if sys.platform != "darwin":
            raise ValueError("Native storage copier requires macOS")
        since = next((float(a.split("=", 1)[1]) for a in sys.argv[4:] if a.startswith("--since=")), None)
        print(json.dumps(copy_tree(sys.argv[1], sys.argv[2], sys.argv[3], "--ephemeral-sockets" in sys.argv[4:], since)))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
