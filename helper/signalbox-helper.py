#!/usr/bin/env python3
"""Signalbox helper: the few Connectors jobs Signalbox itself can't do.

Signalbox runs locked away from the home directory, so this small service,
running as the Hermes owner and listening on 127.0.0.1 only, does them:

* Google (Gmail, Calendar, Drive): status, sign-in and sign-out through the
  Hermes Google Workspace skill's own setup script.
* Triggers: the folder each mail trigger keeps its Gmail search and what it
  has seen in, and the gate script Hermes' scheduler runs before waking a model.
* WhatsApp routing: the settings file of the whatsapp-routing Hermes plugin,
  which reads it on every message (no restart).
* Skills (Settings → Skills): every agent's skill folders, kept the same as the shared
  folder; see signalbox_skills.py.
* Phone (Hermes Phone): whether the line is up, and its PIN. The PIN lives in
  the encrypted vault; the phone server reads and writes it, and this helper reaches the
  server's local /settings/pin with the phone-admin token it reads from the vault.

Every request needs the bearer token systemd hands both services
(LoadCredential). Standard library only. Never logs request bodies, tokens,
Google output or mail.
"""

import glob
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import signalbox_skills  # noqa: E402
from wayroost_runtime import BackgroundGate, env  # noqa: E402

HOST = "127.0.0.1"
PORT = int(env("HELPER_PORT", "19013"))
HERMES_HOME = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
SKILL_SCRIPTS = HERMES_HOME / "skills" / "productivity" / "google-workspace" / "scripts"
TRIGGERS_DIR = HERMES_HOME / "signalbox-triggers"
GATE_NAME = "wayroost_mail_trigger.py"
GATE_SOURCE = Path(__file__).resolve().parent / "signalbox_mail_trigger.py"
MAX_BODY = 16 * 1024
SHADOW_API_PREFIX = "/v1/shadow/"
TRIGGER_ID = re.compile(r"^[a-z0-9]{8,32}$")
# What Google redirects to after sign-in (the skill's fixed "paste it back" address).
GOOGLE_REDIRECT = re.compile(r"^http://localhost:1/?\?[\x21-\x7e]{1,4000}$")
PROFILE_TTL = 600
# The shopping Chrome's DevTools endpoint (optional): only /json/version is ever asked, to see it's up.
SHOP_CDP = env("SHOP_CDP", "").rstrip("/")


def log(msg: str, **fields) -> None:
    print(json.dumps({"msg": msg, **fields}), flush=True)


def read_token() -> str:
    cred_dir = os.environ.get("CREDENTIALS_DIRECTORY")
    path = Path(cred_dir) / "token" if cred_dir else None
    if not path or not path.is_file():
        sys.exit("signalbox-helper: no token credential (LoadCredential=token:...)")
    token = path.read_text().strip()
    if len(token) < 32:
        sys.exit("signalbox-helper: the token credential is too short")
    return token


def hermes_python() -> str | None:
    """The newest Hermes environment that has the Google libraries (the path changes on update)."""
    candidates = sorted(
        glob.glob(str(HERMES_HOME / "installs" / "*" / "environments" / "*" / "venv" / "bin" / "python")),
        key=lambda p: os.path.getmtime(p),
        reverse=True,
    )
    for python in candidates:
        probe = subprocess.run(
            [python, "-c", "import google.oauth2, googleapiclient"],
            capture_output=True, timeout=30, env=skill_env(),
        )
        if probe.returncode == 0:
            return python
    return None


def skill_env() -> dict:
    env = {k: v for k, v in os.environ.items() if k in {"PATH", "LANG", "LC_ALL", "HOME", "USER", "TZ"}}
    env["HERMES_HOME"] = str(HERMES_HOME)
    # The skill imports Hermes' package manager module to check its dependencies.
    env["PYTHONPATH"] = str(HERMES_HOME / "hermes-agent")
    return env


_python_lock = threading.Lock()
_python: dict = {"path": None, "at": 0.0}


def python_for_skill() -> str:
    with _python_lock:
        if not _python["path"] or time.time() - _python["at"] > 3600 or not os.path.exists(_python["path"]):
            _python["path"] = hermes_python()
            _python["at"] = time.time()
        if not _python["path"]:
            raise HelperError(503, "Hermes' Python with the Google libraries wasn't found.")
        return _python["path"]


class HelperError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def run_setup(*args: str, timeout: int = 60) -> subprocess.CompletedProcess:
    setup = SKILL_SCRIPTS / "setup.py"
    if not setup.is_file():
        raise HelperError(503, "The Hermes Google Workspace skill isn't installed.")
    try:
        return subprocess.run(
            [python_for_skill(), str(setup), *args],
            capture_output=True, text=True, timeout=timeout, env=skill_env(), cwd=str(SKILL_SCRIPTS),
        )
    except subprocess.TimeoutExpired:
        raise HelperError(504, "Google didn't answer in time. Try again.")


# ---- Google -------------------------------------------------------------------

_profile: dict = {"email": None, "at": 0.0}

PROFILE_CODE = """
import json, sys
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
creds = Credentials.from_authorized_user_file(sys.argv[1])
print(json.dumps({"email": build("gmail", "v1", credentials=creds, cache_discovery=False).users().getProfile(userId="me").execute().get("emailAddress")}))
"""


def google_account() -> str | None:
    """The signed-in Gmail address, cached for a few minutes. None if Google won't say."""
    if _profile["email"] and time.time() - _profile["at"] < PROFILE_TTL:
        return _profile["email"]
    try:
        out = subprocess.run(
            [python_for_skill(), "-c", PROFILE_CODE, str(HERMES_HOME / "google_token.json")],
            capture_output=True, text=True, timeout=30, env=skill_env(),
        )
        email = json.loads(out.stdout.strip().splitlines()[-1]).get("email") if out.returncode == 0 else None
    except Exception:
        email = None
    if isinstance(email, str) and re.fullmatch(r"[^\s@]{1,200}@[^\s@]{1,200}", email):
        _profile.update(email=email, at=time.time())
        return email
    return None


def google_status() -> dict:
    if not (HERMES_HOME / "google_client_secret.json").is_file():
        return {"state": "not-connected", "detail": "No Google sign-in app is set up on the PC yet."}
    if not (HERMES_HOME / "google_token.json").is_file():
        return {"state": "not-connected"}
    out = run_setup("--check")
    text = out.stdout
    if out.returncode == 0:
        partial = "AUTHENTICATED (partial)" in text
        account = google_account()
        detail = f"Signed in as {account}" if account else "Signed in"
        if partial:
            detail += " · some permissions weren't granted"
        return {"state": "connected", "detail": detail}
    if "OAUTH_CLIENT_DISABLED" in text:
        return {"state": "needs-sign-in", "detail": "Google says the sign-in app or account is disabled."}
    if "TOKEN_REVOKED" in text:
        return {"state": "needs-sign-in", "detail": "The Google sign-in was revoked. Sign in again."}
    if "NOT_AUTHENTICATED" in text:
        return {"state": "not-connected"}
    return {"state": "needs-sign-in", "detail": "The Google sign-in stopped working. Sign in again."}


def google_start() -> dict:
    if not (HERMES_HOME / "google_client_secret.json").is_file():
        raise HelperError(409, "No Google sign-in app is set up on the PC yet.")
    out = run_setup("--auth-url")
    url = out.stdout.strip().splitlines()[-1] if out.stdout.strip() else ""
    if out.returncode != 0 or not url.startswith("https://accounts.google.com/"):
        raise HelperError(502, "Couldn't start the Google sign-in.")
    return {"url": url}


def google_finish(body: dict) -> dict:
    redirect = str(body.get("redirect") or "").strip()
    if not GOOGLE_REDIRECT.match(redirect):
        raise HelperError(400, "Paste the whole address the page landed on (it starts with http://localhost:1).")
    out = run_setup("--auth-code", redirect)
    if out.returncode != 0 or "OK: Authenticated" not in out.stdout:
        text = out.stdout + out.stderr
        if "state mismatch" in text.lower() or "No pending OAuth session" in text:
            raise HelperError(409, "That sign-in is out of date. Start again.")
        raise HelperError(502, "Google didn't accept that sign-in. Start again.")
    _profile.update(email=None, at=0.0)
    return google_status()


def google_disconnect() -> dict:
    run_setup("--revoke")
    _profile.update(email=None, at=0.0)
    return {"state": "not-connected"}


# ---- Triggers -----------------------------------------------------------------

def install_gate() -> None:
    """Keep Hermes' copy of the gate script identical to ours."""
    scripts = HERMES_HOME / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    runtime = GATE_SOURCE.with_name("wayroost_runtime.py")
    runtime_target = scripts / runtime.name
    if not runtime_target.exists() or runtime_target.read_bytes() != runtime.read_bytes():
        tmp_runtime = runtime_target.with_suffix(".tmp")
        shutil.copyfile(runtime, tmp_runtime)
        os.chmod(tmp_runtime, 0o644)
        os.replace(tmp_runtime, runtime_target)
    target = scripts / GATE_NAME
    if not target.exists() or target.read_bytes() != GATE_SOURCE.read_bytes():
        tmp = target.with_suffix(".tmp")
        shutil.copyfile(GATE_SOURCE, tmp)
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)
        log("gate script installed")


def trigger_dir(trigger_id: str) -> Path:
    if not TRIGGER_ID.match(trigger_id):
        raise HelperError(400, "Invalid trigger id.")
    return TRIGGERS_DIR / trigger_id


def list_triggers() -> dict:
    specs = {}
    if TRIGGERS_DIR.is_dir():
        for spec in TRIGGERS_DIR.glob("*/spec.json"):
            try:
                data = json.loads(spec.read_text())
                if TRIGGER_ID.match(spec.parent.name) and isinstance(data.get("query"), str):
                    specs[spec.parent.name] = {"query": data["query"], "role": "primary" if data.get("role") == "primary" else "shadow"}
            except Exception:
                continue
    return {"triggers": specs, "gate": GATE_NAME}


def process_background():
    return BackgroundGate(default_config=env("HELPER_ROLE_CONFIG", Path(__file__).with_name("wayroost-role.json")))


def put_trigger(trigger_id: str, body: dict, background=None) -> dict:
    query = str(body.get("query") or "").strip()
    if not query or len(query) > 500 or any(ord(c) < 32 for c in query):
        raise HelperError(400, "The Gmail search must be one line of up to 500 characters.")
    requested_role = body.get("role")
    if requested_role is not None and requested_role not in {"shadow", "primary"}:
        raise HelperError(400, "Invalid trigger role.")
    gate = background or process_background()
    role = "primary" if gate.role == "primary" and requested_role != "shadow" else "shadow"
    folder = trigger_dir(trigger_id)
    folder.mkdir(parents=True, exist_ok=True)
    os.chmod(folder, 0o700)
    tmp = folder / "spec.json.tmp"
    tmp.write_text(json.dumps({"query": query, "role": role}))
    os.replace(tmp, folder / "spec.json")
    install_gate()
    return {"workdir": str(folder), "script": GATE_NAME, "role": role}


def delete_trigger(trigger_id: str) -> dict:
    folder = trigger_dir(trigger_id)
    if folder.is_dir():
        shutil.rmtree(folder)
    return {"ok": True}


# ---- WhatsApp routing -------------------------------------------------------------

WA_PLUGIN = "whatsapp-routing"
WA_SETTINGS = HERMES_HOME / "whatsapp-routing.json"
WA_DEFAULTS = {"reply_routing": True, "return_minutes": 30, "fresh_after_hours": 4}
WA_RETURN_MINUTES = (15, 30, 60, 120, 240)
WA_FRESH_HOURS = (0, 2, 4, 8, 12, 24)


def _plugin_enabled_in_hermes(name: str) -> bool:
    """Whether config.yaml lists *name* under plugins.enabled. A line scan (no YAML library): the
    block form Hermes itself writes, `plugins:` / `  enabled:` / `    - name`."""
    try:
        lines = (HERMES_HOME / "config.yaml").read_text().splitlines()
    except OSError:
        return False
    in_plugins = in_enabled = False
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            in_plugins, in_enabled = line.rstrip() == "plugins:", False
        elif in_plugins and indent == 2:
            in_enabled = line.strip() == "enabled:"
        elif in_enabled and line.strip().lstrip("- ").strip().strip("'\"") == name and line.strip().startswith("-"):
            return True
    return False


def wa_status() -> dict:
    settings = dict(WA_DEFAULTS)
    try:
        data = json.loads(WA_SETTINGS.read_text())
        for key, default in WA_DEFAULTS.items():
            if type(data.get(key)) is type(default):
                settings[key] = data[key]
    except (OSError, ValueError):
        pass
    return {
        "installed": (HERMES_HOME / "plugins" / WA_PLUGIN / "__init__.py").is_file(),
        "active": _plugin_enabled_in_hermes(WA_PLUGIN),
        "replyRouting": settings["reply_routing"],
        "returnMinutes": settings["return_minutes"],
        "freshAfterHours": settings["fresh_after_hours"],
    }


def wa_put(body: dict) -> dict:
    routing, minutes, hours = body.get("replyRouting"), body.get("returnMinutes"), body.get("freshAfterHours")
    if not isinstance(routing, bool):
        raise HelperError(400, "replyRouting must be true or false.")
    if type(minutes) is not int or minutes not in WA_RETURN_MINUTES:
        raise HelperError(400, "Unsupported return time.")
    if type(hours) is not int or hours not in WA_FRESH_HOURS:
        raise HelperError(400, "Unsupported fresh-chat time.")
    data = {"reply_routing": routing, "return_minutes": minutes, "fresh_after_hours": hours}
    tmp = WA_SETTINGS.with_name(WA_SETTINGS.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, WA_SETTINGS)
    log("whatsapp routing settings saved", **data)
    return wa_status()


# ---- Phone (Hermes Phone) -------------------------------------------------------------

PHONE_URL = env("PHONE_URL", "http://127.0.0.1:19014")
# The vault: `<command> get <name>` prints the secret as "pass=<value>". SIGNALBOX_VAULT_CMD sets the command.
VAULT_CMD = Path(env("VAULT_CMD") or (Path.home() / ".config" / "signalbox" / "vault"))
PIN_RE = re.compile(r"^\d{4,12}$")


def _phone_token() -> str:
    try:
        out = subprocess.run([str(VAULT_CMD), "get", "phone-admin"], capture_output=True, text=True,
                             timeout=20, check=False)
    except OSError:
        raise HelperError(503, "The vault isn't reachable from the helper.")
    token = next((l[5:] for l in out.stdout.splitlines() if l.startswith("pass=")), "")
    if out.returncode != 0 or len(token) < 16:
        raise HelperError(503, "The phone admin token isn't in the vault.")
    return token


class PhoneOff(HelperError):
    """Nothing listens on the phone server's port: the line is off, so no call can be up."""


def _phone(method: str, path: str, body: dict | None = None, auth: bool = True, timeout: float = 10) -> dict:
    import urllib.error
    import urllib.request
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json"} if data else {}
    if auth:
        headers["authorization"] = f"Bearer {_phone_token()}"
    req = urllib.request.Request(PHONE_URL + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read(65536))
    except urllib.error.HTTPError as err:
        if err.code in (503,) and path == "/health":
            return json.loads(err.read(65536))
        raise HelperError(502, f"The phone server refused that ({err.code}).")
    except (urllib.error.URLError, TimeoutError) as err:
        down = "Hermes Phone isn't running. Start its service and try again."
        if isinstance(getattr(err, "reason", None), ConnectionRefusedError):
            raise PhoneOff(503, down)
        raise HelperError(503, down)


def phone_status() -> dict:
    """Line status for Settings and the busy counts; never the PIN itself.

    "off" says the line is known to be off (its port refused us). A timeout or an
    error says nothing about calls, so it isn't "off", and the server then counts
    the calls as unknown rather than none.
    """
    try:
        health = _phone("GET", "/health", auth=False, timeout=8)
    except PhoneOff:
        return {"running": False, "ok": False, "pinSet": False, "off": True}
    except HelperError:
        return {"running": False, "ok": False, "pinSet": False}
    try:
        pin = _phone("GET", "/settings/pin")
        pin_set, owner = bool(pin.get("set")), pin.get("owner_number")
    except HelperError:
        pin_set, owner = False, None
    status = {"running": True, "ok": bool(health.get("ok")), "pinSet": pin_set, "ownerNumber": owner,
              "totalCalls": health.get("total_calls", 0), "publicHost": health.get("public_host")}
    calls = health.get("active_calls")
    # Only a count the phone server gave: a missing one isn't zero calls.
    if isinstance(calls, int) and not isinstance(calls, bool) and calls >= 0:
        status["activeCalls"] = calls
    return status


def phone_pin() -> dict:
    pin = _phone("GET", "/settings/pin")
    return {"pin": pin.get("pin")}


VOICE_RE = re.compile(r"^[a-z]{2}_[a-z]{2,20}$")


def phone_set_voice(body: dict) -> dict:
    """Settings → Voice applies everywhere: the phone line uses it from its next call."""
    voice = body.get("voice")
    if not isinstance(voice, str) or not VOICE_RE.match(voice):
        raise HelperError(400, "That isn't a voice name.")
    result = _phone("PUT", "/settings/voice", {"voice": voice}, timeout=30)
    log("phone voice set", voice=voice)
    return {"voice": result.get("voice")}


def phone_set_pin(body: dict) -> dict:
    pin = body.get("pin")
    if not isinstance(pin, str) or not PIN_RE.match(pin):
        raise HelperError(400, "The PIN must be 4 to 12 digits.")
    _phone("PUT", "/settings/pin", {"pin": pin})
    log("phone pin changed")   # never the digits
    return phone_status()


# ---- Shopping browser --------------------------------------------------------------

def shops_status() -> dict:
    """Whether the signed-in Chrome Hermes shops with is running. Never opens or reads a page."""
    if not SHOP_CDP:
        return {"state": "unknown"}
    import urllib.request
    try:
        with urllib.request.urlopen(f"{SHOP_CDP}/json/version", timeout=3) as res:
            browser = json.loads(res.read(4096)).get("Browser", "")
        return {"state": "connected", "detail": "The shopping Chrome is running" + (f" ({browser.split('/')[0]})" if browser else "")}
    except Exception:
        return {"state": "off", "detail": "The shopping Chrome isn't running on the PC"}


# ---- HTTP -----------------------------------------------------------------------

TOKEN = ""


SKILLS: "signalbox_skills.SkillsService | None" = None


class Handler(BaseHTTPRequestHandler):
    server_version = "signalbox-helper"
    sys_version = ""

    def log_message(self, fmt, *args):  # no default access log (paths can hold ids only, but keep it quiet)
        return

    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        header = self.headers.get("authorization", "")
        return header.startswith("Bearer ") and hmac.compare_digest(header[7:].encode(), TOKEN.encode())

    def _body(self) -> dict:
        length = int(self.headers.get("content-length") or 0)
        if length > MAX_BODY:
            raise HelperError(413, "Request too large.")
        if not length:
            return {}
        try:
            data = json.loads(self.rfile.read(length))
        except Exception:
            raise HelperError(400, "Invalid JSON.")
        if not isinstance(data, dict):
            raise HelperError(400, "Invalid JSON.")
        return data

    def _route(self, method: str) -> None:
        if self.headers.get("host", "").split(":")[0] not in {"127.0.0.1", "localhost"}:
            return self._send(421, {"error": "misdirected"})
        if not self._authorized():
            return self._send(401, {"error": "unauthorized"})
        path = self.path.split("?")[0]
        try:
            background = self._background()
            if path.startswith(SHADOW_API_PREFIX):
                path = "/" + path.removeprefix(SHADOW_API_PREFIX)
            if method == "GET" and path == "/health":
                return self._send(200, {"ok": True, "role": background.role, "roleAware": True})
            if method == "GET" and path == "/google":
                return self._send(200, google_status())
            if method == "POST" and path == "/google/start":
                return self._send(200, google_start())
            if method == "POST" and path == "/google/finish":
                return self._send(200, google_finish(self._body()))
            if method == "POST" and path == "/google/disconnect":
                return self._send(200, google_disconnect())
            if method == "GET" and path == "/shops":
                return self._send(200, shops_status())
            if method == "GET" and path == "/phone":
                return self._send(200, phone_status())
            if method == "GET" and path == "/phone/pin":
                return self._send(200, phone_pin())
            if method == "PUT" and path == "/phone/pin":
                return self._send(200, phone_set_pin(self._body()))
            if method == "PUT" and path == "/phone/voice":
                return self._send(200, phone_set_voice(self._body()))
            if method == "GET" and path == "/whatsapp-routing":
                return self._send(200, wa_status())
            if method == "PUT" and path == "/whatsapp-routing":
                return self._send(200, wa_put(self._body()))
            if path.startswith("/skills"):
                return self._skills(method, path)
            if method == "GET" and path == "/triggers":
                return self._send(200, list_triggers())
            match = re.fullmatch(r"/triggers/([^/]+)", path)
            if match and method == "PUT":
                return self._send(200, put_trigger(match.group(1), self._body(), background))
            if match and method == "DELETE":
                return self._send(200, delete_trigger(match.group(1)))
            return self._send(404, {"error": "not found"})
        except (HelperError, signalbox_skills.SkillsError) as err:
            return self._send(err.status, {"error": str(err)})
        except Exception as err:  # never echo internals
            log("request failed", path=path, err=type(err).__name__)
            return self._send(500, {"error": "Something went wrong in the Wayroost helper."})

    def _background(self):
        requested = self.headers.get("x-wayroost-role")
        if requested is not None and requested not in {"shadow", "primary"}:
            raise HelperError(400, "Invalid x-wayroost-role header.")
        process_role = process_background().role
        # The versioned namespace cannot be widened by a missing or primary header.
        shadow = process_role == "shadow" or requested == "shadow" or self.path.startswith(SHADOW_API_PREFIX)
        return BackgroundGate("shadow" if shadow else "primary")

    def _skills(self, method: str, path: str) -> None:
        query = {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}
        if SKILLS is None:
            raise HelperError(503, "Skills aren't set up in the Wayroost helper.")
        if method in {"POST", "PUT"} and path != "/skills/scan" and not process_background().run(lambda: True):
            raise HelperError(409, "Skills are read-only in shadow mode. Use the primary helper to change them.")
        if method == "GET" and path == "/skills":
            background = self._background()
            return self._send(200, {**SKILLS.listing(background=background), "role": background.role})
        if method == "GET" and path == "/skills/version":
            return self._send(200, {"version": SKILLS.version})
        if method == "GET" and path == "/skills/content":
            return self._send(200, SKILLS.content(query.get("place", ""), query.get("name", "")))
        if method == "POST" and path == "/skills/refresh":
            SKILLS.refresh(force_windows=True)
            return self._send(200, {"version": SKILLS.version})
        body = self._body() if method in ("POST", "PUT") else {}
        place, name = str(body.get("place") or ""), str(body.get("name") or "")
        if method == "POST" and path == "/skills/scan":
            return self._send(200, SKILLS.scan(place, name))
        if method == "POST" and path == "/skills/share":
            return self._send(200, SKILLS.share(place, name, body.get("confirmCaution") is True))
        if method == "POST" and path == "/skills/take-shared":
            return self._send(200, SKILLS.take_shared(place, name))
        if method == "PUT" and path == "/skills/excluded":
            return self._send(200, SKILLS.set_excluded(name, place, body.get("excluded") is True))
        if method == "POST" and path == "/skills/remove":
            return self._send(200, SKILLS.remove_shared(name))
        return self._send(404, {"error": "not found"})

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")


def main() -> None:
    global TOKEN
    TOKEN = read_token()
    try:
        process_background().run(install_gate)
    except Exception as err:
        log("could not install the gate script", err=type(err).__name__)
    global SKILLS
    try:
        SKILLS = signalbox_skills.from_env(HERMES_HOME, background=process_background())
        SKILLS.watch(lambda err: log("skills watch failed", err=err))
    except Exception as err:
        log("skills are off", err=type(err).__name__)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    log("signalbox helper listening", listen=f"{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
