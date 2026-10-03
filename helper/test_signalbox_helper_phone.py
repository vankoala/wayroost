"""Tests for the helper's phone line status (python3 -m unittest helper/test_signalbox_helper_phone.py).

The server counts calls for "restart when idle" from this status, so it must tell a
line that is off (no calls can be up) from one that didn't answer (calls unknown).
"""

import importlib.util
import io
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="sb-helper-")
_SPEC = importlib.util.spec_from_file_location("signalbox_helper", Path(__file__).resolve().parent / "signalbox-helper.py")
H = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(H)


class _Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def answers(health: dict | Exception):
    """urlopen as the phone server would answer: /health as given, /settings/pin set."""

    def urlopen(req, timeout=None):
        if req.full_url.endswith("/health"):
            if isinstance(health, Exception):
                raise health
            return _Reply(json.dumps(health).encode())
        return _Reply(json.dumps({"set": True, "owner_number": None}).encode())

    return urlopen


class PhoneStatus(unittest.TestCase):
    def status(self, health):
        with mock.patch("urllib.request.urlopen", answers(health)), mock.patch.object(H, "_phone_token", lambda: "x" * 16):
            return H.phone_status()

    def test_a_refused_port_means_the_line_is_off(self):
        refused = urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
        self.assertEqual(self.status(refused), {"running": False, "ok": False, "pinSet": False, "off": True})

    def test_no_answer_is_not_off(self):
        for err in (TimeoutError("timed out"), urllib.error.URLError(TimeoutError("timed out")), urllib.error.URLError(OSError("unreachable"))):
            with self.subTest(err=repr(err)):
                status = self.status(err)
                self.assertFalse(status["running"])
                self.assertNotIn("off", status)
                self.assertNotIn("activeCalls", status)

    def test_passes_on_the_call_count_the_line_gave(self):
        status = self.status({"ok": True, "active_calls": 2, "total_calls": 7})
        self.assertEqual((status["running"], status["activeCalls"], status["totalCalls"]), (True, 2, 7))
        self.assertEqual(self.status({"ok": True, "active_calls": 0})["activeCalls"], 0)

    def test_a_missing_count_is_not_zero(self):
        for health in ({"ok": True}, {"ok": True, "active_calls": None}, {"ok": True, "active_calls": "1"}, {"ok": True, "active_calls": True}):
            with self.subTest(health=health):
                status = self.status(health)
                self.assertTrue(status["running"])
                self.assertNotIn("activeCalls", status)


if __name__ == "__main__":
    unittest.main()
