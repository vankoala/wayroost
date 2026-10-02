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

    def run_hook(self, event, env=None, **fields):
        """Run the hook as Claude Code would; returns the bodies it posted and what it printed."""
        data = {"hook_event_name": event, "session_id": SID, "cwd": "/home/me/app", **fields}
        env = {"PASEO_AGENT_ID": AGENT, "CLAUDE_CODE_ENTRYPOINT": "sdk-cli"} if env is None else env
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
        self.assertEqual(env_file.read_text(), f"export SIGNALBOX_LAUNCHER=claude:{SID}\n")

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
