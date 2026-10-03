"""Role resolution and real helper handlers, with temporary demo folders only."""

import ast
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import signalbox_skills as skills
import signalbox_mail_trigger as mail
from wayroost_runtime import BackgroundGate, configured_role

SOURCE = Path(__file__).resolve().parent
with patch.dict(os.environ, {"WAYROOST_ROLE": "primary"}, clear=True):
    spec = importlib.util.spec_from_file_location("role_helper_test", SOURCE / "signalbox-helper.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)


class RoleSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wayroost-role-test-")
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.environ = patch.dict(os.environ, {"WAYROOST_ROLE": "primary"}, clear=True)
        self.environ.start()
        self.addCleanup(self.environ.stop)

    def test_shadow_wins_over_primary_environment(self):
        config = self.root / "config.json"
        config.write_text('{"role":"shadow"}')
        for key in ("WAYROOST_ROLE", "SIGNALBOX_ROLE"):
            with self.subTest(key=key), patch.dict(os.environ, {key: "primary", "WAYROOST_CONFIG": str(config)}, clear=True):
                self.assertEqual(configured_role(), "shadow")

    def test_unresolved_roles_are_shadow(self):
        for environ in ({}, {"WAYROOST_ROLE": "Shadow"}, {"WAYROOST_CONFIG": str(self.root / "missing")},
                        {"WAYROOST_ROLE": "primary", "WAYROOST_CONFIG": ""},
                        {"WAYROOST_ROLE": "primary", "WAYROOST_CONFIG": str(self.root)}):
            with self.subTest(environ=environ), patch.dict(os.environ, environ, clear=True):
                self.assertEqual(BackgroundGate().role, "shadow")
                self.assertIsNone(BackgroundGate().run(lambda: "acted"))

    def test_config_permission_error_is_shadow_even_with_primary_environment(self):
        with patch.dict(os.environ, {"WAYROOST_ROLE": "primary", "WAYROOST_CONFIG": "/home/me/fake-config"}, clear=True), \
                patch.object(Path, "read_text", side_effect=PermissionError("fake unreadable config")):
            self.assertEqual(BackgroundGate().role, "shadow")

    def test_readable_legacy_config_without_role_retains_primary(self):
        config = self.root / "config.json"
        config.write_text('{}')
        with patch.dict(os.environ, {"WAYROOST_CONFIG": str(config)}, clear=True):
            self.assertEqual(configured_role(), "primary")

    def test_scoped_config_is_used_only_without_explicit_environment(self):
        config = self.root / "wayroost-role.json"
        config.write_text('{"role":"primary"}')
        for environ, expected in (({}, "primary"), ({"WAYROOST_ROLE": "shadow"}, "shadow"),
                                  ({"SIGNALBOX_ROLE": "shadow"}, "shadow"),
                                  ({"WAYROOST_ROLE": "bad"}, "shadow"),
                                  ({"WAYROOST_CONFIG": str(self.root / "missing")}, "shadow")):
            with self.subTest(environ=environ), patch.dict(os.environ, environ, clear=True):
                self.assertEqual(BackgroundGate(default_config=config).role, expected)
        for text in ('{"role":"shadow"}', 'invalid', '[]', '{}'):
            config.write_text(text)
            with self.subTest(text=text), patch.dict(os.environ, {}, clear=True):
                self.assertEqual(BackgroundGate(default_config=config).role, "shadow")
        config.unlink()
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(BackgroundGate(default_config=config).role, "shadow")

    def test_shipped_primary_helper_environment_starts_watcher_and_confirms_trigger(self):
        unit = (SOURCE.parent / "deploy" / "signalbox-helper.service").read_text()
        environ = dict(line.removeprefix("Environment=").split("=", 1)
                       for line in unit.splitlines() if line.startswith("Environment=")
                       and "@" not in line)
        role_config = self.root / "wayroost-role.json"
        role_config.write_bytes((SOURCE.parent / "deploy" / "primary-role.json").read_bytes())
        self.assertEqual(environ["WAYROOST_HELPER_ROLE_CONFIG"], "/opt/signalbox/bin/wayroost-role.json")
        environ["WAYROOST_HELPER_ROLE_CONFIG"] = str(role_config)
        with patch.dict(os.environ, environ, clear=True), patch.object(helper, "TRIGGERS_DIR", self.root / "triggers"), \
                patch.object(helper, "install_gate"), patch.object(skills.threading, "Thread") as thread:
            self.assertEqual(helper.process_background().role, "primary")
            service = self.service(background=helper.process_background())
            service.watch(lambda _: None)
            thread.return_value.start.assert_called_once()
            service.refresh()
            self.assertTrue(service.state_path.exists())
            self.assertEqual(helper.put_trigger("fake0001", {"query": "label:fake-demo"})["role"], "primary")
            actions = [("POST", "/skills/share", {"place": "codex", "name": "demo"}),
                       ("POST", "/skills/take-shared", {"place": "codex", "name": "demo"}),
                       ("PUT", "/skills/excluded", {"place": "codex", "name": "demo", "excluded": True}),
                       ("POST", "/skills/refresh", {}), ("POST", "/skills/remove", {"name": "demo"})]
            with patch.object(service, "scan_fn", return_value={"verdict": "safe"}):
                for method, path, body in actions:
                    with self.subTest(path=path):
                        status, result = self.request(service, method=method, path=path, body=body)
                        self.assertEqual(status, 200, result)
        for key in ("WAYROOST_ROLE", "SIGNALBOX_ROLE"):
            with self.subTest(key=key), patch.dict(os.environ, {**environ, key: "shadow"}, clear=True):
                self.assertEqual(helper.process_background().role, "shadow")
        with patch.dict(os.environ, {**environ, "WAYROOST_SKILLS_HOME": str(self.root / "fake-home")}, clear=True), \
                patch.object(helper, "HERMES_HOME", self.root / "fake-hermes"), \
                patch.object(helper, "read_token", return_value="fake-token"), patch.object(helper, "install_gate") as install, \
                patch.object(helper, "ThreadingHTTPServer", return_value=Mock()), patch.object(helper, "log"), \
                patch.object(skills.threading, "Thread") as thread:
            helper.main()
            install.assert_called_once()
            self.assertEqual(helper.SKILLS.background.role, "primary")
            thread.return_value.start.assert_called_once()

    def test_primary_mail_spec_configures_gate_without_inherited_environment(self):
        before = Path.cwd()
        self.addCleanup(os.chdir, before)
        os.chdir(self.root)
        for spec_role, expected in (("primary", True), ("shadow", False), (None, False), ("bad", False)):
            (self.root / "spec.json").write_text(json.dumps({"role": spec_role, "query": "label:fake-demo"}))
            with self.subTest(role=spec_role), patch.dict(os.environ, {}, clear=True), \
                    patch.object(mail, "hermes_python", return_value="fake-python"), \
                    patch.object(mail.subprocess, "run", return_value=Mock(returncode=0, stdout="[]")) as search, \
                    contextlib.redirect_stdout(io.StringIO()):
                mail.main()
            self.assertEqual(search.called, expected)
            self.assertEqual((self.root / "state.json").exists(), expected)
            if expected:
                output = io.StringIO()
                with patch.dict(os.environ, {}, clear=True), patch.object(mail, "hermes_python", return_value="fake-python"), \
                        patch.object(mail.subprocess, "run", return_value=Mock(returncode=0, stdout=json.dumps([
                            {"id": "fake-mail", "subject": "Demo subject", "snippet": "Demo message"}]))), \
                        contextlib.redirect_stdout(output):
                    mail.main()
                self.assertIn("New mail matching", output.getvalue())
                self.assertEqual(json.loads((self.root / "state.json").read_text()), {"seen": ["fake-mail"]})
            (self.root / "state.json").unlink(missing_ok=True)

    def test_install_upgrade_configures_existing_helper_without_widening_shadow(self):
        script = (SOURCE.parent / "deploy" / "install.sh").read_text()
        marker = "python3 - /etc/systemd/system/signalbox-helper.service <<'PY'\n"
        migration = script.split(marker, 1)[1].split("\nPY", 1)[0]
        unit = self.root / "fake-helper.service"
        for previous in ("", "Environment=SIGNALBOX_ROLE=shadow\n", "Environment=WAYROOST_ROLE=shadow\n"):
            unit.write_text(f"[Service]\n{previous}ExecStart=/home/me/fake-helper\n")
            with self.subTest(previous=previous), patch.object(sys, "argv", ["install-upgrade", str(unit)]):
                exec(compile(migration, "install-upgrade", "exec"), {})
            self.assertIn("Environment=WAYROOST_HELPER_ROLE_CONFIG=/opt/signalbox/bin/wayroost-role.json", unit.read_text())
            if previous:
                self.assertIn(previous, unit.read_text())
            before = unit.read_text()
            with patch.object(sys, "argv", ["install-upgrade", str(unit)]):
                exec(compile(migration, "install-upgrade", "exec"), {})
            self.assertEqual(unit.read_text(), before)
        self.assertIn('install -m 644 -o root -g root deploy/primary-role.json "$DEST/bin/wayroost-role.json"', script)

    def test_unresolved_process_cannot_use_cached_primary_skills_service_to_mutate(self):
        service = self.service()
        with patch.dict(os.environ, {"WAYROOST_CONFIG": str(self.root / "missing")}, clear=True):
            for method, path in (("POST", "/skills/share"), ("POST", "/skills/take-shared"),
                                 ("PUT", "/skills/excluded"), ("POST", "/skills/refresh"), ("POST", "/skills/remove")):
                with self.subTest(path=path):
                    status, _ = self.request(service, method=method, path=path, body={"place": "codex", "name": "demo"})
                    self.assertEqual(status, 409)
        self.assertFalse(service.state_path.exists())
        self.assertFalse((self.root / "codex").exists())

    def test_mail_errors_and_shadow_specs_exit_zero_without_search_or_state(self):
        script = self.root / "signalbox_mail_trigger.py"
        shutil.copyfile(SOURCE / script.name, script)
        runtime = self.root / "wayroost_runtime.py"
        for spec_role in ("shadow", "primary"):
            for failure in ("invalid-role", "missing-config", "unreadable-config", "missing-runtime"):
                with self.subTest(spec_role=spec_role, failure=failure):
                    if runtime.exists():
                        runtime.unlink()
                    if failure != "missing-runtime":
                        shutil.copyfile(SOURCE / runtime.name, runtime)
                    (self.root / "spec.json").write_text(json.dumps({"role": spec_role, "query": "label:fake-demo"}))
                    environ = {"PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1", "WAYROOST_ROLE": "primary"}
                    if failure == "invalid-role":
                        environ["WAYROOST_ROLE"] = "Shadow"
                    elif failure == "missing-config":
                        environ["WAYROOST_CONFIG"] = str(self.root / "missing")
                    elif failure == "unreadable-config":
                        environ["WAYROOST_CONFIG"] = str(self.root)  # reading a directory raises OSError on every uid
                    result = subprocess.run([sys.executable, str(script)], cwd=self.root, env=environ,
                                            capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout), {"wakeAgent": False})
                    self.assertFalse((self.root / "state.json").exists())

    def service(self, background=None):
        shared = self.root / "shared"
        source = shared / "demo"
        source.mkdir(parents=True, exist_ok=True)
        (source / "SKILL.md").write_text('---\nname: demo\ndescription: Demo skill\n---\nDemo.\n')
        places = [skills.Place("shared", "Shared", shared, "source"),
                  skills.Place("codex", "Codex", self.root / "codex", "mirror")]
        return skills.SkillsService(places, self.root / "state", self.root / "fake-hermes", background=background)

    def request(self, service, header=None, method="GET", path="/skills", body=None):
        handler = object.__new__(helper.Handler)
        handler.path = path
        handler.headers = {"host": "127.0.0.1", "authorization": "Bearer fake-token"}
        if header is not None:
            handler.headers["x-wayroost-role"] = header
        data = json.dumps(body or {}).encode()
        handler.headers["content-length"] = str(len(data))
        handler.rfile = io.BytesIO(data)
        handler._send = Mock()
        with patch.object(helper, "TOKEN", "fake-token"), patch.object(helper, "SKILLS", service), \
                patch.object(helper, "TRIGGERS_DIR", self.root / "triggers"), patch.object(helper, "install_gate"):
            handler._route(method)
        return handler._send.call_args.args

    def test_header_can_only_narrow_helper_role_and_listing_confirms_it(self):
        for process_role, header, expected in (("shadow", None, "shadow"), ("shadow", "primary", "shadow"),
                                               ("primary", "shadow", "shadow"), ("primary", None, "primary")):
            with self.subTest(process_role=process_role, header=header), \
                    patch.dict(os.environ, {"WAYROOST_ROLE": process_role}, clear=True):
                service = self.service()
                with patch.object(service, "_hermes_origins", return_value=(set(), set())):
                    status, data = self.request(service, header)
                self.assertEqual(status, 200)
                self.assertEqual(data["role"], expected)
                self.assertEqual(service.state_path.exists(), expected == "primary")
                shutil.rmtree(self.root / "state", ignore_errors=True)
                shutil.rmtree(self.root / "codex", ignore_errors=True)
        status, _ = self.request(self.service(), "bogus")
        self.assertEqual(status, 400)

    def test_versioned_shadow_listing_never_syncs_even_without_shadow_header(self):
        service = self.service()
        for header in (None, "primary", "shadow"):
            with self.subTest(header=header), patch.object(service, "_hermes_origins", return_value=(set(), set())):
                status, result = self.request(service, header, path="/v1/shadow/skills")
                self.assertEqual(status, 200, result)
                self.assertEqual(result["role"], "shadow")
                self.assertFalse(service.state_path.exists())
                self.assertFalse((self.root / "codex").exists())

    def test_versioned_shadow_routes_dispatch_all_operations_and_preserve_queries(self):
        service = self.service()
        cases = [("GET", "/google", "google_status", None),
                 ("POST", "/google/start", "google_start", None),
                 ("POST", "/google/finish", "google_finish", {}),
                 ("POST", "/google/disconnect", "google_disconnect", None),
                 ("GET", "/shops", "shops_status", None),
                 ("GET", "/phone", "phone_status", None),
                 ("GET", "/phone/pin", "phone_pin", None),
                 ("PUT", "/phone/pin", "phone_set_pin", {}),
                 ("PUT", "/phone/voice", "phone_set_voice", {}),
                 ("GET", "/whatsapp-routing", "wa_status", None),
                 ("PUT", "/whatsapp-routing", "wa_put", {}),
                 ("GET", "/triggers", "list_triggers", None),
                 ("DELETE", "/triggers/fake0001", "delete_trigger", "fake0001")]
        for method, path, function, argument in cases:
            with self.subTest(path=path), patch.object(helper, function, return_value={"demo": True}) as action:
                status, result = self.request(service, "shadow", method, "/v1/shadow" + path)
                self.assertEqual(status, 200, result)
                self.assertEqual(result, {"demo": True})
                action.assert_called_once_with(*(() if argument is None else (argument,)))
        with patch.object(service, "content", return_value={"text": "Demo."}) as content:
            status, result = self.request(service, path="/v1/shadow/skills/content?place=shared&name=demo")
            self.assertEqual(status, 200, result)
            content.assert_called_once_with("shared", "demo")
        status, result = self.request(service, path="/v1/shadow/skills/version")
        self.assertEqual((status, result), (200, {"version": service.version}))

    def test_versioned_shadow_trigger_cannot_be_widened_by_header_or_body(self):
        status, result = self.request(None, "primary", "PUT", "/v1/shadow/triggers/fake0001",
                                      {"query": "label:fake-demo", "role": "primary"})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["role"], "shadow")
        stored = json.loads((self.root / "triggers" / "fake0001" / "spec.json").read_text())
        self.assertEqual(stored["role"], "shadow")

    def test_versioned_routes_fail_closed_on_unresolved_process_role(self):
        service = self.service()  # Deliberately cached while the process was primary.
        actions = [("POST", "/skills/share", "share"), ("POST", "/skills/take-shared", "take_shared"),
                   ("PUT", "/skills/excluded", "set_excluded"), ("POST", "/skills/refresh", "refresh"),
                   ("POST", "/skills/remove", "remove_shared")]
        with patch.dict(os.environ, {"WAYROOST_CONFIG": str(self.root / "missing")}, clear=True):
            for method, path, function in actions:
                with self.subTest(path=path), patch.object(service, function) as action:
                    status, _ = self.request(service, "primary", method, "/v1/shadow" + path,
                                             {"place": "shared", "name": "demo"})
                    self.assertEqual(status, 409)
                    action.assert_not_called()
        self.assertFalse(service.state_path.exists())

    def test_versioned_shadow_skills_preserve_requested_primary_helper_actions(self):
        service = self.service()
        actions = [("POST", "/skills/scan", "scan", ("shared", "demo")),
                   ("POST", "/skills/share", "share", ("shared", "demo", False)),
                   ("POST", "/skills/take-shared", "take_shared", ("shared", "demo")),
                   ("PUT", "/skills/excluded", "set_excluded", ("demo", "shared", False)),
                   ("POST", "/skills/remove", "remove_shared", ("demo",))]
        for method, path, function, arguments in actions:
            with self.subTest(path=path), patch.object(service, function, return_value={"demo": True}) as action:
                status, result = self.request(service, "shadow", method, "/v1/shadow" + path,
                                              {"place": "shared", "name": "demo"})
                self.assertEqual(status, 200, result)
                action.assert_called_once_with(*arguments)
        with patch.object(service, "refresh") as refresh:
            status, result = self.request(service, "shadow", "POST", "/v1/shadow/skills/refresh")
            self.assertEqual(status, 200, result)
            refresh.assert_called_once_with(force_windows=True)

    def test_versioned_routes_reject_invalid_header_and_unknown_versions_without_actions(self):
        service = self.service()
        for path, header, expected in (("/v1/shadow/skills", "bad", 400),
                                       ("/v2/shadow/skills", "shadow", 404),
                                       ("/v1/shadowish/skills", "shadow", 404)):
            with self.subTest(path=path), patch.object(service, "listing") as listing:
                status, _ = self.request(service, header, path=path)
                self.assertEqual(status, expected)
                listing.assert_not_called()

    def test_trigger_default_and_handler_preserve_and_echo_shadow(self):
        with patch.dict(os.environ, {"WAYROOST_ROLE": "shadow"}, clear=True), \
                patch.object(helper, "TRIGGERS_DIR", self.root / "triggers"), patch.object(helper, "install_gate"):
            result = helper.put_trigger("fake0001", {"query": "label:fake-demo"})
            self.assertEqual(result["role"], "shadow")
            self.assertEqual(helper.list_triggers()["triggers"]["fake0001"]["role"], "shadow")
            status, result = self.request(None, "primary", "PUT", "/triggers/fake0002",
                                          {"query": "label:fake-demo", "role": "primary"})
            self.assertEqual(status, 200)
            self.assertEqual(result["role"], "shadow")
        status, result = self.request(None, "shadow", "PUT", "/triggers/fake0003", {"query": "label:fake-demo"})
        self.assertEqual(status, 200)
        self.assertEqual(result["role"], "shadow")

    def test_trigger_listing_does_not_assign_primary_to_unresolved_specs(self):
        for role in (None, "bad", "shadow", "primary"):
            folder = self.root / "triggers" / "fake0001"
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "spec.json").write_text(json.dumps({"query": "label:fake-demo", "role": role}))
            with self.subTest(role=role), patch.object(helper, "TRIGGERS_DIR", folder.parent):
                self.assertEqual(helper.list_triggers()["triggers"][folder.name]["role"], "primary" if role == "primary" else "shadow")

    def test_from_env_without_injected_gate_honours_shadow(self):
        with patch.dict(os.environ, {"WAYROOST_ROLE": "shadow", "WAYROOST_SKILLS_HOME": str(self.root)}, clear=True):
            service = skills.from_env(self.root / "fake-hermes")
            self.assertEqual(service.background.role, "shadow")

    def test_shadow_skill_actions_refuse_before_any_change(self):
        with patch.dict(os.environ, {"WAYROOST_ROLE": "shadow"}, clear=True):
            service = self.service()
            actions = [lambda: service.refresh(), lambda: service.share("codex", "demo"),
                       lambda: service.take_shared("codex", "demo"), lambda: service.set_excluded("demo", "codex", True),
                       lambda: service.remove_shared("demo")]
            for action in actions:
                with self.assertRaisesRegex(skills.SkillsError, "primary"):
                    action()
            self.assertFalse(service.state_path.exists())
            self.assertTrue((self.root / "shared" / "demo" / "SKILL.md").exists())
            self.assertFalse((self.root / "codex").exists())

    def test_shadow_listing_reloads_changes_from_the_only_primary_writer(self):
        primary = self.service()
        primary.refresh()
        with patch.dict(os.environ, {"WAYROOST_ROLE": "shadow"}, clear=True):
            shadow = self.service()
        with patch.object(shadow, "_hermes_origins", return_value=(set(), set())):
            shadow.listing()
            primary.set_excluded("demo", "codex", True)
            shadow.listing()
        self.assertEqual(shadow.state["excluded"], {"demo": ["codex"]})
        self.assertEqual(json.loads(primary.state_path.read_text())["excluded"], {"demo": ["codex"]})
        self.assertFalse((self.root / "codex" / "demo").exists())

    def test_gate_install_uses_new_name_and_preserves_legacy_gate(self):
        scripts = self.root / "scripts"
        scripts.mkdir()
        old = scripts / "signalbox_mail_trigger.py"
        old.write_text("# fake legacy gate\n")
        with patch.object(helper, "HERMES_HOME", self.root), patch.object(helper, "log"):
            helper.install_gate()
        self.assertEqual(old.read_text(), "# fake legacy gate\n")
        self.assertEqual((scripts / "wayroost_mail_trigger.py").read_bytes(), (SOURCE / "signalbox_mail_trigger.py").read_bytes())

    def test_bridge_installer_requires_runtime_and_installs_it(self):
        script = (SOURCE.parent / "deploy" / "setup-bridge.sh").read_text()
        start = script.index("def files_in(root):")
        end = script.index("\n\ndef ", script.index("def plugin(src, dest, stamp, dry):"))
        namespace = {"os": os, "shutil": shutil, "tempfile": tempfile, "say": lambda _: None,
                     "CHANGED": 1, "NOTHING": 0}
        exec(compile(ast.parse(script[start:end]), "installer-functions", "exec"), namespace)
        repo = self.root / "repo"
        source = repo / "hermes-plugin" / "signalbox-identity"
        shutil.copytree(SOURCE.parent / "hermes-plugin" / "signalbox-identity", source,
                        ignore=shutil.ignore_patterns("__pycache__"))
        dest = self.root / "fake-hermes" / "plugins" / "signalbox-identity"
        with self.assertRaisesRegex(RuntimeError, "runtime"):
            namespace["plugin"](str(source), str(dest), "fake-stamp", False)
        self.assertFalse(dest.exists())
        (repo / "helper").mkdir()
        shutil.copyfile(SOURCE / "wayroost_runtime.py", repo / "helper" / "wayroost_runtime.py")
        (repo / "deploy").mkdir()
        shutil.copyfile(SOURCE.parent / "deploy" / "primary-role.json", repo / "deploy" / "primary-role.json")
        namespace["plugin"](str(source), str(dest), "fake-stamp", False)
        self.assertEqual((dest / "wayroost_runtime.py").read_bytes(), (SOURCE / "wayroost_runtime.py").read_bytes())
        self.assertEqual(json.loads((dest / "wayroost-role.json").read_text()), {"role": "primary"})
        code = """
import importlib.util, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('installed_plugin', sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
assert plugin.BackgroundGate is not None
with patch.object(plugin, '_post') as post, patch.object(plugin, 'initial_environ', return_value={'PASEO_AGENT_ID': '00000000-0000-0000-0000-000000000001'}):
    plugin.on_session_start('00000000_000000_fake')
    assert post.call_count == int(sys.argv[2] in ('primary', 'unconfigured'))
"""
        for role in ("shadow", "primary", "unconfigured"):
            result = subprocess.run([sys.executable, "-I", "-c", code, str(dest / "__init__.py"), role],
                                    env={"PATH": os.defpath, **({"WAYROOST_ROLE": role} if role != "unconfigured" else {})},
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
        (dest / "wayroost-role.json").unlink()
        result = subprocess.run([sys.executable, "-I", "-c", code, str(dest / "__init__.py"), "shadow"],
                                env={"PATH": os.defpath}, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
