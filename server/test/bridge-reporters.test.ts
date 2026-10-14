import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

const setup = String.raw`
import importlib.util, json, os, re, subprocess, sys, tempfile
from pathlib import Path
from unittest.mock import Mock, patch

repo, home = map(Path, sys.argv[1:3])
os.environ.clear()
os.environ.update(HOME=str(home), PATH=os.defpath, WAYROOST_ROLE="primary")
script = (repo / "deploy/setup-bridge.sh").read_text()
helper = script.split("HELPER <<'PY' || true\n", 1)[1].split("\nPY\n", 1)[0]

def install_url(mode, url, dry=False):
    return subprocess.run([sys.executable, "-I", "-B", "-c", helper, "bridge-url", mode,
                           str(home / ".config/wayroost/bridge-url"), url, "fake-stamp", str(int(dry))],
                          capture_output=True, text=True, timeout=10)

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

runtime = load("wayroost_runtime", repo / "helper/wayroost_runtime.py")
sys.modules["wayroost_runtime"] = runtime
hook = load("demo_hook", repo / "claude-hook/signalbox-claude-hook.py")
plugin = load("demo_plugin", repo / "hermes-plugin/wayroost-identity/__init__.py")

def report_urls():
    fake_token = home / "fake-token"
    fake_token.write_text("obviously_fake_token_" * 3)
    opener = Mock()
    opener.open.return_value.__enter__ = Mock(return_value=Mock())
    opener.open.return_value.__exit__ = Mock(return_value=False)
    with patch.object(hook, "TOKEN_FILE", str(fake_token)), \
         patch.object(plugin, "_bridge_token", return_value=fake_token.read_text()), \
         patch("urllib.request.build_opener", return_value=opener):
        hook.post({"session": "00000000-0000-0000-0000-000000000001", "event": "start"})
        plugin._post("note_launch", {"child": "00000000_000000_fake", "candidates": []})
    return [call.args[0].full_url for call in opener.open.call_args_list]

def install_plugin(copy_status=0, legacy="on", current="off", fail_action="", mutate_failure=False,
                   dry=False, fail_backup=False, unknown_state=False, noop_action="", migrated=False,
                   config_text=None, real_toggle=False):
    target = Path(tempfile.mkdtemp(dir=home, prefix="plugin-install-"))
    config = target / ".hermes/config.yaml"
    config.parent.mkdir()
    data = {"plugins": {"enabled": ["other"], "disabled": ["unused"]}, "model": {"name": "demo"}}
    for name, state in (("signalbox-identity", legacy), ("wayroost-identity", current)):
        if state != "absent":
            data["plugins"]["enabled" if state == "on" else "disabled"].append(name)
    if migrated:
        data["mcp_servers"] = {"wayroost": {"command": "node", "args": ["/demo/signalbox-bridge.mjs"],
                                             "env": {"WAYROOST_BRIDGE_NAME": "wayroost"}}}
    original = (config_text if config_text is not None else
                (json.dumps(data, indent=4) + "\n").replace("\n", "\r\n")).encode()
    config.write_bytes(original)
    mutate = r'''
import json, sys
from pathlib import Path
config, log = map(Path, sys.argv[1:3])
action, name = sys.argv[-2:]
with log.open("a") as stream:
    stream.write(json.dumps([action, name]) + "\n")
failed = action == sys.argv[3]
if (not failed or sys.argv[4] == "1") and action != sys.argv[5]:
    data = json.loads(config.read_text())
    plugins = data.setdefault("plugins", {})
    for key in ("enabled", "disabled"):
        plugins[key] = [value for value in plugins.get(key, []) if value != name]
    plugins["enabled" if action == "enable" else "disabled"].append(name)
    config.write_text(json.dumps(data))
sys.exit(1 if failed else 0)
'''
    mocks = r'''
set -euo pipefail
PLUGIN=1 REMOVE=0 STAMP=fake-stamp
user_has() { test -e "$1"; }
helper() {
  if [[ "$1" == plugin ]]; then return "$COPY_STATUS"; fi
  if [[ "$1" == backup && "$FAIL_BACKUP" == 1 ]]; then return 1; fi
  if [[ "$1" == plugin-state && "$UNKNOWN_STATE" == 1 ]]; then echo unknown; return 0; fi
  if [[ "$1" == plugin-toggle ]]; then
    if [[ "$REAL_TOGGLE" == 1 ]]; then
      "$PY3" -I -B -c "$HELPER" "$@"
      return
    fi
    "$PY3" -I -B -c "$MUTATE" "$2" "$UHOME/calls.jsonl" "$FAIL_ACTION" "$MUTATE_FAILURE" "$NOOP_ACTION" "$3" "$4"
    return
  fi
  "$PY3" -I -B -c "$HELPER" "$@"
}
as_user() {
  "$PY3" -I -B -c "$MUTATE" "$UHOME/.hermes/config.yaml" "$UHOME/calls.jsonl" \
    "$FAIL_ACTION" "$MUTATE_FAILURE" "$NOOP_ACTION" "$@"
}
record() { printf '%s\n' "$2" >> "$UHOME/status"; }
'''
    block = script.split("# The optional Hermes plugin", 1)[1].split('echo "==> pi"', 1)[0]
    result = subprocess.run(["bash"], input=mocks + "# The optional Hermes plugin" + block,
                            env={"PATH": os.defpath, "REPO": str(repo), "UHOME": str(target), "TARGET": "demo",
                                 "PY3": sys.executable, "HELPER": helper, "MUTATE": mutate,
                                 "COPY_STATUS": str(copy_status), "DRY_RUN": str(int(dry)),
                                 "FAIL_ACTION": fail_action,
                                 "MUTATE_FAILURE": str(int(mutate_failure)), "FAIL_BACKUP": str(int(fail_backup)),
                                 "UNKNOWN_STATE": str(int(unknown_state)), "NOOP_ACTION": noop_action,
                                 "REAL_TOGGLE": str(int(real_toggle))},
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout + result.stderr
    log = target / "calls.jsonl"
    calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return config.read_bytes(), original, calls, (target / "status").read_text().strip()
`;

function check(code: string): void {
  mkdirSync('.tmp', { recursive: true });
  const folder = mkdtempSync(join(process.cwd(), '.tmp', 'bridge-reporters-'));
  folders.push(folder);
  const output = execFileSync('python3', ['-I', '-B', '-c', setup + code, process.cwd(), folder], {
    env: { PATH: process.env.PATH, TMPDIR: folder }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
  });
  expect(output).toBe('');
}

it('refuses duplicate setup and removes both names only when they run the wrapper', () => {
  check(String.raw`
wrapper = "/demo/signalbox-bridge.mjs"
for kind, filename, key in (("hermes", "config.yaml", "mcp_servers"), ("pi", "mcp.json", "mcpServers"),
                            ("pi", "mcp.json", "mcp-servers"), ("opencode", "opencode.json", "mcp")):
    target = home / kind / key / filename
    target.parent.mkdir(parents=True)
    entry = {"type": "local", "command": ["node", wrapper]} if kind == "opencode" else {"command": "node", "args": [wrapper]}
    original = json.dumps({key: {"signalbox": entry, "other": {"command": "demo"}}, "preference": "example"})
    if kind == "hermes":
        original = "mcp_servers:\n  signalbox:\n    command: node\n    args: [" + wrapper + "]\n  other:\n    command: demo\npreference: example\n"
    target.write_text(original)
    run = lambda mode: subprocess.run([sys.executable, "-I", "-B", "-c", helper, "edit", kind, mode,
                                       str(target), wrapper, "", "fake-stamp", "0"], capture_output=True, text=True)
    result = run("add")
    assert result.returncode == 4, result.stdout + result.stderr
    assert "bridge-names.py forward" in result.stdout
    assert target.read_text() == original
    if kind == "hermes":
        target.write_text(original.replace("  other:", "  wayroost:\n    command: node\n    args: [" + wrapper + "]\n  other:"))
    else:
        data = json.loads(original)
        data[key]["wayroost"] = entry
        target.write_text(json.dumps(data))
    result = run("remove")
    assert result.returncode == 0, result.stdout + result.stderr
    import yaml
    assert yaml.safe_load(target.read_text()) == {key: {"other": {"command": "demo"}}, "preference": "example"}
    target.write_text(original)
    result = run("remove")
    assert result.returncode == 0, result.stdout + result.stderr
    assert yaml.safe_load(target.read_text()) == {key: {"other": {"command": "demo"}}, "preference": "example"}
`);
});

it('edits plugin lists without a launcher and rejects malformed plugin state', () => {
  check(String.raw`
target = home / "plugins-config.yaml"
original = "# keep comment\nplugins:\n  enabled: [other, signalbox-identity]\n  disabled: [unused]\nmodel: {name: demo}\n"
target.write_text(original)
run = lambda action: subprocess.run([sys.executable, "-I", "-B", "-c", helper, "plugin-toggle", str(target),
                                     action, "wayroost-identity", "fake-stamp", "0"], capture_output=True, text=True)
assert run("enable").returncode == 0
import yaml
data = yaml.safe_load(target.read_text())
assert data["plugins"]["enabled"] == ["other", "signalbox-identity", "wayroost-identity"]
assert data["model"] == {"name": "demo"}
assert target.read_text().startswith("# keep comment\n")
assert run("disable").returncode == 0
assert "wayroost-identity" not in yaml.safe_load(target.read_text())["plugins"]["enabled"]
target.write_text("plugins: [broken")
state = subprocess.run([sys.executable, "-I", "-B", "-c", helper, "plugin-state", str(target), "signalbox-identity"],
                       capture_output=True, text=True)
assert state.stdout.strip() == "unknown"
assert '"$HERMES"' not in script
assert "hermes --run-module" not in script
`);
});

it('refuses and removes legacy Claude registrations without creating a second registration', () => {
  check(String.raw`
block = script.split('echo "==> Claude Code"', 1)[1].split("# Signalbox's launch hook", 1)[0]
mock_cli = r'''
import json, sys
from pathlib import Path
config, log = map(Path, sys.argv[1:3])
args = sys.argv[3:]
data = json.loads(config.read_text())
verb = args[4]
if verb == "get":
    name = args[5]
    if name not in data:
        sys.exit(1)
    print(data[name])
else:
    with log.open("a") as stream:
        stream.write(json.dumps(args) + "\n")
    if verb == "remove":
        data.pop(args[-1], None)
    else:
        data["wayroost"] = "node /demo/signalbox-bridge.mjs WAYROOST_BRIDGE_NAME=wayroost"
    config.write_text(json.dumps(data))
'''
mocks = r'''
set -euo pipefail
find_tool() { echo /demo/claude; }
as_user() { "$PY3" -I -B -c "$MOCK_CLI" "$CONFIG" "$LOG" "$@"; }
record() { printf '%s\n' "$2" >> "$STATUS"; }
'''
for initial in ({"signalbox": "node /demo/signalbox-bridge.mjs"},
                {"signalbox": "node /demo/signalbox-bridge.mjs", "wayroost": "node /demo/signalbox-bridge.mjs WAYROOST_BRIDGE_NAME=wayroost"}):
    for remove in (False, True):
        target = Path(tempfile.mkdtemp(dir=home))
        config, log, status = target / "config.json", target / "calls.jsonl", target / "status"
        config.write_text(json.dumps(initial))
        result = subprocess.run(["bash"], input=mocks + block,
                                env={"PATH": os.defpath, "PY3": sys.executable, "MOCK_CLI": mock_cli,
                                     "CONFIG": str(config), "LOG": str(log), "STATUS": str(status),
                                     "WRAPPER": "/demo/signalbox-bridge.mjs", "URL": "", "TARGET": "demo",
                                     "REMOVE": str(int(remove)), "DRY_RUN": "0"},
                                capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stdout + result.stderr
        if remove:
            assert json.loads(config.read_text()) == {}
            assert status.read_text().strip() == "0"
        else:
            assert json.loads(config.read_text()) == initial
            assert not log.exists()
            assert status.read_text().strip() == "4"
            assert "bridge-names.py forward" in result.stdout
`);
});

it('treats unstamped harness launches as legacy and forwards stamped launches without a listener', () => {
  check(String.raw`
transport = home / "mock-transport.mjs"
transport.write_text('''
import http from 'node:http';
import { EventEmitter } from 'node:events';
http.request = (options, callback) => {
  const request = new EventEmitter();
  request.end = () => queueMicrotask(() => {
    const response = new EventEmitter();
    const name = options.headers['X-Bridge-Name'];
    response.statusCode = name === 'signalbox' && process.env.TEST_CUTOFF === 'true' ? 403 : 200;
    callback(response);
    response.emit('data', Buffer.from(JSON.stringify(response.statusCode === 200
      ? { ok: true, result: { name, session: options.headers['X-Bridge-Hermes-Session'] } }
      : { ok: false, error: 'Legacy name refused.' })));
    response.emit('end');
  });
  return request;
};
''')
token = home / "fake-token"
token.write_text("obviously_fake_token_" * 3)
for harness in ("pi", "claude", "opencode", "paseo"):
    for stamp in (None, "wayroost", "signalbox"):
        for cutoff in (False, True):
            env = {"HOME": str(home), "PATH": os.defpath, "WAYROOST_BRIDGE_TOKEN_FILE": str(token),
                   "TEST_CUTOFF": str(cutoff).lower()}
            if harness == "paseo":
                env["PASEO_AGENT_ID"] = "fake-agent"
            if stamp is not None:
                env["WAYROOST_BRIDGE_NAME"] = stamp
            child = subprocess.Popen(["node", "--import", str(transport), str(repo / "bridge/signalbox-bridge.mjs")],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_chats", "arguments": {}}}
            child.stdin.write(json.dumps(request) + "\n")
            child.stdin.flush()
            result = json.loads(child.stdout.readline())["result"]
            assert bool(result.get("isError")) == (cutoff and stamp != "wayroost"), (harness, stamp, result)
            if not result.get("isError"):
                assert json.loads(result["content"][0]["text"])["name"] == (stamp or "signalbox")
            child.stdin.close()
            assert child.wait(timeout=5) == 0
`);
});

it.each([1, 2, 4])('preserves plugin enablement when staging fails with status %s', status => {
  check(`
actual, original, calls, status = install_plugin(copy_status=${status})
assert actual == original
assert calls == [], calls
assert status == "1", status
`);
});

it.each([1, 2, 4])('keeps the canonical identity plugin unchanged when staging fails with status %s', code => {
  check(`
actual, original, calls, status = install_plugin(copy_status=${code}, legacy="off", current="on", migrated=True)
assert actual == original
assert calls == [], calls
assert status == "1", status
`);
});

it.each(['off', 'on'])('leaves ambiguous identity enablement (%s) for manual repair', state => {
  check(`
actual, original, calls, status = install_plugin(legacy="${state}", current="${state}")
assert actual == original
assert calls == [], calls
assert status == "4", status
`);
});

it.each([
  'model: demo # keep owner comment\r\n',
  'plugins: {enabled: [other]} # keep owner comment\r\nmodel: demo\r\n',
])('enables the identity plugin on a fresh install: %s', original => {
  check(`
import yaml
actual, original, calls, status = install_plugin(config_text=${JSON.stringify(original)}, real_toggle=True)
data = yaml.safe_load(actual)
assert data["plugins"]["enabled"] == (${original.startsWith('plugins:') ? '["other", "wayroost-identity"]' : '["wayroost-identity"]'})
assert data["plugins"]["disabled"] == []
assert data["model"] == "demo"
assert b"# keep owner comment\\r\\n" in actual
assert status == "0", status
`);
});

it.each(['signalbox-identity', 'wayroost-identity'])('preserves explicit owner disablement of %s', name => {
  check(`
original = json.dumps({"plugins": {"enabled": ["other"], "disabled": ["${name}"]}}) + "\\n"
actual, original, calls, status = install_plugin(config_text=original, real_toggle=True)
assert actual == original
assert calls == [], calls
assert status == "4", status
`);
});

it.each([false, true])('restores fresh-install snapshots after a partial enable failure (plugins present: %s)', present => {
  check(`
data = {"model": "demo"}
if ${present ? 'True' : 'False'}:
    data["plugins"] = {"enabled": ["other"]}
original = (json.dumps(data, indent=4) + "\\n").replace("\\n", "\\r\\n")
actual, original, calls, status = install_plugin(config_text=original, fail_action="enable", mutate_failure=True)
assert actual == original
assert calls == [["enable", "wayroost-identity"]], calls
assert status == "1", status
`);
});

it('keeps fresh-install dry runs and failed staging read-only', () => {
  check(String.raw`
for options in ({"dry": True}, {"copy_status": 1}, {"fail_backup": True}):
    actual, original, calls, status = install_plugin(legacy="absent", current="absent", **options)
    assert actual == original
    assert calls == [], calls
    assert status == ("0" if options.get("dry") else "1"), status
`);
});

it.each([false, true])('restores plugin enablement after an enable failure (partial edit: %s)', partial => {
  check(`
actual, original, calls, status = install_plugin(fail_action="enable", mutate_failure=${partial ? 'True' : 'False'})
assert actual == original
assert calls == [["enable", "wayroost-identity"]], calls
assert status == "1", status
`);
});

it('restores plugin enablement when disabling the legacy plugin partially fails', () => {
  check(String.raw`
actual, original, calls, status = install_plugin(fail_action="disable", mutate_failure=True)
assert actual == original
assert calls == [["enable", "wayroost-identity"], ["disable", "signalbox-identity"]], calls
assert status == "1", status
`);
});

it('preserves enablement when rollback preparation fails or the state is unknown', () => {
  check(String.raw`
for options, expected in (({"fail_backup": True}, "1"), ({"unknown_state": True}, "4")):
    actual, original, calls, status = install_plugin(**options)
    assert actual == original
    assert calls == [], calls
    assert status == expected, status
`);
});

it.each(['disable', 'enable'])('restores the snapshot if Hermes reports success without applying %s', action => {
  check(`
actual, original, calls, status = install_plugin(noop_action="${action}")
assert actual == original
assert calls == (${action === 'enable' ? '[["enable", "wayroost-identity"]]' : '[["enable", "wayroost-identity"], ["disable", "signalbox-identity"]]'}), calls
assert status == "1", status
`);
});

it('switches exactly one identity plugin after successful staging and keeps dry runs read-only', () => {
  check(String.raw`
for copy_status in (0, 3):
    actual, original, calls, status = install_plugin(copy_status=copy_status)
    data = json.loads(actual)
    assert data == {"plugins": {"enabled": ["other", "wayroost-identity"],
                               "disabled": ["unused", "signalbox-identity"]}, "model": {"name": "demo"}}
    assert calls == [["enable", "wayroost-identity"], ["disable", "signalbox-identity"]], calls
    assert status == "0", status
actual, original, calls, status = install_plugin(dry=True)
assert actual == original
assert calls == [], calls
assert status == "0", status
actual, original, calls, status = install_plugin(legacy="off", current="on", copy_status=3)
assert actual == original
assert calls == [], calls
assert status == "3", status
`);
});

it('keeps both launch reporters on the configured bridge port after an upgrade', () => {
  check(String.raw`
config = home / "config.json"
config.write_text(json.dumps({"bridge": {"enabled": True, "port": 8792}}))
port_script = re.search(r'PORT="\$\(python3 -I - "\$ETC/config.json" <<\x27PY\x27\n(.*?)\nPY\n', script, re.S).group(1)
port = subprocess.check_output([sys.executable, "-I", "-B", "-c", port_script, str(config)], text=True).strip()
assert port == "8792"
url = "http://127.0.0.1:" + port
assert 'helper bridge-url "$MODE" "$UHOME/.config/wayroost/bridge-url" "http://127.0.0.1:$PORT"' in script
result = install_url("add", url)
assert result.returncode == 0, result.stderr
assert report_urls() == [url + "/bridge/v1/note_run", url + "/bridge/v1/note_launch"]
assert install_url("add", url).returncode == 3
default_url = "http://127.0.0.1:19012"
assert install_url("add", default_url).returncode == 0
assert report_urls() == [default_url + "/bridge/v1/note_run", default_url + "/bridge/v1/note_launch"]
assert install_url("remove", default_url).returncode == 0
assert not (home / ".config/wayroost/bridge-url").exists()
assert install_url("remove", default_url).returncode == 3
assert report_urls() == [default_url + "/bridge/v1/note_run", default_url + "/bridge/v1/note_launch"]
`);
});

it('prefers explicit bridge URL aliases and refuses remote or malformed reporter URLs', () => {
  check(String.raw`
for environ, url in [({}, "http://127.0.0.1:19012"),
                     ({"SIGNALBOX_BRIDGE_URL": "http://127.0.0.1:8792"}, "http://127.0.0.1:8792"),
                     ({"SIGNALBOX_BRIDGE_URL": "http://127.0.0.1:8792", "WAYROOST_BRIDGE_URL": "http://127.0.0.1:19022"}, "http://127.0.0.1:19022")]:
    with patch.dict(os.environ, environ):
        assert report_urls() == [url + "/bridge/v1/note_run", url + "/bridge/v1/note_launch"]
for url in ("http://example.com:8792", "http://127.0.0.1.example.com:8792", "https://127.0.0.1:8792",
            "http://me:fake@127.0.0.1:8792", "http://127.0.0.1:0", "http://127.0.0.1:65536",
            "http://127.0.0.1:8792/other", "http://127.0.0.1:8792?other", "http://127.0.0.1:8792#other", ""):
    with patch.dict(os.environ, {"WAYROOST_BRIDGE_URL": url}), patch("urllib.request.build_opener") as opener:
        try:
            runtime.bridge_url()
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid reporter URL was accepted")
        opener.assert_not_called()
`);
});

it('keeps bridge URL dry runs read-only and rejects invalid saved configuration', () => {
  check(String.raw`
url = "http://127.0.0.1:8792"
target = home / ".config/wayroost/bridge-url"
assert install_url("add", url, dry=True).returncode == 0
assert not target.exists()
assert install_url("add", url).returncode == 0
assert install_url("remove", url, dry=True).returncode == 0
assert target.read_text().strip() == url
target.write_text("http://example.com:8792")
try:
    runtime.bridge_url()
except ValueError:
    pass
else:
    raise AssertionError("Invalid saved URL was accepted")
assert install_url("add", "http://example.com:8792").returncode == 1
assert target.read_text() == "http://example.com:8792"
`);
});

it.each(['hermes', 'pi', 'opencode'])('refuses a legacy %s registration at a previous runtime path', kind => {
  check(`
kind = "${kind}"
wrapper = "/opt/demo-runtime/bin/signalbox-bridge.mjs"
key = {"hermes": "mcp_servers", "pi": "mcpServers", "opencode": "mcp"}[kind]
entry = {"command": ["/demo/node", "--trace-warnings", wrapper]} if kind == "opencode" else {"command": "/demo/node", "args": ["--trace-warnings", wrapper]}
target = home / "config.json"
original = json.dumps({key: {"signalbox": entry}})
target.write_text(original)
result = subprocess.run([sys.executable, "-I", "-B", "-c", helper, "edit", kind, "add", str(target),
                         "/demo/current/signalbox-bridge.mjs", "", "fake-stamp", "0"], capture_output=True, text=True)
assert result.returncode == 4, result.stdout + result.stderr
assert "bridge-names.py forward" in result.stdout
assert target.read_text() == original
`);
});

it('refuses a legacy Claude wrapper from a previous runtime path', () => {
  check(String.raw`
block = script.split('echo "==> Claude Code"', 1)[1].split("# Signalbox's launch hook", 1)[0]
mocks = r'''
set -euo pipefail
find_tool() { echo /demo/claude; }
as_user() {
  if [[ "$5" == get && "$6" == signalbox ]]; then
    echo 'Command: /demo/node'
    echo 'Args: --trace-warnings /opt/demo-runtime/bin/signalbox-bridge.mjs'
    return 0
  fi
  return 1
}
record() { printf '%s\n' "$2" >> "$STATUS"; }
'''
status = home / "status"
result = subprocess.run(["bash"], input=mocks + block,
                        env={"PATH": os.defpath, "STATUS": str(status), "WRAPPER": "/demo/current/signalbox-bridge.mjs",
                             "URL": "", "TARGET": "demo", "REMOVE": "0", "DRY_RUN": "0"},
                        capture_output=True, text=True)
assert result.returncode == 0, result.stdout + result.stderr
assert status.read_text().strip() == "4", result.stdout
assert "bridge-names.py forward" in result.stdout
`);
});

it('preserves plugin list styles and comments during the identity switch', () => {
  check(String.raw`
import yaml
target = home / "config.yaml"
for original in (
    "# header\nplugins: # plugin comment\n  enabled: # enabled comment\n    - other # other comment\n    - signalbox-identity # old identity\n  # between lists\n  disabled: [unused] # disabled comment\n# after block\nmodel: {name: demo}\n",
    "plugins: {enabled: [other, signalbox-identity], disabled: [unused]} # plugin comment\n# after block\nmodel: demo\n",
    ' {"plugins": {"enabled": ["other", "signalbox-identity"], "disabled": ["unused"]}, "model": "demo"}\r\n',
):
    target.write_bytes(original.encode())
    for action, name in (("enable", "wayroost-identity"), ("disable", "signalbox-identity")):
        result = subprocess.run([sys.executable, "-I", "-B", "-c", helper, "plugin-toggle", str(target), action,
                                 name, "fake-stamp", "0"], capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr
    actual = target.read_bytes().decode()
    assert yaml.safe_load(actual)["plugins"] == {"enabled": ["other", "wayroost-identity"], "disabled": ["unused", "signalbox-identity"]}
    for comment in re.findall(r"#[^\r\n]*", original):
        assert comment in actual, (comment, actual)
    if "  enabled:" in original:
        assert "plugins: # plugin comment\n  enabled: # enabled comment\n" in actual
        assert "    - other # other comment\n" in actual
        assert "  disabled: [unused, \"signalbox-identity\"] # disabled comment\n" in actual
    elif original.lstrip().startswith('{'):
        assert json.loads(actual)["model"] == "demo"
        assert actual.endswith("\r\n")
    else:
        assert actual.startswith("plugins: {enabled: [")
`);
});

it.each([
  'plugins: {enabled: [signalbox-identity],}\nmodel: demo\n',
  'plugins: {disabled: [unused],}\nmodel: demo\n',
  '{model: demo,}\n',
  '{plugins: {}, model: demo,}\n',
  'plugins: {enabled: [signalbox-identity], # keep separator comment,\n}\nmodel: demo\n',
  'plugins: {enabled: [signalbox-identity] # keep comment comma,\n}\nmodel: demo\n',
  '{model: demo, # keep root comment,\n}\n',
  'plugins: { # keep empty plugins comment,\n}\nmodel: demo\n',
])('adds missing plugin fields with preserved flow separators and comments: %s', original => {
  check(String.raw`
import yaml
target = home / "config.yaml"
original = ${JSON.stringify(original)}
target.write_bytes(original.encode())
expected = yaml.safe_load(original)
plugins = expected.setdefault("plugins", {})
plugins.setdefault("enabled", []).append("wayroost-identity")
plugins.setdefault("disabled", [])
for action, name in (("enable", "wayroost-identity"), ("disable", "signalbox-identity")):
    result = subprocess.run([sys.executable, "-I", "-B", "-c", helper, "plugin-toggle", str(target), action,
                             name, "fake-stamp", "0"], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    if action == "disable":
        plugins["enabled"] = [item for item in plugins["enabled"] if item != name]
        plugins["disabled"].append(name)
    actual = target.read_bytes().decode()
    assert yaml.safe_load(actual) == expected, actual
    for comment in re.findall(r"#[^\r\n]*", original):
        assert comment in actual, (comment, actual)
`);
});

it('removes legacy token and URL files only when they are regular and owned', () => {
  check(String.raw`
from unittest.mock import patch
namespace = {"__name__": "demo_setup"}
exec(helper.split("cmd = sys.argv[1]", 1)[0], namespace)
folder = home / ".config/signalbox"
folder.mkdir(parents=True)
token, url = folder / "bridge-token", folder / "bridge-url"
token.write_text("obviously_fake_token_" * 3)
url.write_text("http://127.0.0.1:19012")
remove = namespace["remove_legacy_files"]
with patch.dict(namespace, {"say": lambda *args: None}):
    assert remove(str(folder), True) == 0
assert token.exists() and url.exists()
with patch.dict(namespace, {"say": lambda *args: None}):
    assert remove(str(folder), False) == 0
assert not folder.exists()
folder.mkdir()
sentinel = home / "sentinel"
sentinel.write_text("invented fixture")
token.symlink_to(sentinel)
url.mkdir()
with patch.dict(namespace, {"say": lambda *args: None}):
    assert remove(str(folder), False) == 4
assert token.is_symlink() and url.is_dir()
assert sentinel.read_text() == "invented fixture"
token.unlink()
url.rmdir()
token.write_text("obviously_fake_token_" * 3)
with patch.dict(namespace, {"say": lambda *args: None}), patch("os.getuid", return_value=os.getuid() + 1):
    assert remove(str(folder), False) == 4
assert token.exists()
assert 'helper legacy-files "$UHOME/.config/signalbox" "$DRY_RUN"' in script
`);
});

it('restores a canonical identity snapshot exactly and refuses ambiguous snapshots', () => {
  check(String.raw`
config, saved = home / "config.yaml", home / "snapshot.yaml"
original = b"# owner comment\r\nplugins:\r\n  enabled: [other, wayroost-identity] # keep\r\n  disabled: [signalbox-identity]\r\nmodel: demo\r\n"
saved.write_bytes(original)
config.write_text("plugins: {enabled: [signalbox-identity], disabled: [wayroost-identity]}\n")
run = lambda: subprocess.run([sys.executable, "-I", "-B", "-c", helper, "restore", str(config), str(saved),
                              "fake-stamp"], capture_output=True, text=True)
result = run()
assert result.returncode == 0, result.stdout + result.stderr
assert config.read_bytes() == original
for lists in ({"enabled": ["signalbox-identity", "wayroost-identity"]},
              {"disabled": ["signalbox-identity", "wayroost-identity"]}):
    saved.write_text(json.dumps({"plugins": lists}))
    result = run()
    assert result.returncode == 4, result.stdout + result.stderr
    assert "manually" in result.stdout
    assert config.read_bytes() == original
`);
});

it('keeps plugin comments when emptying block lists or editing multiline flow lists', () => {
  check(String.raw`
import yaml
namespace = {"__name__": "demo_setup"}
exec(helper.split("cmd = sys.argv[1]", 1)[0], namespace)
tools = namespace["yaml_tools"]()
for original in (
    "plugins:\n  enabled:\n    - wayroost-identity # identity comment\n  disabled: [] # disabled comment\n# after block\nmodel: demo\n",
    "plugins:\n  enabled: [wayroost-identity,] # identity comment\n  disabled: [other,] # disabled comment\n# after block\nmodel: demo\n",
    "plugins: # identity comment\n  enabled: [\n    other, # other comment\n    wayroost-identity # member comment\n  ]\n  disabled: [] # disabled comment\n# after block\nmodel: demo\n",
):
    expected = yaml.safe_load(original)
    expected["plugins"]["enabled"] = [name for name in expected["plugins"]["enabled"] if name != "wayroost-identity"]
    expected["plugins"]["disabled"].append("wayroost-identity")
    actual = namespace["plugin_lists_text"](original, expected, tools, "wayroost-identity")
    assert yaml.safe_load(actual) == expected
    for comment in re.findall(r"#[^\r\n]*", original):
        assert comment in actual, (comment, actual)
for original in ("plugins: {} # keep\nmodel: demo\n", "model: demo # keep\n"):
    expected = {"plugins": {"enabled": ["wayroost-identity"], "disabled": []}, "model": "demo"}
    actual = namespace["plugin_lists_text"](original, expected, tools, "wayroost-identity")
    assert yaml.safe_load(actual) == expected
    assert "# keep" in actual
`);
});
