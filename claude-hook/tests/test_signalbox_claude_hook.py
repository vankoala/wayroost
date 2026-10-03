"""Tests for the Signalbox Claude Code hook.

Plain unittest on the system interpreter the hook runs on:

    python3 -m unittest discover -s <signalbox>/claude-hook/tests -v
"""

from __future__ import annotations

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
from unittest import mock

HOOK = Path(__file__).resolve().parent.parent / "signalbox-claude-hook.py"
SID = "0c1a0de0-0000-4000-8000-000000000001"
AGENT = "0c1a0de0-0000-4000-8000-000000000002"


def _load_hook():
    spec = importlib.util.spec_from_file_location("signalbox_claude_hook_under_test", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hook = _load_hook()


def _entry(role, text):
    return json.dumps({"type": role, "message": {"role": role, "content": [{"type": "text", "text": text}]}})


class HookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def transcript(self, *lines):
        path = Path(self.tmp.name) / "transcript.jsonl"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return str(path)

    def test_shadow_and_unresolved_roles_never_report_or_write_launcher_env(self):
        target = Path(self.tmp.name) / "launcher-env"
        data = {"hook_event_name": "SessionStart", "session_id": SID, "cwd": "/home/me/app"}
        for role_env in ({}, {"WAYROOST_ROLE": "shadow"}, {"WAYROOST_ROLE": "Shadow"},
                         {"WAYROOST_ROLE": "primary", "WAYROOST_CONFIG": str(Path(self.tmp.name) / "missing")}):
            with self.subTest(role_env=role_env), mock.patch.dict(os.environ,
                    {"PASEO_AGENT_ID": AGENT, "CLAUDE_ENV_FILE": str(target), **role_env}, clear=True), \
                    mock.patch.object(hook, "post") as post, mock.patch("sys.stdin", io.StringIO(json.dumps(data))):
                hook.main()
                post.assert_not_called()
                self.assertFalse(target.exists())

    def test_missing_runtime_copy_exits_zero_without_launcher_write(self):
        target = Path(self.tmp.name) / HOOK.name
        shutil.copyfile(HOOK, target)
        env_file = Path(self.tmp.name) / "launcher-env"
        result = subprocess.run([sys.executable, "-I", str(target)],
                                input=json.dumps({"hook_event_name": "SessionStart", "session_id": SID}),
                                env={"PATH": os.defpath, "WAYROOST_ROLE": "primary", "PASEO_AGENT_ID": AGENT,
                                     "CLAUDE_ENV_FILE": str(env_file)}, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertFalse(env_file.exists())

    def test_installed_hook_uses_scoped_primary_config_and_fails_closed(self):
        target = Path(self.tmp.name) / HOOK.name
        shutil.copyfile(HOOK, target)
        shutil.copyfile(HOOK.parent.parent / "helper" / "wayroost_runtime.py", target.with_name("wayroost_runtime.py"))
        role_config = target.with_name("wayroost-role.json")
        role_config.write_bytes((HOOK.parent.parent / "deploy" / "primary-role.json").read_bytes())
        spec = importlib.util.spec_from_file_location("installed_hook_test", target)
        installed = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installed)
        data = {"hook_event_name": "SessionStart", "session_id": SID, "cwd": "/home/me/app"}
        for environ, allowed in (({}, True), ({"WAYROOST_ROLE": "shadow"}, False),
                                 ({"SIGNALBOX_ROLE": "shadow"}, False), ({"WAYROOST_ROLE": "bad"}, False),
                                 ({"WAYROOST_CONFIG": str(target.parent / "missing")}, False)):
            env_file = target.parent / "launcher-env"
            env_file.unlink(missing_ok=True)
            with self.subTest(environ=environ), mock.patch.dict(os.environ,
                    {"PASEO_AGENT_ID": AGENT, "CLAUDE_ENV_FILE": str(env_file), **environ}, clear=True), \
                    mock.patch.object(installed, "post") as post, mock.patch("sys.stdin", io.StringIO(json.dumps(data))):
                installed.main()
            self.assertEqual(post.called, allowed)
            self.assertEqual(env_file.exists(), allowed)
        for text in ('invalid', '{}', '{"role":"shadow"}'):
            role_config.write_text(text)
            with self.subTest(text=text), mock.patch.dict(os.environ, {"PASEO_AGENT_ID": AGENT}, clear=True), \
                    mock.patch.object(installed, "post") as post, mock.patch("sys.stdin", io.StringIO(json.dumps(data))):
                installed.main()
            post.assert_not_called()
        role_config.unlink()
        with mock.patch.dict(os.environ, {"PASEO_AGENT_ID": AGENT}, clear=True), \
                mock.patch.object(installed, "post") as post, mock.patch("sys.stdin", io.StringIO(json.dumps(data))):
            installed.main()
        post.assert_not_called()

    def run_hook(self, event, env=None, **fields):
        """Run the hook as Claude Code would; returns the bodies it posted and what it printed."""
        data = {"hook_event_name": event, "session_id": SID, "cwd": "/home/me/app", **fields}
        env = {"PASEO_AGENT_ID": AGENT, "CLAUDE_CODE_ENTRYPOINT": "sdk-cli"} if env is None else env
        env = {"WAYROOST_ROLE": "primary", **env}
        out = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(hook, "post") as post, \
                mock.patch("sys.stdin", io.StringIO(json.dumps(data))), contextlib.redirect_stdout(out):
            hook.main()
        return [c.args[0] for c in post.call_args_list], out.getvalue()

    def test_stop_uses_the_answer_claude_code_hands_over(self):
        path = self.transcript(_entry("assistant", "an earlier answer"))
        posted, _ = self.run_hook("Stop", transcript_path=path, last_assistant_message="  Found 2 issues.  ")
        self.assertEqual(posted, [{"session": SID, "event": "stop", "final": "Found 2 issues."}])

    def test_stop_from_an_older_claude_code_reads_the_transcript(self):
        path = self.transcript(_entry("user", "Audit it"), _entry("assistant", "Found 2 issues."), '{"type": "system"}')
        posted, _ = self.run_hook("Stop", transcript_path=path)
        self.assertEqual(posted[0]["final"], "Found 2 issues.")

    def test_end_reads_the_answer_from_the_transcript(self):
        # At Stop the last line may not be on disk yet; by SessionEnd it is.
        path = self.transcript(_entry("user", "Audit it"), _entry("assistant", "Found 2 issues."))
        posted, _ = self.run_hook("SessionEnd", transcript_path=path)
        self.assertEqual(posted, [{"session": SID, "event": "end", "final": "Found 2 issues."}])

    def test_end_without_an_answer_sends_none(self):
        posted, _ = self.run_hook("SessionEnd", transcript_path=self.transcript(_entry("user", "Audit it")))
        self.assertEqual(posted, [{"session": SID, "event": "end"}])
        posted, _ = self.run_hook("SessionEnd", transcript_path=str(Path(self.tmp.name) / "missing.jsonl"))
        self.assertEqual(posted, [{"session": SID, "event": "end"}])

    def test_reads_only_the_end_of_a_long_transcript(self):
        path = self.transcript(_entry("assistant", "x" * 500), _entry("user", "go on"), _entry("assistant", "Done."))
        with mock.patch.object(hook, "TAIL_BYTES", 120):  # starts mid-line: that line is skipped
            self.assertEqual(hook.last_assistant_text(path), "Done.")

    def test_answer_is_clipped(self):
        posted, _ = self.run_hook("Stop", transcript_path="", last_assistant_message="y" * (hook.MAX_FINAL + 50))
        self.assertEqual(len(posted[0]["final"]), hook.MAX_FINAL)

    def test_prompt_is_the_task(self):
        posted, _ = self.run_hook("UserPromptSubmit", prompt="  Audit the repo  ")
        self.assertEqual(posted, [{"session": SID, "event": "prompt", "task": "Audit the repo"}])

    def test_start_names_its_launchers_and_itself_for_what_it_starts(self):
        env_file = Path(self.tmp.name) / "claude-env"
        posted, _ = self.run_hook("SessionStart", env={
            "PASEO_AGENT_ID": AGENT, "HERMES_SESSION_ID": "20260315_101500_c0ffee",
            "CLAUDE_CODE_ENTRYPOINT": "sdk-cli", "CLAUDE_ENV_FILE": str(env_file)})
        body = posted[0]
        self.assertEqual(body["event"], "start")
        self.assertEqual(body["candidates"], [{"kind": "hermes", "id": "20260315_101500_c0ffee"}, {"kind": "paseo", "id": AGENT}])
        self.assertEqual((body["cwd"], body["entrypoint"]), ("/home/me/app", "sdk-cli"))
        self.assertIsInstance(body["started_at"], float)
        self.assertEqual(env_file.read_text(), f"export WAYROOST_LAUNCHER=claude:{SID}\nexport SIGNALBOX_LAUNCHER=claude:{SID}\n")

    def test_runs_no_agent_launched_are_not_reported(self):
        posted, _ = self.run_hook("SessionStart", env={"CLAUDE_CODE_ENTRYPOINT": "cli"})
        self.assertEqual(posted, [])
        # Paseo's own Claude agents run through the Agent SDK: Paseo shows those itself.
        posted, _ = self.run_hook("SessionStart", env={"PASEO_AGENT_ID": AGENT, "CLAUDE_CODE_ENTRYPOINT": "sdk-ts"})
        self.assertEqual(posted, [])
        # A run never names itself as its launcher.
        posted, _ = self.run_hook("SessionStart", env={"SIGNALBOX_LAUNCHER": f"claude:{SID}"})
        self.assertEqual(posted, [])

    def test_prints_nothing_and_never_raises(self):
        with mock.patch.dict(os.environ, {"PASEO_AGENT_ID": AGENT}, clear=True), \
                mock.patch.object(hook, "post", side_effect=OSError("down")), \
                mock.patch("sys.stdin", io.StringIO(json.dumps({"hook_event_name": "Stop", "session_id": SID}))), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            hook.main()
        self.assertEqual(out.getvalue(), "")
        with mock.patch("sys.stdin", io.StringIO("not json")), contextlib.redirect_stdout(io.StringIO()) as out:
            hook.main()
        self.assertEqual(out.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
