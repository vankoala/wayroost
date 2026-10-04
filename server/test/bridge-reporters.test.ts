import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

const setup = String.raw`
import importlib.util, json, os, re, subprocess, sys
from pathlib import Path
from unittest.mock import Mock, patch

repo, home = map(Path, sys.argv[1:3])
os.environ.clear()
os.environ.update(HOME=str(home), PATH=os.defpath, WAYROOST_ROLE="primary")
script = (repo / "deploy/setup-bridge.sh").read_text()
helper = script.split("HELPER <<'PY' || true\n", 1)[1].split("\nPY\n", 1)[0]

def install_url(mode, url, dry=False):
    return subprocess.run([sys.executable, "-I", "-B", "-c", helper, "bridge-url", mode,
                           str(home / ".config/signalbox/bridge-url"), url, "fake-stamp", str(int(dry))],
                          capture_output=True, text=True, timeout=10)

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

runtime = load("wayroost_runtime", repo / "helper/wayroost_runtime.py")
sys.modules["wayroost_runtime"] = runtime
hook = load("demo_hook", repo / "claude-hook/signalbox-claude-hook.py")
plugin = load("demo_plugin", repo / "hermes-plugin/signalbox-identity/__init__.py")

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

it('keeps both launch reporters on the configured bridge port after an upgrade', () => {
  check(String.raw`
config = home / "config.json"
config.write_text(json.dumps({"bridge": {"enabled": True, "port": 8792}}))
port_script = re.search(r'PORT="\$\(python3 -I - "\$ETC/config.json" <<\x27PY\x27\n(.*?)\nPY\n', script, re.S).group(1)
port = subprocess.check_output([sys.executable, "-I", "-B", "-c", port_script, str(config)], text=True).strip()
assert port == "8792"
url = "http://127.0.0.1:" + port
assert 'helper bridge-url "$MODE" "$UHOME/.config/signalbox/bridge-url" "http://127.0.0.1:$PORT"' in script
result = install_url("add", url)
assert result.returncode == 0, result.stderr
assert report_urls() == [url + "/bridge/v1/note_run", url + "/bridge/v1/note_launch"]
assert install_url("add", url).returncode == 3
default_url = "http://127.0.0.1:19012"
assert install_url("add", default_url).returncode == 0
assert report_urls() == [default_url + "/bridge/v1/note_run", default_url + "/bridge/v1/note_launch"]
assert install_url("remove", default_url).returncode == 0
assert not (home / ".config/signalbox/bridge-url").exists()
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
target = home / ".config/signalbox/bridge-url"
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
