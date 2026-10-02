#!/usr/bin/env python3
"""Claude Code hook: tell Signalbox about `claude -p` runs that agents start, so they show under the agent.

Registered for SessionStart, UserPromptSubmit, Stop and SessionEnd in the agent user's
~/.claude/settings.json (deploy/setup-bridge.sh does it). Reads the hook's JSON from stdin and,
only for a run an agent launched, posts to the Signalbox bridge on this machine:

  start   the launchers its environment names: PASEO_AGENT_ID (a Paseo agent), HERMES_SESSION_ID
          (a Hermes chat's terminal), SIGNALBOX_LAUNCHER=claude:<id> (a Claude run that ran it),
          plus its folder. It also writes SIGNALBOX_LAUNCHER=claude:<own id> to CLAUDE_ENV_FILE, so
          what this run starts in turn names it.
  prompt  the first prompt (the task), clipped.
  stop    the answer: the last assistant text, as Claude Code hands it over (or, from older
          versions, as the transcript has it so far), clipped.
  end     the session ended, with the answer read from the transcript: by then it is on disk,
          which at Stop it may not be yet.

A session no agent launched (no launcher in its environment) is never reported, nor is one run
through the Agent SDK (Paseo's own Claude agents: Paseo shows those itself). Prints nothing:
Claude Code adds a SessionStart or UserPromptSubmit hook's output to the conversation. Always exits
0, waits at most a second for Signalbox, sends only to 127.0.0.1, and never logs.
"""
import json
import os
import re
import sys
import time
import urllib.request

BRIDGE = "http://127.0.0.1:8792/bridge/v1/note_run"
TOKEN_FILE = os.path.expanduser("~/.config/signalbox/bridge-token")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
HERMES_ID = re.compile(r"\d{8}_\d{6}_[0-9A-Za-z]{1,64}")
EVENTS = {"SessionStart": "start", "UserPromptSubmit": "prompt", "Stop": "stop", "SessionEnd": "end"}
MAX_TASK, MAX_FINAL = 4000, 16000
TAIL_BYTES = 4 << 20  # the answer is near the end; a long run's transcript needn't be read whole


def candidates(env, own_id):
    found = []
    launcher = env.get("SIGNALBOX_LAUNCHER", "").strip()
    if launcher.startswith("claude:") and UUID.fullmatch(launcher[7:]) and launcher[7:] != own_id:
        found.append({"kind": "claude", "id": launcher[7:]})
    session = env.get("HERMES_SESSION_ID", "").strip()
    if HERMES_ID.fullmatch(session):
        found.append({"kind": "hermes", "id": session})
    agent = env.get("PASEO_AGENT_ID", "").strip()
    if UUID.fullmatch(agent):
        found.append({"kind": "paseo", "id": agent})
    return found


def launched_by_agent(env, own_id):
    """A run an agent started: a launcher in its environment, and not an Agent SDK session."""
    entrypoint = env.get("CLAUDE_CODE_ENTRYPOINT", "")
    if entrypoint.startswith("sdk-") and entrypoint != "sdk-cli":
        return False
    return bool(candidates(env, own_id))


def last_assistant_text(transcript_path):
    """The final answer: text of the last assistant message in the session transcript."""
    try:
        with open(transcript_path, "rb") as f:
            f.seek(max(0, f.seek(0, os.SEEK_END) - TAIL_BYTES))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return ""
    for line in reversed(lines):  # a line cut by the seek doesn't parse and is skipped
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = entry.get("message") if isinstance(entry, dict) else None
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = message.get("content")
        if isinstance(content, str):
            text = content
        else:
            text = "\n".join(p.get("text", "") for p in content or [] if isinstance(p, dict) and p.get("type") == "text")
        if text.strip():
            return text.strip()[:MAX_FINAL]
    return ""


def post(body):
    try:
        with open(TOKEN_FILE, encoding="ascii") as f:
            token = f.read().strip()
    except (OSError, UnicodeDecodeError):
        return
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,512}", token):
        return
    request = urllib.request.Request(BRIDGE, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback only, never a proxy
    with opener.open(request, timeout=1.0) as response:
        response.read()


def main():
    event = None
    try:
        data = json.loads(sys.stdin.read() or "{}")
        event = EVENTS.get(data.get("hook_event_name", ""))
        session = str(data.get("session_id", ""))
        if not event or not UUID.fullmatch(session) or not launched_by_agent(os.environ, session):
            return
        body = {"session": session, "event": event}
        if event == "start":
            body["candidates"] = candidates(os.environ, session)
            cwd = data.get("cwd") or os.getcwd()
            if isinstance(cwd, str) and cwd.startswith("/"):
                body["cwd"] = cwd[:4096]
            entrypoint = os.environ.get("CLAUDE_CODE_ENTRYPOINT", "")
            if entrypoint:
                body["entrypoint"] = entrypoint[:40]
            body["started_at"] = time.time()
            env_file = os.environ.get("CLAUDE_ENV_FILE")
            if env_file:
                with open(env_file, "a", encoding="utf-8") as f:
                    f.write(f"export SIGNALBOX_LAUNCHER=claude:{session}\n")
        elif event == "prompt":
            prompt = data.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip():
                return
            body["task"] = prompt.strip()[:MAX_TASK]
        else:  # stop, end
            final = data.get("last_assistant_message") if event == "stop" else None
            if not isinstance(final, str) or not final.strip():
                final = last_assistant_text(str(data.get("transcript_path", "")))
            if final.strip():
                body["final"] = final.strip()[:MAX_FINAL]
        post(body)
    except Exception:
        return  # never disturb the run


if __name__ == "__main__":
    main()
    sys.exit(0)
