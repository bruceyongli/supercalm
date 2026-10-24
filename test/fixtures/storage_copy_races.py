"""Deterministic producer/destination races in disposable local fixtures only."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
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


def set_test_xattr(path, value):
    subprocess.run(["/usr/bin/xattr", "-w", "com.aios.copy-race", value, str(path)],
                   check=True, capture_output=True)


def get_test_xattr(path):
    return subprocess.check_output(["/usr/bin/xattr", "-p", "com.aios.copy-race", str(path)]).rstrip(b"\n")


def run(source, target, revisions, since=None, covered_since=None, retry_paths=None):
    return copier.copy_tree(str(source), str(target), str(revisions), since=since,
                            covered_since=covered_since, retry_paths=retry_paths)


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
    original_listing, moved = copier.directory_listing, False

    def disappearing_listing(path):
        global moved
        result = original_listing(path)
        if str(path) == str(source) and not moved:
            moved = True
            os.rename(source / "vanished", root / "producer-retained")
        return result

    with patch(copier, "directory_listing", disappearing_listing):
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
    original_listing, moved = copier.directory_listing, False

    def move_unchanged_directory(path):
        global moved
        result = original_listing(path)
        if str(path) == str(source / "branch") and not moved:
            moved = True
            os.rename(source / "branch", source / "renamed")
        return result

    with patch(copier, "directory_listing", move_unchanged_directory):
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

    for change in ["transient", "add", "delete", "replace", "type", "mode", "inode"]:
        root, source, target, revisions = roots(base, "directory-membership-" + change)
        put(source / "branch/keep.txt")
        original_metadata, changed = copier.copy_metadata, False

        def change_directory(src, dst, *args, **kwargs):
            global changed
            original_metadata(src, dst, *args, **kwargs)
            if str(src) != str(source / "branch") or changed:
                return
            changed = True
            if change == "transient":
                put(source / "branch/short-lived-scratch")
                os.unlink(source / "branch/short-lived-scratch")
            elif change == "add":
                put(source / "branch/new.txt")
            elif change == "delete":
                os.rename(source / "branch/keep.txt", root / "retained-file")
            elif change == "replace":
                os.rename(source / "branch/keep.txt", root / "retained-file")
                put(source / "branch/keep.txt", "replacement bytes")
            elif change == "type":
                os.rename(source / "branch/keep.txt", root / "retained-file")
                (source / "branch/keep.txt").mkdir()
            elif change == "mode":
                os.chmod(source / "branch", 0o700)
            elif change == "inode":
                os.rename(source / "branch", root / "retained-directory")
                put(source / "branch/keep.txt")

        with patch(copier, "copy_metadata", change_directory):
            result = run(source, target, revisions)
        if change == "transient":
            assert not result["unstableSources"], result
            assert result["settledDirectoryChurn"] == 1
        else:
            assert "branch" in result["unstableSources"], (change, result)
        cases.append("directory membership " + change + " is " + ("settled" if change == "transient" else "unstable"))

    root, source, target, revisions = roots(base, "new-parent-old-children")
    put(root / "outside/old/nested/report.txt")
    run(source, target, revisions)
    time.sleep(0.02)
    baseline = time.time()
    os.rename(root / "outside", source / "imported")
    result = run(source, target, revisions, since=baseline)
    assert not result["unstableSources"]
    assert (target / "imported/old/nested/report.txt").read_text() == "original bytes"
    cases.append("new target ancestry forces old renamed descendants to copy")

    root, source, target, revisions = roots(base, "replaced-target-parent")
    put(source / "branch/old/nested/report.txt")
    run(source, target, revisions)
    time.sleep(0.02)
    baseline = time.time()
    os.rename(target / "branch", root / "retained-stage")
    put(target / "branch", "obsolete staging type")
    os.utime(source / "branch", None)
    result = run(source, target, revisions, since=baseline)
    assert not result["unstableSources"]
    assert (target / "branch/old/nested/report.txt").read_text() == "original bytes"
    assert (revisions / "branch").read_text() == "obsolete staging type"
    cases.append("replaced target ancestry forces old descendants to copy and retains revision")

    root, source, target, revisions = roots(base, "replaced-source-existing-target")
    put(source / "branch/old/stale.txt", "prior branch")
    put(root / "replacement/old/report.txt", "old timestamps, different source directory")
    run(source, target, revisions)
    time.sleep(0.02)
    baseline = time.time()
    os.rename(source / "branch", root / "retained-source")
    os.rename(root / "replacement", source / "branch")
    result = run(source, target, revisions, since=baseline)
    assert not result["unstableSources"]
    assert (target / "branch/old/report.txt").read_text() == "old timestamps, different source directory"
    assert not (target / "branch/old/stale.txt").exists()
    assert (revisions / "branch/old/stale.txt").read_text() == "prior branch"
    assert (root / "retained-source/old/stale.txt").read_text() == "prior branch"
    cases.append("changed source ancestry cannot cover old descendants in an already existing target")

    root, source, target, revisions = roots(base, "unchanged-retry-directory-metadata")
    put(source / "retry/old/nested/report.txt")
    run(source, target, revisions)
    time.sleep(0.02)
    baseline = time.time()
    time.sleep(0.02)
    coverage = time.time()
    original_native = copier.native_copy

    def no_old_metadata_writes(src, dst, metadata=False):
        assert not (metadata and str(src).startswith(str(source / "retry"))), "old retry directory metadata was rewritten"
        return original_native(src, dst, metadata)

    with patch(copier, "native_copy", no_old_metadata_writes):
        result = run(source, target, revisions, since=baseline, covered_since=coverage, retry_paths=["retry"])
    assert not result["unstableSources"]
    assert result["quickChecked"] == 1
    assert result["copiedBytes"] == 0
    cases.append("strict retry subtrees quick-check old entries without rewriting every directory")

    root, source, target, revisions = roots(base, "completed-pass-coverage")
    put(source / "retry/old.txt")
    run(source, target, revisions)
    time.sleep(0.02)
    baseline = time.time()
    put(source / "covered/report.txt", "already transferred delta")
    run(source, target, revisions, since=baseline)
    time.sleep(0.02)
    coverage = time.time()
    # The old file's timestamps predate BOTH watermarks. The retry scope must
    # still discover its missing target; unaffected entries avoid remote stats.
    os.rename(target / "retry/old.txt", root / "retained-stage-file")
    original_lstat = os.lstat

    def no_covered_remote_stat(path, *args, **kwargs):
        assert str(path) != str(target / "covered/report.txt"), "completed unaffected entry was remotely restatted"
        return original_lstat(path, *args, **kwargs)

    with patch(os, "lstat", no_covered_remote_stat):
        result = run(source, target, revisions, since=baseline, covered_since=coverage, retry_paths=["retry"])
    assert not result["unstableSources"]
    assert result["unchangedSinceBaseline"] == 1
    assert (target / "retry/old.txt").read_text() == "original bytes"
    assert (target / "covered/report.txt").read_text() == "already transferred delta"
    cases.append("completed-pass start coverage skips remote rechecks only outside strict retry subtrees")

    root, source, target, revisions = roots(base, "coverage-new-parent")
    put(root / "outside/old/report.txt")
    put(source / "retry/keep.txt")
    run(source, target, revisions)
    time.sleep(0.02)
    baseline = time.time()
    time.sleep(0.02)
    coverage = time.time()
    os.rename(root / "outside", source / "imported")
    result = run(source, target, revisions, since=baseline, covered_since=coverage, retry_paths=["retry"])
    assert not result["unstableSources"]
    assert (target / "imported/old/report.txt").read_text() == "original bytes"
    cases.append("completed-pass coverage cannot skip old descendants under new ancestry")

    root, source, target, revisions = roots(base, "settled-directory-xattr")
    put(source / "branch/report.txt")
    original_metadata, changed = copier.copy_metadata, False

    def changed_directory_xattr(src, dst, *args, **kwargs):
        global changed
        original_metadata(src, dst, *args, **kwargs)
        if str(src) == str(source / "branch") and not changed:
            changed = True
            set_test_xattr(src, "updated directory metadata")

    with patch(copier, "copy_metadata", changed_directory_xattr):
        result = run(source, target, revisions)
    assert not result["unstableSources"]
    assert result["settledDirectoryChurn"] == 1
    assert get_test_xattr(target / "branch") == b"updated directory metadata"
    cases.append("settled directory metadata changes are natively recopied including xattrs")

    root, source, target, revisions = roots(base, "unchanged-directory-target-swap")
    put(source / "branch/report.txt")
    run(source, target, revisions)
    (root / "outside-target").mkdir()
    set_test_xattr(root / "outside-target", "untouched outside")
    time.sleep(0.02)
    baseline = time.time()
    original_listing, changed = copier.directory_listing, False

    def swap_unchanged_target(path):
        global changed
        result = original_listing(path)
        if str(path) == str(source / "branch") and not changed:
            changed = True
            put(source / "branch/short-lived-scratch")
            os.unlink(source / "branch/short-lived-scratch")
            os.rename(target / "branch", root / "retained-target")
            os.symlink(root / "outside-target", target / "branch")
        return result

    with patch(copier, "directory_listing", swap_unchanged_target):
        try:
            run(source, target, revisions, since=baseline)
            raise AssertionError("unchanged directory metadata must not follow a replaced target alias")
        except ValueError as error:
            assert "Staging directory changed" in str(error)
    assert get_test_xattr(root / "outside-target") == b"untouched outside"
    assert (root / "retained-target/report.txt").read_text() == "original bytes"
    cases.append("settled metadata reconciliation rechecks physical target even for unchanged directories")

    for bad in [[], [""], ["."], ["../escape"], ["/absolute"], ["a/../b"], ["a/"], ["a\0b"]]:
        try:
            run(source, target, revisions, since=baseline, covered_since=coverage, retry_paths=bad)
            raise AssertionError("invalid retry path accepted: " + repr(bad))
        except ValueError:
            pass
    cases.append("coverage rejects unsafe or unbounded retry scopes")

print(json.dumps({"cases": cases, "unstableResult": unstable_result}))
