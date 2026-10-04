"""Environment aliases and the unattended-work gate for Wayroost's helper processes."""

import json
import os
import re
import sys
from pathlib import Path

_warned = set()


def env(suffix: str, default=None, environ=None):
    environ = os.environ if environ is None else environ
    name, legacy = f"WAYROOST_{suffix}", f"SIGNALBOX_{suffix}"
    if name in environ:
        return environ[name]
    if legacy in environ:
        if legacy not in _warned:
            _warned.add(legacy)
            print(f"Wayroost: {legacy} is deprecated; use {name}.", file=sys.stderr)
        return environ[legacy]
    return default


def bridge_url() -> str:
    """The installed bridge address, with environment overrides and loopback-only validation."""
    url = env("BRIDGE_URL")
    if url is None:
        path = Path.home() / ".config" / "signalbox" / "bridge-url"
        try:
            url = path.read_text(encoding="ascii").strip()
        except FileNotFoundError:
            url = "http://127.0.0.1:19012"
    match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{1,5})/?", url)
    if not match or not 1 <= int(match[1]) <= 65535:
        raise ValueError("The bridge URL must be an HTTP address on 127.0.0.1 with a valid port")
    return url.rstrip("/")


def configured_role(default_config=None) -> str:
    try:
        override = env("ROLE")
        path = env("CONFIG")
        scoped = override is None and path is None and default_config is not None
        if scoped:
            path = default_config
        if override is None and path is None:
            raise ValueError("WAYROOST_ROLE / WAYROOST_CONFIG is required for this process")
        role = "primary"
        if path is not None:
            role = json.loads(Path(path).read_text()).get("role", None if scoped else "primary")
        if role not in {"shadow", "primary"} or override not in {None, "shadow", "primary"}:
            raise ValueError("WAYROOST_ROLE / SIGNALBOX_ROLE or config role must be shadow or primary")
        return "shadow" if role == "shadow" or override == "shadow" else "primary"
    except Exception:
        if "role-resolution" not in _warned:
            _warned.add("role-resolution")
            print("Wayroost: cannot resolve role from ROLE / CONFIG; background work is off (shadow).", file=sys.stderr)
        return "shadow"


class BackgroundGate:
    def __init__(self, role=None, default_config=None):
        resolved = configured_role(default_config) if role is None else role
        self.role = "primary" if resolved == "primary" else "shadow"

    def run(self, work):
        if self.role == "primary":
            return work()
        return None
