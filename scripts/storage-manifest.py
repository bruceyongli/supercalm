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
        if code == errno.ENOENT and os.path.lexists(path):
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


def manifest(root, contents=True, sockets=False):
    root = os.path.abspath(root)
    first = os.lstat(root)
    if not stat.S_ISDIR(first.st_mode) or os.path.realpath(root) != root:
        raise ValueError("Verification root must be a physical directory")
    digest, fingerprint = hashlib.sha256(), hashlib.sha256()
    groups = {}
    counts = {"files": 0, "directories": 0, "links": 0, "bytes": 0}
    ipc = []

    def walk(path, relative):
        before = os.lstat(path)
        if before.st_dev != first.st_dev:
            raise ValueError("Nested filesystem: " + relative)
        fingerprint.update(encoded([relative, signature(before, not relative)]))
        mode = before.st_mode
        if stat.S_ISSOCK(mode) and sockets:
            ipc.append(relative)
            return
        attrs = attributes(path)
        meta = [relative, stat.S_IMODE(mode), before.st_uid, before.st_gid,
                getattr(before, "st_flags", 0), attrs, acl(path)]
        if stat.S_ISLNK(mode):
            counts["links"] += 1
            digest.update(encoded(["link", meta, os.readlink(path)]))
        elif stat.S_ISDIR(mode):
            counts["directories"] += 1
            digest.update(encoded(["directory", meta]))
            for name in sorted(os.listdir(path)):
                walk(os.path.join(path, name), os.path.join(relative, name))
        elif stat.S_ISREG(mode):
            counts["files"] += 1
            counts["bytes"] += before.st_size
            content = hashlib.sha256()
            if contents:
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(descriptor, "rb", buffering=0) as stream:
                    if signature(os.fstat(stream.fileno())) != signature(before):
                        raise ValueError("File changed before read: " + relative)
                    while True:
                        chunk = stream.read(1024 * 1024)
                        if not chunk:
                            break
                        content.update(chunk)
            if before.st_nlink > 1:
                identity = (before.st_dev, before.st_ino)
                groups.setdefault(identity, []).append(relative)
            digest.update(encoded(["file", meta, before.st_size, content.hexdigest() if contents else ""]))
        else:
            raise ValueError("Unsupported persistent entry: " + relative)
        if signature(before, not relative) != signature(os.lstat(path), not relative):
            raise ValueError("Tree changed during verification: " + relative)

    walk(root, "")
    # Preserve every hard-link relationship within this root; an external link's inode
    # number cannot be reproduced on a second filesystem.
    digest.update(encoded(["hardlinks", sorted(paths for paths in groups.values() if len(paths) > 1)]))
    return {"algorithm": "sha256", "digest": digest.hexdigest(), "fingerprint": fingerprint.hexdigest(),
            **counts, "ephemeralSockets": ipc,
            "scope": "contents,names,modes,ownership,file-flags,hardlinks,symlink-targets,ACLs,xattrs"}


if __name__ == "__main__":
    try:
        print(json.dumps(manifest(sys.argv[1], "--metadata-only" not in sys.argv[2:],
                                  "--ephemeral-sockets" in sys.argv[2:])))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
