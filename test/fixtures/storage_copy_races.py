"""Deterministic producer/destination races in disposable local fixtures only."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from contextlib import contextmanager
from threading import Barrier, Event, Lock
import time

spec = importlib.util.spec_from_file_location("storage_copy", sys.argv[1])
copier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(copier)
cases = []
unstable_result = None


@contextmanager
def patch(owner, name, replacement):
    original = getattr(owner, name)
    setattr(owner, name, replacement)
    try:
        yield
    finally:
        setattr(owner, name, original)


def roots(base, name):
    root = base / name
    source, target, revisions = root / "source", root / "target", root / "revisions"
    source.mkdir(parents=True)
    target.mkdir()
    return root, source, target, revisions


def put(path, text="original bytes"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def run(source, target, revisions, since=None):
    return copier.copy_tree(str(source), str(target), str(revisions), since=since)


with tempfile.TemporaryDirectory(prefix="aios-storage-copy-races-") as temporary:
    base = Path(temporary).resolve()

    root, source, target, revisions = roots(base, "postorder")
    for branch in ["a/b/c", "x/y/z"]:
        put(source / branch / "report.txt")
    expected = {".", "a", "a/b", "a/b/c", "x", "x/y", "x/y/z"}
    finished, lock, siblings = set(), Lock(), Barrier(2)
    original_metadata = copier.copy_metadata

    def ordered_metadata(src, dst, *args, **kwargs):
        if stat.S_ISDIR(os.lstat(src).st_mode):
            relative = os.path.relpath(src, source)
            with lock:
                children = expected - {"."} if relative == "." else {p for p in expected if p.startswith(relative + "/")}
                assert children <= finished, "parent finalized before its descendants: " + relative
            if relative in {"a/b/c", "x/y/z"}:
                siblings.wait(timeout=5)  # Preserve useful sibling concurrency.
            original_metadata(src, dst, *args, **kwargs)
            with lock:
                finished.add(relative)
        else:
            original_metadata(src, dst, *args, **kwargs)

    with patch(copier, "copy_metadata", ordered_metadata):
        assert not run(source, target, revisions)["unstableSources"]
    assert finished == expected
    cases.append("children finish before parents; siblings remain parallel")

    root, source, target, revisions = roots(base, "removed-before-walk")
    put(source / "vanished/nested/report.txt")
    put(source / "keep.txt", "unrelated copied")
    put(target / "vanished/nested/report.txt", "older staged bytes")
    original_listdir, moved = os.listdir, False

    def disappearing_listing(path):
        global moved
        names = original_listdir(path)
        if str(path) == str(source) and not moved:
            moved = True
            os.rename(source / "vanished", root / "producer-retained")
        return names

    with patch(os, "listdir", disappearing_listing):
        result = run(source, target, revisions)
    assert "vanished" in result["unstableSources"]
    assert (target / "keep.txt").read_text() == "unrelated copied"
    assert (revisions / "vanished/nested/report.txt").read_text() == "older staged bytes"
    assert (root / "producer-retained/nested/report.txt").read_text() == "original bytes"
    cases.append("source removed after listing is unstable; originals and staged revision retained")

    for replacement in ["rename", "directory", "file"]:
        root, source, target, revisions = roots(base, "during-finalization-" + replacement)
        put(source / "branch/child/report.txt")
        original_listdir, moved = os.listdir, False

        def replace_during_finalization(path):
            global moved
            if str(path) == str(target / "branch/child") and not moved:
                moved = True
                held = source / "renamed" if replacement == "rename" else root / "producer-retained"
                os.rename(source / "branch", held)
                if replacement == "directory":
                    put(source / "branch/new.txt", "new directory identity")
                elif replacement == "file":
                    put(source / "branch", "new file identity")
            return original_listdir(path)

        with patch(os, "listdir", replace_during_finalization):
            result = run(source, target, revisions)
        assert any(path.startswith("branch") for path in result["unstableSources"])
        unstable_result = result
        held = source / "renamed" if replacement == "rename" else root / "producer-retained"
        assert (held / "child/report.txt").read_text() == "original bytes"
        if replacement == "rename":
            assert (revisions / "branch/child/report.txt").read_text() == "original bytes"
        else:
            assert (target / "branch/child/report.txt").read_text() == "original bytes"
        assert not run(source, target, revisions)["unstableSources"], "a later stable pass must recover normally"
        if replacement == "rename":
            assert (target / "renamed/child/report.txt").read_text() == "original bytes"
        elif replacement == "directory":
            assert (target / "branch/new.txt").read_text() == "new directory identity"
        else:
            assert (target / "branch").read_text() == "new file identity"
        assert (revisions / "branch/child/report.txt").read_text() == "original bytes"
        cases.append("active source " + replacement + " during finalization retained and reconciled")

    root, source, target, revisions = roots(base, "stable-source-missing-target")
    put(source / "branch/child/report.txt")
    original_listdir, moved = os.listdir, False

    def lost_destination(path):
        global moved
        if str(path) == str(target / "branch/child") and not moved:
            moved = True
            os.rename(target / "branch/child", root / "retained-target")
        return original_listdir(path)

    with patch(os, "listdir", lost_destination):
        try:
            run(source, target, revisions)
            raise AssertionError("missing target for a stable source must fail")
        except FileNotFoundError:
            pass
    assert (source / "branch/child/report.txt").read_text() == "original bytes"
    assert (root / "retained-target/report.txt").read_text() == "original bytes"
    cases.append("missing destination with unchanged source remains fatal")

    root, source, target, revisions = roots(base, "native-copy-target-error")
    put(source / "report.txt")

    def failed_native(src, dst, metadata=False):
        raise FileNotFoundError(errno.ENOENT, "injected missing target", dst)

    with patch(copier, "native_copy", failed_native):
        try:
            run(source, target, revisions)
            raise AssertionError("ambiguous native target error must not be called source churn")
        except FileNotFoundError:
            pass
    assert (source / "report.txt").read_text() == "original bytes"
    cases.append("native target errors are not suppressed")

    root, source, target, revisions = roots(base, "source-root-disappears")
    put(source / "report.txt")
    original_listdir, moved = os.listdir, False

    def lost_root(path):
        global moved
        if str(path) == str(target) and not moved:
            moved = True
            os.rename(source, root / "retained-source")
        return original_listdir(path)

    with patch(os, "listdir", lost_root):
        try:
            run(source, target, revisions)
            raise AssertionError("source root disappearance must fail")
        except FileNotFoundError:
            pass
    assert (root / "retained-source/report.txt").read_text() == "original bytes"
    cases.append("selected source-root disappearance remains fatal")

    root, source, target, revisions = roots(base, "unchanged-baseline-directory")
    put(source / "branch/report.txt")
    run(source, target, revisions)
    time.sleep(0.02)
    baseline = time.time()
    original_listdir, moved = os.listdir, False

    def move_unchanged_directory(path):
        global moved
        names = original_listdir(path)
        if str(path) == str(source / "branch") and not moved:
            moved = True
            os.rename(source / "branch", source / "renamed")
        return names

    with patch(os, "listdir", move_unchanged_directory):
        result = run(source, target, revisions, since=baseline)
    assert "branch" in result["unstableSources"]
    assert (source / "renamed/report.txt").read_text() == "original bytes"
    assert (revisions / "branch/report.txt").read_text() == "original bytes"
    cases.append("unchanged-baseline directory rename remains an unstable pass")

    root, source, target, revisions = roots(base, "hardlink-owner-disappears")
    put(source / "a")
    os.link(source / "a", source / "b")
    original_lstat, original_native, follower_seen, owner_started = os.lstat, copier.native_copy, Event(), Event()

    def observe_follower(path, *args, **kwargs):
        if str(path) == str(source / "b"):
            assert owner_started.wait(timeout=5)
        info = original_lstat(path, *args, **kwargs)
        if str(path) == str(source / "b"):
            follower_seen.set()
        return info

    def missing_hardlink_owner(src, dst, metadata=False):
        if str(src) == str(source / "a") and not metadata:
            owner_started.set()
            assert follower_seen.wait(timeout=5)
            os.rename(source / "a", root / "retained-hardlink")
            raise FileNotFoundError(errno.ENOENT, "producer renamed source", src)
        original_native(src, dst, metadata)

    with patch(os, "lstat", observe_follower), patch(copier, "native_copy", missing_hardlink_owner):
        result = run(source, target, revisions)
    assert "a" in result["unstableSources"]
    assert (source / "b").read_text() == (root / "retained-hardlink").read_text() == "original bytes"
    assert not run(source, target, revisions)["unstableSources"]
    assert (target / "b").read_text() == "original bytes"
    cases.append("hardlink-owner churn cannot deadlock followers or authorize cutover")

print(json.dumps({"cases": cases, "unstableResult": unstable_result}))
