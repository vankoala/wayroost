"""Atomic helper publications leave existing files alone until replacement."""

import contextlib
import importlib.util
import io
import json
import os
import stat
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

import signalbox_mail_trigger as mail
import signalbox_skills as skills
from wayroost_runtime import BackgroundGate

with patch.dict(os.environ, {"HERMES_HOME": "/home/me/.hermes", "WAYROOST_ROLE": "primary"}, clear=True):
    spec = importlib.util.spec_from_file_location("publication_helper", Path(__file__).with_name("signalbox-helper.py"))
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)


@pytest.fixture(params=["runtime", "gate", "trigger", "routing", "skills", "mail"])
def publication(request, tmp_path, monkeypatch):
    monkeypatch.setenv("WAYROOST_ROLE", "primary")
    monkeypatch.delenv("WAYROOST_CONFIG", raising=False)
    monkeypatch.delenv("SIGNALBOX_CONFIG", raising=False)
    monkeypatch.setattr(helper, "log", Mock())
    kind = request.param
    if kind in {"runtime", "gate"}:
        source = tmp_path / "source"
        source.mkdir()
        gate = source / "gate.py"
        gate.write_bytes(b"# example gate\n")
        runtime = source / "wayroost_runtime.py"
        runtime.write_bytes(b"# example runtime\n")
        scripts = tmp_path / "scripts"
        scripts.mkdir()
        monkeypatch.setattr(helper, "HERMES_HOME", tmp_path)
        monkeypatch.setattr(helper, "GATE_SOURCE", gate)
        target = scripts / (runtime.name if kind == "runtime" else helper.GATE_NAME)
        other = scripts / (helper.GATE_NAME if kind == "runtime" else runtime.name)
        other.write_bytes(gate.read_bytes() if kind == "runtime" else runtime.read_bytes())
        return target, target.with_suffix(".tmp"), helper.install_gate, 0o644
    if kind == "trigger":
        monkeypatch.setattr(helper, "TRIGGERS_DIR", tmp_path)
        monkeypatch.setattr(helper, "install_gate", Mock())
        folder = tmp_path / "fake0001"
        folder.mkdir()
        return folder / "spec.json", folder / "spec.json.tmp", lambda: helper.put_trigger(
            "fake0001", {"query": "label:example"}, BackgroundGate("primary")), 0o600
    if kind == "routing":
        target = tmp_path / "whatsapp-routing.json"
        monkeypatch.setattr(helper, "WA_SETTINGS", target)
        monkeypatch.setattr(helper, "wa_status", Mock(return_value={}))
        return target, target.with_name(target.name + ".tmp"), lambda: helper.wa_put({
            "replyRouting": True, "returnMinutes": 30, "freshAfterHours": 4}), 0o600
    if kind == "skills":
        service = skills.SkillsService([], tmp_path, tmp_path, background=BackgroundGate("primary"))
        return service.state_path, service.state_path.with_suffix(".tmp"), service._save_state, 0o600
    monkeypatch.chdir(tmp_path)
    (tmp_path / "spec.json").write_text(json.dumps({"query": "label:example", "role": "primary"}))
    monkeypatch.setattr(mail, "hermes_python", Mock(return_value="example-python"))
    monkeypatch.setattr(mail.subprocess, "run", Mock(return_value=Mock(returncode=0, stdout="[]")))
    return tmp_path / "state.json", tmp_path / "state.tmp", mail.main, 0o600


def test_old_temporary_symlink_is_never_followed(publication, tmp_path):
    target, old_tmp, publish, mode = publication
    victim = tmp_path / "example.txt"
    victim.write_text("unchanged")
    victim.chmod(0o640)
    old_tmp.symlink_to(victim)
    before = set(target.parent.iterdir())
    with contextlib.redirect_stdout(io.StringIO()):
        publish()
    assert victim.read_text() == "unchanged"
    assert victim.stat().st_mode & 0o777 == 0o640
    assert old_tmp.is_symlink()
    assert target.is_file() and not target.is_symlink()
    assert target.stat().st_mode & 0o777 == mode
    assert set(target.parent.iterdir()) == before | {target}


@pytest.mark.parametrize("failure", ["fsync", "replace"])
def test_failed_publication_cleans_up_and_keeps_previous_file(publication, monkeypatch, failure):
    target, _, publish, _ = publication
    previous = json.dumps({"seen": ["example-mail"]}).encode()
    target.write_bytes(previous)
    before = set(target.parent.iterdir())
    monkeypatch.setattr(os, failure, Mock(side_effect=OSError("example publication failure")))
    with contextlib.redirect_stdout(io.StringIO()), pytest.raises(OSError, match="example publication failure"):
        publish()
    assert target.read_bytes() == previous
    assert set(target.parent.iterdir()) == before


def test_publication_syncs_an_exclusive_file_before_replacing(publication, monkeypatch):
    target, _, publish, _ = publication
    synced = []
    real_fsync, real_replace = os.fsync, os.replace

    def fsync(fd):
        synced.append(os.fstat(fd).st_ino)
        real_fsync(fd)

    def replace(source, destination):
        source = Path(source)
        assert source.parent.resolve() == target.parent.resolve()
        assert not source.is_symlink() and source.stat().st_nlink == 1
        assert source.stat().st_ino in synced
        real_replace(source, destination)

    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(os, "replace", replace)
    with contextlib.redirect_stdout(io.StringIO()):
        publish()
    assert target.stat().st_ino in synced


@pytest.mark.parametrize("failure", [False, True])
def test_atomic_write_syncs_the_parent_after_replace_and_closes_it(tmp_path, monkeypatch, failure):
    target = tmp_path / "example.json"
    target.write_bytes(b"previous")
    real_fsync = os.fsync
    directories = []

    def fsync(fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            assert target.read_bytes() == b"published"
            assert os.fstat(fd).st_ino == tmp_path.stat().st_ino
            directories.append(fd)
            if failure:
                raise OSError("example directory sync failure")
        real_fsync(fd)

    monkeypatch.setattr(os, "fsync", fsync)
    if failure:
        with pytest.raises(OSError, match="example directory sync failure"):
            helper.atomic_write(target, b"published")
    else:
        helper.atomic_write(target, b"published")
    assert len(directories) == 1
    with pytest.raises(OSError):
        os.fstat(directories[0])
    assert set(tmp_path.iterdir()) == {target}


def test_skill_folder_publication_ignores_old_temporary_symlinks(tmp_path):
    source, destination, victim = (tmp_path / name for name in ("source", "destination", "victim"))
    for folder in (source, destination, victim):
        folder.mkdir()
    (source / "SKILL.md").write_text("example new skill")
    (victim / "SKILL.md").write_text("unchanged")
    target = destination / "example"
    target.mkdir()
    (target / "SKILL.md").write_text("example old skill")
    links = [destination / f".example{skills.TMP_MARK}{suffix}" for suffix in (str(os.getpid()), f"old-{os.getpid()}")]
    for link in links:
        link.symlink_to(victim, target_is_directory=True)
    service = skills.SkillsService([], tmp_path / "state", tmp_path, background=BackgroundGate("primary"))
    service._write(source, skills.Place("example", "Example", destination, "mirror"), "example", target)
    assert (victim / "SKILL.md").read_text() == "unchanged"
    assert (target / "SKILL.md").read_text() == "example new skill"
    assert all(link.is_symlink() for link in links)
    assert set(destination.iterdir()) == {target, *links}


@pytest.mark.parametrize("failure", ["copy", "rename"])
def test_failed_skill_folder_publication_cleans_up_and_restores_previous(tmp_path, monkeypatch, failure):
    source, destination = tmp_path / "source", tmp_path / "destination"
    source.mkdir()
    (source / "SKILL.md").write_text("example new skill")
    target = destination / "example"
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text("example old skill")
    service = skills.SkillsService([], tmp_path / "state", tmp_path, background=BackgroundGate("primary"))
    if failure == "copy":
        monkeypatch.setattr(service, "_copy_tree", Mock(side_effect=OSError("example copy failure")))
    else:
        real_rename = os.rename
        renames = 0

        def rename(source, dest):
            nonlocal renames
            renames += 1
            if renames == 2:
                raise OSError("example rename failure")
            real_rename(source, dest)

        monkeypatch.setattr(os, "rename", rename)
    with pytest.raises(skills.SkillsError):
        service._write(source, skills.Place("example", "Example", destination, "mirror"), "example", target)
    assert (target / "SKILL.md").read_text() == "example old skill"
    assert set(destination.iterdir()) == {target}


@pytest.mark.parametrize("failure", ["destination", "rollback"])
def test_failed_skill_folder_publication_preserves_unrestored_original(tmp_path, monkeypatch, failure):
    source, destination = tmp_path / "source", tmp_path / "destination"
    source.mkdir()
    (source / "SKILL.md").write_text("example new skill")
    target = destination / "example"
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text("example old skill")
    (target / "scripts").mkdir()
    (target / "scripts" / "example.py").write_text("# example original script\n")
    service = skills.SkillsService([], tmp_path / "state", tmp_path, background=BackgroundGate("primary"))
    real_rename = os.rename

    def rename(source, dest):
        if Path(source).name == "new":
            if failure == "destination":
                target.mkdir()
                (target / "SKILL.md").write_text("example concurrent skill")
                return real_rename(source, dest)
            raise OSError("example publication failure")
        if Path(source).name == "old":
            raise OSError("example rollback failure")
        return real_rename(source, dest)

    monkeypatch.setattr(os, "rename", rename)
    with pytest.raises(skills.SkillsError) as error:
        service._write(source, skills.Place("example", "Example", destination, "mirror"), "example", target)
    staged = list(destination.glob(f".example{skills.TMP_MARK}*"))
    assert len(staged) == 1
    original = staged[0] / "old"
    assert (original / "SKILL.md").read_text() == "example old skill"
    assert (original / "scripts" / "example.py").read_text() == "# example original script\n"
    assert set(staged[0].iterdir()) == {original}
    assert str(original) in str(error.value)
    if failure == "destination":
        assert (target / "SKILL.md").read_text() == "example concurrent skill"
    else:
        assert not target.exists()
