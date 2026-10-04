"""signalbox-identity: tell the Signalbox project bridge which Hermes chat is calling it.

Hermes starts one Signalbox bridge (an MCP stdio server) per process and shares it across its
chats, so the bridge can't tell which chat made a call. This plugin's ``pre_tool_call`` hook adds
the calling chat's stored session id (the id Hermes stores and the dashboard lists, like
``20260927_101500_ab12cd``) to every ``mcp__signalbox__*`` call as the hidden argument
``_signalbox_caller``. The bridge removes it and passes it to Signalbox as the
``X-Bridge-Hermes-Session`` header.

The hook receives that id as its ``session_id`` argument (``agent.session_id``; in the dashboard
it is the chat's stored key, not the connection's runtime id). The hook never raises, because
Hermes blocks any tool call whose ``pre_tool_call`` hook fails. It leaves the arguments alone
when there is no stored session id, and in Hermes agents that Paseo runs (``PASEO_AGENT_ID`` is
set there, and the bridge identifies those by it).

It also reports launches (``on_session_start``): when a shell started this Hermes process, for
example an agent running ``hermes chat --oneshot``, the environment it started with names its
launchers: ``PASEO_AGENT_ID`` (a Paseo agent), ``HERMES_SESSION_ID`` (a Hermes chat's terminal)
and ``SIGNALBOX_LAUNCHER=claude:<session>`` (a Claude Code run, set by Signalbox's Claude hook).
The plugin sends those ids, never anything else, to the bridge, so Signalbox can fold the chat
under the agent that started it. It reads them from ``/proc/self/environ``, because Hermes
replaces ``HERMES_SESSION_ID`` with the new chat's own id; it reports once per process (the first
chat, not delegate_task children or compression continuations), never for Hermes run by Paseo
(ACP), waits at most a second, and never raises.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

_runtime_dir = Path(__file__).resolve().parent
if not (_runtime_dir / "wayroost_runtime.py").is_file():
    _runtime_dir = _runtime_dir.parent.parent / "helper"
sys.path.insert(0, str(_runtime_dir))
try:
    if not (_runtime_dir / "wayroost_runtime.py").is_file():
        raise ImportError("Wayroost runtime is missing")
    from wayroost_runtime import BackgroundGate, bridge_url, env as runtime_env  # noqa: E402
except ImportError:
    BackgroundGate = None
    bridge_url = None

    def runtime_env(suffix, default=None, environ=None):
        environ = os.environ if environ is None else environ
        return environ.get(f"WAYROOST_{suffix}", environ.get(f"SIGNALBOX_{suffix}", default))

TOOL_PREFIX = "mcp__signalbox__"
CALLER_ARG = "_signalbox_caller"

# Hermes' stored session ids: "<YYYYMMDD>_<HHMMSS>_<hex>" (hermes_state_ids.new_session_id).
# Anything else (a runtime id, an ACP uuid, a "bg_" side agent) is not a chat Signalbox lists.
_STORED_SESSION_ID = re.compile(r"\d{8}_\d{6}_[0-9A-Za-z]{1,64}", re.ASCII)


def caller_directive(tool_name: Any = "", session_id: Any = "") -> Optional[Dict[str, Any]]:
    """The ``modify`` directive for one call, or ``None`` to leave it alone."""
    if not isinstance(tool_name, str) or not tool_name.startswith(TOOL_PREFIX):
        return None
    if os.environ.get("PASEO_AGENT_ID", "").strip():
        return None
    if not isinstance(session_id, str) or not _STORED_SESSION_ID.fullmatch(session_id):
        return None
    return {"action": "modify", "args": {CALLER_ARG: session_id}}


def on_pre_tool_call(tool_name: Any = "", args: Any = None, session_id: Any = "", **_: Any) -> Optional[Dict[str, Any]]:
    """``pre_tool_call`` hook. ``args`` is unused: Hermes merges the returned keys into it."""
    try:
        return caller_directive(tool_name, session_id)
    except Exception:  # never block a tool call over identity
        return None


_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.ASCII)
_LAUNCH_VARS = (b"WAYROOST_LAUNCHER", b"SIGNALBOX_LAUNCHER", b"HERMES_SESSION_ID", b"PASEO_AGENT_ID")
_reported = False


def initial_environ(path: str = "/proc/self/environ") -> Dict[str, str]:
    """The launch variables this process started with (later changes to os.environ don't show here)."""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return {}
    env: Dict[str, str] = {}
    for item in raw.split(b"\0"):
        key, sep, value = item.partition(b"=")
        if sep and key in _LAUNCH_VARS:
            env[key.decode()] = value.decode("utf-8", "replace").strip()
    return env


def launch_candidates(env: Dict[str, str], own_id: str = "") -> List[Dict[str, str]]:
    """Launchers named in ``env``, well-formed ones only; the chat's own id is never its launcher."""
    found: List[Dict[str, str]] = []
    launcher = runtime_env("LAUNCHER", "", env)
    if launcher.startswith("claude:") and _UUID.fullmatch(launcher[7:]):
        found.append({"kind": "claude", "id": launcher[7:]})
    session = env.get("HERMES_SESSION_ID", "")
    if _STORED_SESSION_ID.fullmatch(session) and session != own_id:
        found.append({"kind": "hermes", "id": session})
    agent = env.get("PASEO_AGENT_ID", "")
    if _UUID.fullmatch(agent):
        found.append({"kind": "paseo", "id": agent})
    return found


def _is_acp() -> bool:
    """Hermes that Paseo runs over ACP: it IS the agent in PASEO_AGENT_ID, nothing launched it from a shell."""
    return any("acp" in os.path.basename(str(arg)) for arg in sys.argv[:2])


def _bridge_token() -> Optional[str]:
    path = runtime_env("BRIDGE_TOKEN_FILE") or os.path.expanduser("~/.config/signalbox/bridge-token")
    try:
        with open(path, encoding="ascii") as f:
            token = f.read().strip()
    except (OSError, UnicodeDecodeError):
        return None
    return token if re.fullmatch(r"[A-Za-z0-9_-]{32,512}", token) else None


def _post(tool: str, body: Dict[str, Any], timeout: float = 1.0) -> None:
    if bridge_url is None:
        return
    url = bridge_url()
    token = _bridge_token()
    if not token:
        return
    request = urllib.request.Request(
        f"{url}/bridge/v1/{tool}",
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    # No proxies: the report goes to this machine's loopback or nowhere.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=timeout) as response:
        response.read()


def on_session_start(session_id: Any = "", **_: Any) -> None:
    """``on_session_start`` hook: report which agent's shell started this Hermes process, once."""
    global _reported
    try:
        if BackgroundGate is None or not BackgroundGate(default_config=Path(__file__).with_name("wayroost-role.json")).run(lambda: True):
            return
        if _reported or not isinstance(session_id, str) or not _STORED_SESSION_ID.fullmatch(session_id) or _is_acp():
            return
        _reported = True  # the first chat only: later ones in this process are its own children
        candidates = launch_candidates(initial_environ(), session_id)
        if candidates:
            _post("note_launch", {"child": session_id, "candidates": candidates, "started_at": time.time()})
    except Exception:  # never disturb a session over a report
        return


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    ctx.register_hook("on_session_start", on_session_start)
