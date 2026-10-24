#!/usr/bin/env python3
"""macOS-native, restartable staging copy. Originals are NEVER removed.

copyfile(3) preserves native metadata without openrsync's AppleDouble hardlink bug. Existing
staged files use size/mtime quick-check. Default cutover independently verifies integrity;
explicit operator transfer-only cutover instead retains the local original. Replaced/extra
staging entries are retained in a separate Spark revision tree.
"""
import ctypes
import json
import os
import stat
import sys
import time
import uuid
import fcntl
import hashlib
from concurrent.futures import ThreadPoolExecutor, Future, wait, FIRST_COMPLETED
from collections import deque
from itertools import groupby
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


def directory_listing(source):
    # Digest namespace metadata only, not file contents. Keep one small digest
    # per directory instead of retaining millions of child tuples in memory.
    entries = []
    with os.scandir(source) as iterator:
        for entry in iterator:
            kind = (stat.S_IFLNK if entry.is_symlink() else stat.S_IFDIR if entry.is_dir(follow_symlinks=False)
                    else stat.S_IFREG if entry.is_file(follow_symlinks=False)
                    else stat.S_IFMT(entry.stat(follow_symlinks=False).st_mode))
            entries.append((entry.name, entry.inode(), kind))
    entries.sort(key=lambda entry: entry[0])
    digest = hashlib.sha256()
    for name, inode, kind in entries:
        encoded = os.fsencode(name)
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
        digest.update(inode.to_bytes(8, "big"))
        digest.update(kind.to_bytes(4, "big"))
    return [entry[0] for entry in entries], digest.digest()


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


def copy_tree(source, target, revisions, allow_sockets=False, since=None, covered_since=None, retry_paths=None):
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
    if covered_since is not None and (since is None or covered_since < since or covered_since > time.time()):
        raise ValueError("Invalid completed-pass coverage watermark")
    if covered_since is not None:
        if (not isinstance(retry_paths, list) or not retry_paths
                or len(json.dumps(retry_paths).encode()) > 32 * 1024
                or any(not isinstance(path, str) or not path or "\0" in path or os.path.isabs(path)
                       or os.path.normpath(path) != path or path in (".", "..") or path.startswith("../") for path in retry_paths)):
            raise ValueError("Invalid source-relative retry paths")
    elif retry_paths is not None:
        raise ValueError("Retry paths require completed-pass coverage")
    retry_roots = set(retry_paths or [])
    retry_ancestors = {""}
    for relative in retry_roots:
        parent = os.path.dirname(relative)
        while parent:
            retry_ancestors.add(parent)
            parent = os.path.dirname(parent)
    counts = {"files": 0, "copiedBytes": 0, "quickChecked": 0, "unchangedSinceBaseline": 0,
              "settledDirectoryChurn": 0, "sockets": 0, "unstableSources": []}
    hardlinks = {}
    hardlink_lock = Lock()
    last_progress = time.monotonic()
    progress_lock = Lock()
    workers = max(1, min(16, int(os.environ.get("AIOS_STORAGE_COPY_WORKERS", "8"))))
    pool = ThreadPoolExecutor(max_workers=workers)
    pending = {}
    directories = []
    unstable_sources = set()

    class SourceChanged(Exception):
        pass

    def unstable(rel):
        with progress_lock:
            if rel not in unstable_sources:
                unstable_sources.add(rel)
                counts["unstableSources"].append(rel)

    def source_snapshot(src, rel, before=None):
        try:
            current = os.lstat(src)
        except (FileNotFoundError, NotADirectoryError):
            if not rel:
                raise  # Losing the selected source root is never harmless churn.
            raise SourceChanged(rel)
        if before is not None and (before.st_dev, before.st_ino, stat.S_IFMT(before.st_mode)) != (
                current.st_dev, current.st_ino, stat.S_IFMT(current.st_mode)):
            if not rel:
                raise ValueError("Source root identity changed")
            raise SourceChanged(rel)
        return current

    def retain(path, relative):
        if not os.path.lexists(path):
            return
        saved = os.path.join(revisions, relative or "root")
        os.makedirs(os.path.dirname(saved), exist_ok=True)
        if os.path.lexists(saved):
            saved += "." + str(uuid.uuid4())
        os.rename(path, saved)

    def walk(src, dst, rel, baseline_allowed=True):
        try:
            before = source_snapshot(src, rel)
            try:
                return stage_entry(src, dst, rel, before, baseline_allowed)
            except (FileNotFoundError, NotADirectoryError):
                # Native copy errors do not distinguish a vanished source from a
                # missing destination. Suppress only positively changed sources;
                # stable-source target failures must still abort the staging pass.
                source_snapshot(src, rel, before)
                raise
        except SourceChanged:
            unstable(rel); progress()

    def stage_entry(src, dst, rel, before, baseline_allowed):
        nonlocal last_progress
        if before.st_dev != device:
            raise ValueError("Nested filesystem: " + rel)
        in_retry_scope = any(rel == path or rel.startswith(path + "/") for path in retry_roots)
        # Legacy receipts do not prove the identity of each unstable directory.
        # Fully quick-check those scopes; only unaffected entries use newer
        # coverage. A missing/replaced target ancestor also disables skipping.
        metadata_since = since if in_retry_scope else (covered_since or since)
        effective_since = None if in_retry_scope or not baseline_allowed else metadata_since
        changed_since_coverage = (metadata_since is not None
                                  and max(before.st_mtime_ns, before.st_ctime_ns) >= int(metadata_since * 1000000000))
        force_entry = rel in retry_roots or rel in retry_ancestors
        unchanged = (baseline_allowed and not force_entry and effective_since is not None
                     and max(before.st_mtime_ns, before.st_ctime_ns) < int(effective_since * 1000000000))
        if unchanged and stat.S_ISDIR(before.st_mode) and rel:
            names, membership = directory_listing(src)
            return before, None, names, True, True, membership, False
        if unchanged and (stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode)):
            counts["files"] += 1; counts["unchangedSinceBaseline"] += 1
            stable(src, rel, before, source_snapshot(src, rel, before)); progress()
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
            names, membership = directory_listing(src)
            # The coordinator schedules children only after their parent exists.
            # Directory stat/mkdir operations must also overlap network latency;
            # doing them on the traversal thread serialized package-heavy trees.
            # A newly created/replaced staging directory has no prior coverage.
            # Renaming/replacing a SOURCE directory also leaves descendant times
            # old, even if that target path already exists. Without a per-directory
            # source identity manifest, a changed namespace cannot confer covered
            # ancestry. Descendants get a full quick-check, not unconditional copy.
            child_covered = baseline_allowed and previous is not None and not changed_since_coverage
            force_metadata = previous is None or not rel or changed_since_coverage
            return before, previous, names, False, child_covered, membership, force_metadata
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
                elif (effective_since is None and not changed_since_coverage and previous
                      and stat.S_ISREG(before.st_mode) and stat.S_ISREG(previous.st_mode)
                      and before.st_size == previous.st_size and int(before.st_mtime) == int(previous.st_mtime)):
                    counts["quickChecked"] += 1
                    copy_metadata(src, dst, source_info=before, target_info=previous)
                elif (effective_since is None and not changed_since_coverage and previous
                      and stat.S_ISLNK(before.st_mode) and stat.S_ISLNK(previous.st_mode)
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
                if isinstance(error, (FileNotFoundError, NotADirectoryError)):
                    try:
                        source_snapshot(src, rel, before)
                    except BaseException as changed:
                        error = changed
                if future and owner:
                    future.set_exception(error)
                raise error
            counts["files"] += 1
        else:
            raise ValueError("Unsupported persistent entry: " + rel)
        after = source_snapshot(src, rel, before)
        stable(src, rel, before, after)
        progress()

    def stable(src, rel, before, after, directory_membership=None, directory_target=None):
        if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            if directory_membership is not None and stat.S_ISDIR(before.st_mode):
                persistent = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_uid,
                                          info.st_gid, getattr(info, "st_flags", 0))
                version = lambda info: (persistent(info), info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                if persistent(before) == persistent(after):
                    _, membership = directory_listing(src)
                    final = source_snapshot(src, rel, before)
                    if membership == directory_membership and version(after) == version(final):
                        # A short-lived scratch file can change directory times
                        # and disappear again. Accept only an identical namespace
                        # and persistent directory metadata—not a filename rule.
                        # Directory xattrs/ACLs also change ctime. Reapply native
                        # metadata instead of treating matching mode/owner bits
                        # as proof those were unchanged. No writes through a
                        # replaced target alias, even on a source-only fast path.
                        if os.path.realpath(directory_target) != directory_target:
                            raise ValueError("Staging directory changed before metadata reconciliation: " + rel)
                        if not stat.S_ISDIR(os.lstat(directory_target).st_mode):
                            raise ValueError("Staging directory type changed before metadata reconciliation: " + rel)
                        copy_metadata(src, directory_target, force=True)
                        if version(final) == version(source_snapshot(src, rel, before)):
                            counts["settledDirectoryChurn"] += 1
                            return
            # Staging is not cutover. An active transcript must not prevent unrelated
            # later files from being copied. Record every changed path for a quiesced
            # reconciliation; independent stable verification still gates all removal.
            unstable(rel)

    def progress():
        nonlocal last_progress
        with progress_lock:
            if time.monotonic() - last_progress > 15:
                print(json.dumps({"progress": counts}), flush=True)
                last_progress = time.monotonic()

    def finish_directory(src, dst, rel, before, previous, unchanged=False, membership=None, force_metadata=False):
        try:
            try:
                return finalize_directory(src, dst, rel, before, previous, unchanged, membership, force_metadata)
            except (FileNotFoundError, NotADirectoryError):
                source_snapshot(src, rel, before)
                raise
        except SourceChanged:
            unstable(rel); progress()

    def finalize_directory(src, dst, rel, before, previous, unchanged, membership, force_metadata):
        current = source_snapshot(src, rel, before)
        if unchanged:
            stable(src, rel, before, current, membership, dst); progress()
            return
        if since is not None and os.path.realpath(dst) != dst:
            raise ValueError("Staging directory changed before reconciliation: " + rel)
        for extra in set(os.listdir(dst)) - set(os.listdir(src)):
            retain(os.path.join(dst, extra), os.path.join(rel, extra))
        copy_metadata(src, dst, force=force_metadata,
                      source_info=before, target_info=previous)
        stable(src, rel, before, source_snapshot(src, rel, before), membership, dst)
        progress()

    try:
        jobs = deque([(source, target, "", True)])
        while jobs or pending:
            while jobs and len(pending) < workers * 4:
                args = jobs.popleft()
                pending[pool.submit(walk, *args)] = args
            ready, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in ready:
                src, dst, rel, _ = pending.pop(future)
                result = future.result()
                if result is not None:
                    before, previous, names, unchanged, child_baseline_allowed, membership, force_metadata = result
                    directories.append((src, dst, rel, before, previous, unchanged, membership, force_metadata))
                    for name in reversed(names):
                        jobs.appendleft((os.path.join(src, name), os.path.join(dst, name), os.path.join(rel, name), child_baseline_allowed))
        # A parent may retain a staged child whose active source was removed or
        # renamed. Finish every descendant FIRST so no finalizer can still be
        # using that child when the parent moves it into revisions. Sibling
        # directories remain parallel; each depth is a strict completion barrier.
        depth = lambda entry: entry[2].count(os.sep) + bool(entry[2])
        directories.sort(key=depth, reverse=True)
        for _, level in groupby(directories, key=depth):
            finalized = deque()
            for directory in level:
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
        covered_since = next((float(a.split("=", 1)[1]) for a in sys.argv[4:] if a.startswith("--covered-since=")), None)
        retry_paths = next((json.loads(a.split("=", 1)[1]) for a in sys.argv[4:] if a.startswith("--retry-paths=")), None)
        print(json.dumps(copy_tree(sys.argv[1], sys.argv[2], sys.argv[3], "--ephemeral-sockets" in sys.argv[4:],
                                   since, covered_since, retry_paths)))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
