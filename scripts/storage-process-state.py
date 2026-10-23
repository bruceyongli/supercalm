#!/usr/bin/env python3
"""macOS process argv/environment for an operator-owned maintenance checkpoint.

Output contains private environment values. The caller must keep it in a local 0600
journal, never print it to a terminal, application event stream, or public artifact.
"""
import ctypes
import json
import os
import struct
import sys

def snapshot(pid):
    if sys.platform != "darwin" or pid <= 1:
        raise ValueError("Expected a macOS user process")
    libc = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    size = ctypes.c_size_t()
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0):
        raise OSError(ctypes.get_errno(), "Cannot size process checkpoint")
    if size.value > 4 * 1024 * 1024:
        raise ValueError("Process checkpoint is unexpectedly large")
    buffer = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0):
        raise OSError(ctypes.get_errno(), "Cannot read process checkpoint")
    data = buffer.raw[:size.value]
    argc = struct.unpack_from("i", data)[0]
    end = data.index(b"\0", 4)
    executable = os.fsdecode(data[4:end])
    pos = end
    while pos < len(data) and data[pos] == 0:
        pos += 1
    argv = []
    for _ in range(argc):
        end = data.index(b"\0", pos)
        argv.append(os.fsdecode(data[pos:end])); pos = end + 1
    environment = {}
    while pos < len(data) and data[pos]:
        end = data.index(b"\0", pos)
        name, separator, value = os.fsdecode(data[pos:end]).partition("=")
        if separator:
            environment[name] = value
        pos = end + 1
    if not executable.startswith("/") or not argv:
        raise ValueError("Incomplete process checkpoint")
    return {"executable": executable, "argv": argv, "env": environment}

if __name__ == "__main__":
    try:
        print(json.dumps(snapshot(int(sys.argv[1]))))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
