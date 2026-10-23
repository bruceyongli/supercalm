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
import runpy
import fcntl
from concurrent.futures import ThreadPoolExecutor
from collections import deque
from threading import Lock

integrity = runpy.run_path(os.path.join(os.path.dirname(__file__), "storage-manifest.py"))


def same_metadata(source, target):
    a, b = os.lstat(source), os.lstat(target)
    # Older rsync staging has second-resolution times. Do not rewrite every unchanged
    # inode merely to add sub-second precision; full integrity checks still cover all
    # persistent permissions/ownership/flags/ACL/xattrs, including directory metadata.
    fields = lambda info: (info.st_mode, info.st_uid, info.st_gid, getattr(info, "st_flags", 0))
    return (fields(a) == fields(b)
            and integrity["attributes"](source) == integrity["attributes"](target)
            and integrity["acl"](source) == integrity["acl"](target))


def copy_metadata(source, target):
    if not same_metadata(source, target):
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


def copy_tree(source, target, revisions, allow_sockets=False):
    source, target, revisions = map(os.path.abspath, (source, target, revisions))
    if source == target or target.startswith(source + "/") or source.startswith(target + "/"):
        raise ValueError("Overlapping copy roots")
    if os.path.realpath(source) != source or os.path.realpath(target) != target:
        raise ValueError("Copy roots must be physical")
    if revisions.startswith(target + "/") or revisions.startswith(source + "/"):
        raise ValueError("Revisions must be outside both roots")
    device = os.lstat(source).st_dev
    counts = {"files": 0, "copiedBytes": 0, "quickChecked": 0, "sockets": 0}
    hardlinks = {}
    last_progress = time.monotonic()
    progress_lock = Lock()
    workers = max(1, min(16, int(os.environ.get("AIOS_STORAGE_COPY_WORKERS", "8"))))
    pool = ThreadPoolExecutor(max_workers=workers)
    pending = deque()

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
        previous = os.lstat(dst) if os.path.lexists(dst) else None
        if stat.S_ISDIR(before.st_mode):
            if previous and not stat.S_ISDIR(previous.st_mode):
                retain(dst, rel)
            os.makedirs(dst, exist_ok=True)
            names = sorted(os.listdir(src))
            children = []
            for name in names:
                child = os.path.join(src, name)
                info = os.lstat(child)
                args = (child, os.path.join(dst, name), os.path.join(rel, name))
                # Only ordinary single-link files run in parallel. Directory ordering and
                # hardlink ownership remain on this thread; no concurrent target collision.
                if stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    future = pool.submit(walk, *args)
                    children.append(future); pending.append(future)
                    if len(pending) >= workers * 4:
                        pending.popleft().result()
                else:
                    walk(*args)
            for child in children:
                child.result()
            for extra in set(os.listdir(dst)) - set(names):
                retain(os.path.join(dst, extra), os.path.join(rel, extra))
            copy_metadata(src, dst)
        elif stat.S_ISSOCK(before.st_mode) and allow_sockets:
            counts["sockets"] += 1
            retain(dst, rel)
        elif stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode):
            identity = (before.st_dev, before.st_ino)
            first = hardlinks.get(identity) if before.st_nlink > 1 and stat.S_ISREG(before.st_mode) else None
            if first:
                first_info = os.lstat(first)
                if not previous or previous.st_ino != first_info.st_ino or previous.st_dev != first_info.st_dev:
                    retain(dst, rel)
                    os.link(first, dst)
            elif (previous and stat.S_ISREG(before.st_mode) and stat.S_ISREG(previous.st_mode)
                  and before.st_size == previous.st_size and int(before.st_mtime) == int(previous.st_mtime)):
                counts["quickChecked"] += 1
                copy_metadata(src, dst)
            elif (previous and stat.S_ISLNK(before.st_mode) and stat.S_ISLNK(previous.st_mode)
                  and os.readlink(src) == os.readlink(dst)):
                copy_metadata(src, dst)
            else:
                temporary = os.path.join(os.path.dirname(dst), ".aios-copy-" + str(uuid.uuid4()))
                native_copy(src, temporary)
                retain(dst, rel)
                os.rename(temporary, dst)
                if stat.S_ISREG(before.st_mode):
                    counts["copiedBytes"] += before.st_size
            if before.st_nlink > 1 and stat.S_ISREG(before.st_mode):
                hardlinks.setdefault(identity, dst)
            counts["files"] += 1
        else:
            raise ValueError("Unsupported persistent entry: " + rel)
        after = os.lstat(src)
        if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("Source changed while staging; retry after quiescing: " + rel)
        with progress_lock:
            if time.monotonic() - last_progress > 15:
                print(json.dumps({"progress": counts}), flush=True)
                last_progress = time.monotonic()

    try:
        walk(source, target, "")
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    return counts


if __name__ == "__main__":
    try:
        if sys.platform != "darwin":
            raise ValueError("Native storage copier requires macOS")
        print(json.dumps(copy_tree(sys.argv[1], sys.argv[2], sys.argv[3], "--ephemeral-sockets" in sys.argv[4:])))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
