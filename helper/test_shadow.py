"""Shadow-mode checks use only temporary demo state and mocked outside calls."""

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import signalbox_mail_trigger as mail
import signalbox_skills as skills
import wayroost_runtime as runtime
from wayroost_runtime import BackgroundGate, configured_role, env


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


with patch.dict(os.environ, {"WAYROOST_ROLE": "primary"}):
    helper = load("shadow_helper_test", Path(__file__).with_name("signalbox-helper.py"))
    hook = load("shadow_hook_test", Path(__file__).resolve().parent.parent / "claude-hook" / "signalbox-claude-hook.py")
    identity = load("shadow_identity_test", Path(__file__).resolve().parent.parent / "hermes-plugin" / "signalbox-identity" / "__init__.py")


class ShadowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wayroost-shadow-test-")
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        warning_state = patch.object(runtime, "_warned", set())
        warning_state.start()
        self.addCleanup(warning_state.stop)
        environ = patch.dict(os.environ, {"WAYROOST_ROLE": "primary"}, clear=True)
        environ.start()
        self.addCleanup(environ.stop)

    def test_helper_startup_gate_installation(self):
        for role in ("shadow", "primary"):
            with self.subTest(role=role), patch.dict(os.environ, {"WAYROOST_ROLE": role}), \
                    patch.object(helper, "read_token", return_value="fake-token"), \
                    patch.object(helper, "install_gate") as install, \
                    patch.object(helper.signalbox_skills, "from_env", return_value=Mock()), \
                    patch.object(helper, "ThreadingHTTPServer", return_value=Mock()), \
                    patch.object(helper, "log"):
                helper.main()
                self.assertEqual(install.call_count, 1 if role == "primary" else 0)

    def service(self, role):
        shared = self.root / role / "shared"
        source = shared / "demo"
        source.mkdir(parents=True, exist_ok=True)
        (source / "SKILL.md").write_text("---\nname: demo\ndescription: Demo skill\n---\nDemo instructions.\n")
        target = self.root / role / "codex"
        places = [skills.Place("shared", "Shared", shared, "source"), skills.Place("codex", "Codex", target, "mirror")]
        service = skills.SkillsService(places, self.root / role / "state", self.root / "fake-hermes", background=BackgroundGate(role))
        return service, target

    def test_skills_watcher_thread(self):
        for role in ("shadow", "primary"):
            service, _ = self.service(role)
            with self.subTest(role=role), patch.object(skills.threading, "Thread") as thread:
                service.watch(lambda _: None)
                self.assertEqual(thread.call_count, 1 if role == "primary" else 0)
                self.assertEqual(thread.return_value.start.call_count, 1 if role == "primary" else 0)

    def test_skills_background_spread_and_state_writes(self):
        for role in ("shadow", "primary"):
            service, target = self.service(role)
            with self.subTest(role=role):
                service.refresh(requested=False)
                self.assertEqual((target / "demo" / "SKILL.md").exists(), role == "primary")
                self.assertEqual(service.state_path.exists(), role == "primary")

    def test_lazy_skills_listing_does_not_write_for_shadow(self):
        for role in ("shadow", "primary"):
            service, target = self.service(role)
            with self.subTest(role=role), patch.object(service, "_hermes_origins", return_value=(set(), set())):
                service.listing()
                self.assertEqual((target / "demo" / "SKILL.md").exists(), role == "primary")
                self.assertEqual(service.state_path.exists(), role == "primary")

    def test_shared_primary_helper_reads_remain_read_only_for_shadow_server(self):
        service, target = self.service("primary")
        with patch.object(service, "_hermes_origins", return_value=(set(), set())):
            service.listing(background=BackgroundGate("shadow"))
        self.assertFalse((target / "demo" / "SKILL.md").exists())
        self.assertFalse(service.state_path.exists())

    def test_requested_skill_refresh_requires_primary_helper(self):
        for role in ("shadow", "primary"):
            service, target = self.service(role)
            with self.subTest(role=role):
                if role == "shadow":
                    with self.assertRaisesRegex(skills.SkillsError, "primary"):
                        service.refresh()
                    self.assertFalse(service.state_path.exists())
                else:
                    service.refresh()
                    self.assertTrue((target / "demo" / "SKILL.md").exists())
                    self.assertTrue(service.state_path.exists())

    def run_mail(self, role, spec_role=None):
        folder = self.root / role
        folder.mkdir(exist_ok=True)
        spec = {"query": "label:fake-demo", "role": "primary"}
        if spec_role:
            spec["role"] = spec_role
        (folder / "spec.json").write_text(json.dumps(spec))
        before = Path.cwd()
        try:
            os.chdir(folder)
            output = io.StringIO()
            with patch.dict(os.environ, {"WAYROOST_ROLE": role}), \
                    patch.object(mail, "hermes_python", return_value="fake-python"), \
                    patch.object(mail.subprocess, "run", return_value=Mock(returncode=0, stdout="[]")) as search, \
                    contextlib.redirect_stdout(output):
                mail.main()
            return folder, search.call_count, output.getvalue()
        finally:
            os.chdir(before)

    def test_mail_gate_search_and_state_write(self):
        for role in ("shadow", "primary"):
            with self.subTest(role=role):
                folder, calls, output = self.run_mail(role)
                self.assertEqual(calls, 1 if role == "primary" else 0)
                self.assertEqual((folder / "state.json").exists(), role == "primary")
                self.assertEqual(json.loads(output), {"wakeAgent": False})

    def test_mail_gate_model_wake(self):
        for role in ("shadow", "primary"):
            folder = self.root / role
            folder.mkdir(exist_ok=True)
            (folder / "spec.json").write_text(json.dumps({"query": "label:fake-demo", "role": "primary"}))
            (folder / "state.json").write_text(json.dumps({"seen": []}))
            before = Path.cwd()
            try:
                os.chdir(folder)
                output = io.StringIO()
                with self.subTest(role=role), patch.dict(os.environ, {"WAYROOST_ROLE": role}), \
                        patch.object(mail, "hermes_python", return_value="fake-python"), \
                        patch.object(mail.subprocess, "run", return_value=Mock(returncode=0, stdout=json.dumps([
                            {"id": "fake-mail-id", "subject": "Demo subject", "snippet": "Demo message"}]))), \
                        contextlib.redirect_stdout(output):
                    mail.main()
                    self.assertEqual("New mail matching" in output.getvalue(), role == "primary")
                    if role == "shadow":
                        self.assertEqual(json.loads(output.getvalue()), {"wakeAgent": False})
                        self.assertEqual(json.loads((folder / "state.json").read_text()), {"seen": []})
            finally:
                os.chdir(before)

    def test_shadow_trigger_spec_stays_quiet_in_primary_helper(self):
        folder, calls, output = self.run_mail("primary", "shadow")
        self.assertEqual(calls, 0)
        self.assertFalse((folder / "state.json").exists())
        self.assertEqual(json.loads(output), {"wakeAgent": False})

    def test_trigger_creation_keeps_request_role_in_spec(self):
        for role in ("shadow", "primary"):
            with self.subTest(role=role), patch.dict(os.environ, {"WAYROOST_ROLE": "primary"}), \
                    patch.object(helper, "TRIGGERS_DIR", self.root / role), patch.object(helper, "install_gate"):
                helper.put_trigger("0000000000000000", {"query": "label:fake-demo", "role": role})
                self.assertEqual(json.loads((self.root / role / "0000000000000000" / "spec.json").read_text())["role"], role)

    def test_claude_hook_reporting_and_launcher_env_write(self):
        for role in ("shadow", "primary"):
            env_file = self.root / f"{role}-env"
            data = {"hook_event_name": "SessionStart", "session_id": "00000000-0000-0000-0000-000000000002", "cwd": "/home/me/code/demo"}
            with self.subTest(role=role), patch.dict(os.environ, {"WAYROOST_ROLE": role, "PASEO_AGENT_ID": "00000000-0000-0000-0000-000000000001", "CLAUDE_ENV_FILE": str(env_file)}), \
                    patch.object(hook.sys, "stdin", io.StringIO(json.dumps(data))), patch.object(hook, "post") as post:
                hook.main()
                self.assertEqual(post.call_count, 1 if role == "primary" else 0)
                self.assertEqual(env_file.exists(), role == "primary")

    def test_hermes_identity_launch_reports(self):
        for role in ("shadow", "primary"):
            with self.subTest(role=role), patch.dict(os.environ, {"WAYROOST_ROLE": role}), \
                    patch.object(identity, "_reported", False), patch.object(identity, "_is_acp", return_value=False), \
                    patch.object(identity, "initial_environ", return_value={"PASEO_AGENT_ID": "00000000-0000-0000-0000-000000000001"}), \
                    patch.object(identity, "_post") as post:
                identity.on_session_start("00000000_000000_fake")
                self.assertEqual(post.call_count, 1 if role == "primary" else 0)

    def test_role_config_and_environment_aliases(self):
        config = self.root / "config.json"
        config.write_text(json.dumps({"role": "shadow"}))
        with patch.dict(os.environ, {"WAYROOST_CONFIG": str(config)}, clear=True):
            self.assertEqual(configured_role(), "shadow")
        with patch.dict(os.environ, {"WAYROOST_ROLE": "primary", "SIGNALBOX_ROLE": "shadow"}, clear=True):
            self.assertEqual(configured_role(), "primary")
        with patch.dict(os.environ, {"SIGNALBOX_ROLE": "shadow"}, clear=True), contextlib.redirect_stderr(io.StringIO()) as warning:
            self.assertEqual(configured_role(), "shadow")
            self.assertEqual(configured_role(), "shadow")
            self.assertEqual(warning.getvalue().count("deprecated"), 1)
        with patch.dict(os.environ, {"WAYROOST_HELPER_PORT": "8894", "SIGNALBOX_HELPER_PORT": "8895"}, clear=True):
            self.assertEqual(env("HELPER_PORT"), "8894")
        with patch.dict(os.environ, {"WAYROOST_ROLE": "invalid"}, clear=True):
            self.assertEqual(configured_role(), "shadow")


if __name__ == "__main__":
    unittest.main()
