#!/usr/bin/env python3
"""Read-only migration evidence. Hash contents, names, modes, ownership, links, ACLs and xattrs.

Uses native macOS metadata, not rsync's quick-check. Never follows symbolic links. A second
metadata-only pass detects source writes during verification; unsupported entries fail closed.
Sockets may be inventoried explicitly as ephemeral IPC, never silently treated as copied files.
"""
import ctypes
import errno
import hashlib
import json
import os
import stat
import sys
import fcntl
from concurrent.futures import ThreadPoolExecutor
from collections import deque


def encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode() + b"\n"


libc = ctypes.CDLL(None, use_errno=True)
if sys.platform == "darwin":
    libc.acl_get_link_np.argtypes = [ctypes.c_char_p, ctypes.c_int]
    libc.acl_get_link_np.restype = ctypes.c_void_p
    libc.acl_to_text.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ssize_t)]
    libc.acl_to_text.restype = ctypes.c_void_p
    libc.acl_free.argtypes = [ctypes.c_void_p]
    libc.listxattr.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
    libc.listxattr.restype = ctypes.c_ssize_t
    libc.getxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p,
                             ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
    libc.getxattr.restype = ctypes.c_ssize_t


def attributes(path):
    if sys.platform != "darwin":
        return [[name, hashlib.sha256(os.getxattr(path, name, follow_symlinks=False)).hexdigest()]
                for name in sorted(os.listxattr(path, follow_symlinks=False))]
    raw = os.fsencode(path)
    size = libc.listxattr(raw, None, 0, 1)  # XATTR_NOFOLLOW
    if size < 0:
        raise OSError(ctypes.get_errno(), "Cannot list xattrs", path)
    if size == 0:
        return []
    names = ctypes.create_string_buffer(size)
    actual = libc.listxattr(raw, names, size, 1)
    if actual < 0:
        raise OSError(ctypes.get_errno(), "Cannot read xattr list", path)
    result = []
    for name in sorted(names.raw[:actual].split(b"\0")):
        if not name:
            continue
        length = libc.getxattr(raw, name, None, 0, 0, 1)
        if length < 0:
            raise OSError(ctypes.get_errno(), "Cannot size xattr", path)
        value = ctypes.create_string_buffer(length)
        count = libc.getxattr(raw, name, value, length, 0, 1)
        if count != length:
            raise OSError(ctypes.get_errno(), "Cannot read stable xattr", path)
        result.append([os.fsdecode(name), hashlib.sha256(value.raw[:count]).hexdigest()])
    return result


def acl(path):
    if sys.platform != "darwin":
        return ""  # Linux ACLs are covered by system.posix_acl_* xattrs.
    ctypes.set_errno(0)
    result = libc.acl_get_link_np(os.fsencode(path), 0x100)
    if not result:
        code = ctypes.get_errno()
        # Darwin reports ENOENT for "no extended ACL" too. Check the inode itself;
        # the surrounding before/after stat still detects an actual disappearance.
        if code == errno.ENOENT:
            # Every caller has a before-stat and checks the same path again afterwards.
            # That detects disappearance without another network stat for the usual no-ACL case.
            return ""
        if code in (errno.ENOENT, errno.ENOTSUP):
            raise OSError(code, "Cannot inspect ACL", path)
        if code == 0:
            return ""
        raise OSError(code, "Cannot inspect ACL", path)
    text = None
    try:
        length = ctypes.c_ssize_t()
        text = libc.acl_to_text(result, ctypes.byref(length))
        if not text:
            raise OSError(ctypes.get_errno(), "Cannot serialize ACL", path)
        return ctypes.string_at(text, length.value).decode("utf8")
    finally:
        if text:
            libc.acl_free(text)
        libc.acl_free(result)


def signature(info, is_root=False):
    # Renaming the root changes its ctime, but none of its members. That is the only
    # expected metadata change between verification and quarantined-copy removal.
    return [info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size if not stat.S_ISDIR(info.st_mode) else 0,
            info.st_mtime_ns, 0 if is_root else info.st_ctime_ns,
            getattr(info, "st_flags", 0), info.st_nlink]


def manifest(root, contents=True, sockets=False, records=False, equivalent_groups=None):
    root = os.path.abspath(root)
    first = os.lstat(root)
    if not stat.S_ISDIR(first.st_mode) or os.path.realpath(root) != root:
        raise ValueError("Verification root must be a physical directory")
    digest, fingerprint = hashlib.sha256(), hashlib.sha256()
    groups = {}
    counts = {"files": 0, "directories": 0, "links": 0, "bytes": 0}
    ipc = []
    group_changes = []
    workers = max(1, min(16, int(os.environ.get("AIOS_STORAGE_VERIFY_WORKERS", "8"))))
    pool = ThreadPoolExecutor(max_workers=workers)

    def record(path, relative):
        before = os.lstat(path)
        if before.st_dev != first.st_dev:
            raise ValueError("Nested filesystem: " + relative)
        mode = before.st_mode
        if stat.S_ISSOCK(mode) and sockets:
            return before, None, None
        attrs = attributes(path) if contents or not relative else []
        meta = [relative, stat.S_IMODE(mode), before.st_uid, before.st_gid,
                getattr(before, "st_flags", 0), attrs, acl(path) if contents or not relative else ""]
        normalized = (equivalent_groups or {}).get(before.st_gid)
        if contents and normalized is not None and normalized != before.st_gid:
            # An ordinary owner's copy may not assign a group the owner does not belong
            # to. Only an explicit mapping with IDENTICAL group/other access is allowed.
            # ACLs and set-id semantics never qualify; preserve their originals instead.
            if meta[6] or mode & (stat.S_ISGID | stat.S_ISUID) or ((mode >> 3) & 7) != (mode & 7):
                raise ValueError("Group change would alter access: " + relative)
            meta[3] = normalized
        if stat.S_ISREG(mode):
            content = hashlib.sha256()
            if contents:
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(descriptor, "rb", buffering=0) as stream:
                    if sys.platform == "darwin" and before.st_size >= 4 * 1024 * 1024:
                        fcntl.fcntl(stream.fileno(), 48, 1)
                    if signature(os.fstat(stream.fileno())) != signature(before):
                        raise ValueError("File changed before read: " + relative)
                    while True:
                        chunk = stream.read(1024 * 1024)
                        if not chunk:
                            break
                        content.update(chunk)
            result = ["file", meta, before.st_size, content.hexdigest() if contents else ""]
        elif stat.S_ISLNK(mode):
            result = ["link", meta, os.readlink(path)]
        elif stat.S_ISDIR(mode):
            result = ["directory", meta]
        else:
            raise ValueError("Unsupported persistent entry: " + relative)
        if signature(before, not relative) != signature(os.lstat(path), not relative):
            raise ValueError("Tree changed during verification: " + relative)
        return before, meta, encoded(result)

    # Pipeline metadata for directories and links as well as files. Flushing at every
    # directory used to serialize thousands of remote ACL/xattr/stat round-trips.
    # Folding remains deterministic preorder, byte-identical to the original manifest.
    pending = deque()
    def drain():
        relative, future = pending.popleft()
        before, meta, result = future.result()
        fingerprint.update(encoded([relative, signature(before, not relative)]))
        if not relative:
            original_meta = list(meta)
            original_meta[3] = before.st_gid
            fingerprint.update(encoded(["root-native-metadata", original_meta]))
        if stat.S_ISSOCK(before.st_mode):
            ipc.append(relative)
            return
        if meta and before.st_gid != meta[3]:
            group_changes.append({"path": relative, "originalGid": before.st_gid, "storedGid": meta[3]})
        if stat.S_ISREG(before.st_mode):
            counts["files"] += 1; counts["bytes"] += before.st_size
            if before.st_nlink > 1:
                groups.setdefault((before.st_dev, before.st_ino), []).append(relative)
        elif stat.S_ISDIR(before.st_mode):
            counts["directories"] += 1
        else:
            counts["links"] += 1
        digest.update(result)
        if records:
            print(json.dumps({"path": relative, "digest": hashlib.sha256(result).hexdigest(),
                              "metadata": meta, "size": before.st_size if stat.S_ISREG(before.st_mode) else None}), flush=True)

    def walk(path, relative, directory=True):
        pending.append((relative, pool.submit(record, path, relative)))
        if len(pending) >= workers * 8:
            drain()
        if directory:
            before = os.lstat(path)
            if not stat.S_ISDIR(before.st_mode) or before.st_dev != first.st_dev:
                raise ValueError("Directory changed or nested filesystem: " + relative)
            with os.scandir(path) as entries:
                children = sorted(entries, key=lambda entry: entry.name)
            for entry in children:
                walk(entry.path, os.path.join(relative, entry.name), entry.is_dir(follow_symlinks=False))
            if signature(before, not relative) != signature(os.lstat(path), not relative):
                raise ValueError("Directory changed while listing: " + relative)

    try:
        walk(root, "")
        while pending:
            drain()
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    # Preserve every hard-link relationship within this root; an external link's inode
    # number cannot be reproduced on a second filesystem.
    digest.update(encoded(["hardlinks", sorted(paths for paths in groups.values() if len(paths) > 1)]))
    return {"algorithm": "sha256", "digest": digest.hexdigest(), "fingerprint": fingerprint.hexdigest(),
            **counts, "ephemeralSockets": ipc,
            "equivalentGroupChanges": group_changes,
            "scope": "contents,names,modes,ownership,file-flags,hardlinks,symlink-targets,ACLs,xattrs"}


if __name__ == "__main__":
    try:
        groups = {}
        for option in sys.argv[2:]:
            if option.startswith("--equivalent-group="):
                a, b = map(int, option.split("=", 1)[1].split(":"))
                groups[a] = b
        print(json.dumps(manifest(sys.argv[1], "--metadata-only" not in sys.argv[2:],
                                  "--ephemeral-sockets" in sys.argv[2:], "--records" in sys.argv[2:], groups)))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
