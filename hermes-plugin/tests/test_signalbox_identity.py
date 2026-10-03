"""Tests for the signalbox-identity Hermes plugin.

Plain unittest, so they run on Hermes' own interpreter (which has no pytest). Run them as the user
Hermes runs as, through Hermes' launcher so its dependencies are on the path:

    hermes --run-module unittest discover -s <signalbox>/hermes-plugin/tests -v

Without Hermes on the path only the hook tests run; the ones that load the plugin through Hermes'
plugin manager and dispatch a real ``pre_tool_call`` are skipped. pytest can collect them too.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

PLUGIN_DIR = Path(__file__).resolve().parent.parent / "signalbox-identity"
PLUGIN_KEY = "signalbox-identity"
DASHBOARD_ID = "20260927_101500_ab12cd"  # tui_gateway: new_session_id(), 6 hex
GATEWAY_ID = "20260927_101500_ab12cd34"  # messaging gateway: 8 hex


def _load_plugin_module():
    spec = importlib.util.spec_from_file_location("signalbox_identity_under_test", PLUGIN_DIR / "__init__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plugin = _load_plugin_module()


def _without_paseo():
    env = {k: v for k, v in os.environ.items() if k != "PASEO_AGENT_ID"}
    return mock.patch.dict(os.environ, env, clear=True)


class HookTests(unittest.TestCase):
    def setUp(self):
        patcher = _without_paseo()
        patcher.start()
        self.addCleanup(patcher.stop)

    def call(self, tool_name="mcp__signalbox__list_chats", session_id=DASHBOARD_ID, **extra):
        payload = {"tool_name": tool_name, "args": {"project": "/srv/app"}, "session_id": session_id,
                   "task_id": "task", "tool_call_id": "call_1", "turn_id": "turn", "api_request_id": "req",
                   "middleware_trace": [], "telemetry_schema_version": 1}
        payload.update(extra)
        return plugin.on_pre_tool_call(**payload)

    def test_adds_the_stored_session_id_to_signalbox_tools(self):
        for tool in ("list_chats", "read_chat", "send_message", "start_chat", "wait_for_reply"):
            with self.subTest(tool=tool):
                self.assertEqual(
                    self.call(tool_name=f"mcp__signalbox__{tool}"),
                    {"action": "modify", "args": {"_signalbox_caller": DASHBOARD_ID}},
                )

    def test_gateway_session_ids_count_too(self):
        self.assertEqual(self.call(session_id=GATEWAY_ID)["args"], {"_signalbox_caller": GATEWAY_ID})

    def test_other_tools_are_left_alone(self):
        for tool in ("terminal", "write_file", "tool_call", "mcp__other__list_chats", "mcp__signalboxx__list_chats",
                     "mcp_signalbox_list_chats", "MCP__SIGNALBOX__list_chats", "", None, 42):
            with self.subTest(tool=tool):
                self.assertIsNone(self.call(tool_name=tool))

    def test_does_nothing_when_paseo_runs_this_hermes(self):
        with mock.patch.dict(os.environ, {"PASEO_AGENT_ID": "demo-paseo-agent"}):
            self.assertIsNone(self.call())
        with mock.patch.dict(os.environ, {"PASEO_AGENT_ID": "  "}):  # blank counts as unset
            self.assertIsNotNone(self.call())

    def test_leaves_the_call_alone_without_a_stored_session_id(self):
        for session_id in ("", None, 20260927, "a1b2c3d4", "bg_1a2b3c", "4f5e2d6c-1b1a-4c1e-9a55-0c2f3e4d5a6b",
                           "20260927_101500_", "20260927_101500_ab12cd\n", " 20260927_101500_ab12cd",
                           "20260927_101500_ab12cd/../x", "20260927_101500_" + "a" * 65, "agent:main:telegram:dm:1"):
            with self.subTest(session_id=session_id):
                self.assertIsNone(self.call(session_id=session_id))

    def test_missing_arguments_are_fine(self):
        self.assertIsNone(plugin.on_pre_tool_call())
        self.assertIsNone(plugin.on_pre_tool_call(tool_name="mcp__signalbox__list_chats"))

    def test_never_raises(self):
        with mock.patch.object(plugin, "caller_directive", side_effect=RuntimeError("boom")):
            self.assertIsNone(self.call())

    def test_register_adds_the_caller_and_launch_hooks(self):
        ctx = mock.Mock()
        plugin.register(ctx)
        self.assertEqual(
            ctx.register_hook.call_args_list,
            [mock.call("pre_tool_call", plugin.on_pre_tool_call), mock.call("on_session_start", plugin.on_session_start)],
        )


def _hermes_available() -> bool:
    try:
        return importlib.util.find_spec("hermes_cli.plugins") is not None
    except (ImportError, ValueError):
        return False


class _ThrowawayHermesHome:
    """Loads the plugin from a throwaway HERMES_HOME through Hermes' real plugin manager."""

    enabled = True  # list the plugin in plugins.enabled

    def setUp(self):
        from hermes_cli import plugins as plugins_mod

        self.plugins_mod = plugins_mod
        self.tmp = Path(tempfile.mkdtemp(prefix="signalbox-identity-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        home = self.tmp / "hermes-home"
        shutil.copytree(PLUGIN_DIR, home / "plugins" / PLUGIN_KEY, ignore=shutil.ignore_patterns("__pycache__"))
        config = f"plugins:\n  enabled:\n    - {PLUGIN_KEY}\n" if self.enabled else "plugins: {}\n"
        (home / "config.yaml").write_text(config, encoding="utf-8")
        (self.tmp / "bundled").mkdir()

        env = {k: v for k, v in os.environ.items() if k != "PASEO_AGENT_ID"}
        env["HERMES_HOME"] = str(home)
        for patcher in (mock.patch.dict(os.environ, env, clear=True),
                        mock.patch.object(plugins_mod, "get_bundled_plugins_dir", lambda: self.tmp / "bundled")):
            patcher.start()
            self.addCleanup(patcher.stop)
        plugins_mod._reset_plugin_managers_for_tests()
        self.addCleanup(plugins_mod._reset_plugin_managers_for_tests)
        plugins_mod.discover_plugins(force=True)

    def dispatch(self, tool_name, args, session_id=DASHBOARD_ID):
        return self.plugins_mod._dispatch_pre_tool_call_hooks(
            tool_name, args, task_id="task", session_id=session_id, tool_call_id="call_1", turn_id="turn",
            api_request_id="req", middleware_trace=[])


_NEEDS_HERMES = unittest.skipUnless(_hermes_available(), "Hermes isn't importable: run through `hermes --run-module`")


@_NEEDS_HERMES
class HermesRuntimeTests(_ThrowawayHermesHome, unittest.TestCase):
    def test_loads_as_an_enabled_user_plugin_with_its_hooks(self):
        loaded = self.plugins_mod.get_plugin_manager()._plugins[PLUGIN_KEY]
        self.assertTrue(loaded.enabled, loaded.error)
        self.assertEqual(loaded.manifest.source, "user")
        self.assertEqual(loaded.manifest.kind, "standalone")
        self.assertEqual(loaded.manifest.capabilities, [])
        self.assertEqual(loaded.hooks_registered, ["pre_tool_call", "on_session_start"])

    def test_signalbox_calls_get_the_hidden_argument(self):
        block, args = self.dispatch("mcp__signalbox__send_message", {"chat": "hermes:x", "text": "hi"})
        self.assertIsNone(block)
        self.assertEqual(args, {"chat": "hermes:x", "text": "hi", "_signalbox_caller": DASHBOARD_ID})

    def test_a_value_the_model_made_up_is_replaced(self):
        _, args = self.dispatch("mcp__signalbox__list_chats", {"_signalbox_caller": "20200101_000000_ffffff"})
        self.assertEqual(args, {"_signalbox_caller": DASHBOARD_ID})

    def test_other_calls_are_untouched(self):
        self.assertEqual(self.dispatch("terminal", {"command": "ls"}), (None, None))
        self.assertEqual(self.dispatch("mcp__signalbox__list_chats", {}, session_id=""), (None, None))
        with mock.patch.dict(os.environ, {"PASEO_AGENT_ID": "demo-paseo-agent"}):
            self.assertEqual(self.dispatch("mcp__signalbox__list_chats", {}), (None, None))

    def test_the_agent_loop_passes_agent_session_id_and_applies_the_change(self):
        """agent/tool_executor._pre_tool_block is where the agent loop fires the hook for MCP tools."""
        from agent import tool_executor

        agent = SimpleNamespace(session_id=DASHBOARD_ID, _current_turn_id="turn", _current_api_request_id="req")
        ref = SimpleNamespace(name="mcp__signalbox__read_chat", args={"chat": "paseo:abc"}, task_id="runtime-task",
                              call_id="call_1", trace=[])
        block, args = tool_executor._pre_tool_block(agent, ref)
        self.assertIsNone(block)
        self.assertEqual(args, {"chat": "paseo:abc", "_signalbox_caller": DASHBOARD_ID})


@_NEEDS_HERMES
class HermesRuntimeNotEnabledTests(_ThrowawayHermesHome, unittest.TestCase):
    """Plugins are opt-in: installed but not listed in plugins.enabled, it must not load."""

    enabled = False

    def test_is_not_loaded(self):
        loaded = self.plugins_mod.get_plugin_manager()._plugins[PLUGIN_KEY]
        self.assertFalse(loaded.enabled)
        self.assertEqual(loaded.hooks_registered, [])
        self.assertEqual(self.dispatch("mcp__signalbox__send_message", {"chat": "hermes:x", "text": "hi"}), (None, None))


class LaunchReportTests(unittest.TestCase):
    """on_session_start: which agent's shell started this Hermes process."""

    PI = "0c1a0de0-0000-4000-8000-000000000002"
    RUN = "0c1a0de0-0000-4000-8000-000000000003"

    def setUp(self):
        patcher = mock.patch.dict(os.environ, {"WAYROOST_ROLE": "primary"}, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        plugin._reported = False

    def _environ_file(self, pairs):
        fd, path = tempfile.mkstemp()
        with os.fdopen(fd, "wb") as f:
            f.write(b"\0".join(f"{k}={v}".encode() for k, v in pairs) + b"\0")
        self.addCleanup(os.unlink, path)
        return path

    def test_reads_only_launch_variables_from_the_starting_environment(self):
        path = self._environ_file([("HOME", "/home/me"), ("PASEO_AGENT_ID", self.PI), ("SECRET_TOKEN", "x" * 40)])
        self.assertEqual(plugin.initial_environ(path), {"PASEO_AGENT_ID": self.PI})
        self.assertEqual(plugin.initial_environ("/nonexistent/environ"), {})

    def test_candidates_are_well_formed_and_never_the_chat_itself(self):
        env = {"SIGNALBOX_LAUNCHER": f"claude:{self.RUN}", "HERMES_SESSION_ID": DASHBOARD_ID, "PASEO_AGENT_ID": self.PI}
        self.assertEqual(
            plugin.launch_candidates(env),
            [{"kind": "claude", "id": self.RUN}, {"kind": "hermes", "id": DASHBOARD_ID}, {"kind": "paseo", "id": self.PI}],
        )
        self.assertEqual(plugin.launch_candidates({"HERMES_SESSION_ID": DASHBOARD_ID}, own_id=DASHBOARD_ID), [])
        bad = {"SIGNALBOX_LAUNCHER": "claude:../../x", "HERMES_SESSION_ID": "runtime-uuid", "PASEO_AGENT_ID": "not a uuid"}
        self.assertEqual(plugin.launch_candidates(bad), [])

    def test_reports_the_first_chat_once_and_never_under_acp(self):
        env = {"PASEO_AGENT_ID": self.PI}
        with mock.patch.object(plugin, "initial_environ", return_value=env), mock.patch.object(plugin, "_post") as post:
            plugin.on_session_start(session_id=GATEWAY_ID, model="m", platform="cli")
            plugin.on_session_start(session_id=DASHBOARD_ID, model="m", platform="cli")  # a later chat: its child
            post.assert_called_once()
            tool, body = post.call_args.args
            self.assertEqual(tool, "note_launch")
            self.assertEqual(body["child"], GATEWAY_ID)
            self.assertEqual(body["candidates"], [{"kind": "paseo", "id": self.PI}])
        plugin._reported = False
        with mock.patch.object(plugin, "initial_environ", return_value=env), mock.patch.object(plugin, "_post") as post, \
                mock.patch.object(plugin.sys, "argv", ["/home/me/.local/bin/hermes-acp"]):
            plugin.on_session_start(session_id=GATEWAY_ID)
            post.assert_not_called()

    def test_nothing_named_nothing_sent_and_failures_never_raise(self):
        with mock.patch.object(plugin, "initial_environ", return_value={}), mock.patch.object(plugin, "_post") as post:
            plugin.on_session_start(session_id=GATEWAY_ID)
            post.assert_not_called()
        plugin._reported = False
        with mock.patch.object(plugin, "initial_environ", return_value={"PASEO_AGENT_ID": self.PI}), \
                mock.patch.object(plugin, "_post", side_effect=OSError("bridge down")):
            self.assertIsNone(plugin.on_session_start(session_id=GATEWAY_ID))
        with mock.patch.object(plugin, "_bridge_token", return_value=None):
            self.assertIsNone(plugin._post("note_launch", {}))


class IsolatedInstallTests(unittest.TestCase):
    def test_folder_only_copy_keeps_identity_without_runtime_and_never_reports(self):
        with tempfile.TemporaryDirectory(prefix="wayroost-plugin-test-") as folder:
            target = Path(folder) / "signalbox-identity"
            shutil.copytree(PLUGIN_DIR, target, ignore=shutil.ignore_patterns("__pycache__"))
            code = """
import importlib.util, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('isolated_plugin', sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
assert plugin.on_pre_tool_call(tool_name='mcp__signalbox__list_chats', session_id='00000000_000000_fake')
with patch.object(plugin, '_post') as post:
    plugin.on_session_start('00000000_000000_fake')
    post.assert_not_called()
"""
            result = subprocess.run([sys.executable, "-I", "-c", code, str(target / "__init__.py")],
                                    env={"PATH": os.defpath, "WAYROOST_ROLE": "primary"},
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    sys.exit(unittest.main())
