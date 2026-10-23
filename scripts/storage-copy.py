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

libc = ctypes.CDLL(None, use_errno=True)
libc.copyfile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_uint32]
libc.copyfile.restype = ctypes.c_int
NOFOLLOW = (1 << 18) | (1 << 19)


def native_copy(source, target, metadata=False):
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
            for name in names:
                walk(os.path.join(src, name), os.path.join(dst, name), os.path.join(rel, name))
            for extra in set(os.listdir(dst)) - set(names):
                retain(os.path.join(dst, extra), os.path.join(rel, extra))
            native_copy(src, dst, metadata=True)
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
                native_copy(src, dst, metadata=True)
            elif (previous and stat.S_ISLNK(before.st_mode) and stat.S_ISLNK(previous.st_mode)
                  and os.readlink(src) == os.readlink(dst)):
                native_copy(src, dst, metadata=True)
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
        if time.monotonic() - last_progress > 15:
            print(json.dumps({"progress": counts}), flush=True)
            last_progress = time.monotonic()

    walk(source, target, "")
    return counts


if __name__ == "__main__":
    try:
        if sys.platform != "darwin":
            raise ValueError("Native storage copier requires macOS")
        print(json.dumps(copy_tree(sys.argv[1], sys.argv[2], sys.argv[3], "--ephemeral-sockets" in sys.argv[4:])))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
