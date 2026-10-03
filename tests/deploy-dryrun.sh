#!/usr/bin/env bash
# Exercise plans only: never run either installer without --dry-run.
set -euo pipefail
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd -P)"
FIXTURE="$(mktemp -d "$REPO/.deploy-test-XXXXXX")"
trap 'rm -rf -- "$FIXTURE"' EXIT
ROOT="$FIXTURE/root"
mkdir -p "$ROOT" "$FIXTURE/blocked"

fail() { echo "FAIL: $*" >&2; exit 1; }
contains() { [[ "$OUTPUT" == *"$1"* ]] || fail "missing plan: $1"; }
absent() { [[ "$OUTPUT" != *"$1"* ]] || fail "unexpected plan: $1"; }
reject() {
  if bash "$@" > "$FIXTURE/rejected" 2>&1; then fail 'invalid arguments were accepted'; fi
}
# If a dry run accidentally executes any mutation, it fails without touching
# the host. Node still runs to render JSON; npm is only named in the plan.
for command in systemctl groupadd groupdel install rsync chmod chown rm npm; do
  cat > "$FIXTURE/blocked/$command" <<'SH'
#!/usr/bin/env bash
echo 'FAIL: dry-run executed a host-changing command' >&2
exit 99
SH
  chmod +x "$FIXTURE/blocked/$command"
done
SAFE_PATH="$FIXTURE/blocked:$PATH"
plan() { OUTPUT="$(PATH="$SAFE_PATH" bash "$@" --dry-run --root "$ROOT")"; }

plan "$REPO/deploy/install-supervisor.sh" --status-only \
  --launch-script /home/me/demo/launch.sh --coder-script /home/me/demo/launch-vllm.sh --hold-dir /home/me/demo/logs
contains "install -d -m 0755 -o root -g root -- $ROOT/opt/wayroost/supervisor"
contains "install -d -m 0750 -o root -g root -- $ROOT/etc/wayroost"
contains "install -d -m 0700 -o root -g root -- $ROOT/var/lib/wayroost-supervisor"
contains "WRITE $ROOT/etc/wayroost/supervisor.json mode=0600 owner=root:root"
contains '"statusOnly": true'
contains '"launchScript": "/home/me/demo/launch.sh"'
contains '"coderScript": "/home/me/demo/launch-vllm.sh"'
contains '"holdDir": "/home/me/demo/logs"'
contains 'VERIFY /home/me/demo/launch.sh is root-owned and not group- or other-writable along its whole path'
contains 'VERIFY /home/me/demo/launch-vllm.sh is root-owned'
absent 'VERIFY /home/me/demo/logs'
contains '"keysFile": "/etc/wayroost/supervisor-keys.json"'
contains "WRITE $ROOT/etc/systemd/system/wayroost-supervisor.service mode=0644 owner=root:root"
contains 'User=root'; contains 'Group=wayroost'; contains 'ProtectSystem=strict'
contains 'ReadWritePaths=/var/lib/wayroost-supervisor /run/wayroost'
contains 'RuntimeDirectory=wayroost'; contains 'RuntimeDirectoryMode=0750'
contains 'Restart=on-failure'; absent 'NoNewPrivileges=yes'
contains 'LoadCredential=loopback-tls-key:/etc/wayroost/supervisor-tls-key.pem'
contains 'LoadCredential=loopback-tls-cert:/etc/wayroost/supervisor-tls-cert.pem'
contains '"development": false'; contains '"tls": {'
contains "TLS private key $ROOT/etc/wayroost/supervisor-tls-key.pem mode=0600 owner=root:root (never printed)"
absent 'BEGIN PRIVATE KEY'; absent 'BEGIN EC PRIVATE KEY'
contains 'systemctl enable wayroost-supervisor.service'
contains 'systemctl restart wayroost-supervisor.service'
contains 'GENERATE two 256-bit keys from /dev/urandom'
contains "WRITE $ROOT/etc/wayroost/supervisor-keys.json mode=0600 owner=root:root (SHA-256 hashes only)"
contains "WRITE $ROOT/etc/wayroost/server-key mode=0600 owner=root:root"
contains 'DISPLAY rescue key ONCE on /dev/tty only'
plan "$REPO/deploy/install-supervisor.sh"
contains '"statusOnly": true'
contains "WRITE $ROOT/etc/wayroost/components.local.json mode=0600 owner=root:root"
contains '"id": "main-model"'; contains '"url": "http://127.0.0.1:19001/health"'
plan "$REPO/deploy/install-supervisor.sh" --enable-actions
contains '"statusOnly": true'
printf '[{"id":"main-model","name":"Demo operator model"}]\n' > "$FIXTURE/components.json"
plan "$REPO/deploy/install-supervisor.sh" --components-file "$FIXTURE/components.json" --enable-actions
contains '"statusOnly": false'
contains "WRITE $ROOT/etc/wayroost/components.local.json mode=0600 owner=root:root"
contains '"name": "Demo operator model"'
absent "install -m 0600 -o root -g root -- $FIXTURE/components.json"
plan "$REPO/deploy/install-supervisor.sh" --components-file "$REPO/deploy/components.example.json" --enable-actions
contains '"statusOnly": true'
reject "$REPO/deploy/install-supervisor.sh" --dry-run --components-file relative
reject "$REPO/deploy/install-supervisor.sh" --dry-run --components-file "$FIXTURE/absent.json"
printf '[{"name":"Invalid entry"}]\n' > "$FIXTURE/invalid-components.json"
reject "$REPO/deploy/install-supervisor.sh" --dry-run --components-file "$FIXTURE/invalid-components.json"
echo 'PASS supervisor: status-only default, paths, modes, adopt config, keys, runtime directory and root unit'

[[ -z "$(find "$ROOT" -mindepth 1 -print -quit)" ]] || fail 'dry-run created files'
mkdir -p "$ROOT/etc/wayroost"
printf 'obviously-fake-retained-key\n' > "$ROOT/etc/wayroost/server-key"
printf 'obviously-fake-retained-hashes\n' > "$ROOT/etc/wayroost/supervisor-keys.json"
printf '{"adopt":{"launchScript":"/home/me/demo/old-launch.sh","coderScript":"/home/me/demo/old-coder.sh","holdDir":"/home/me/demo/logs"}}\n' > "$ROOT/etc/wayroost/supervisor.json"
cat > "$ROOT/etc/wayroost/config.json" <<'JSON'
{"role":"primary","listen":{"host":"0.0.0.0","port":19010},"stateDir":"/var/lib/signalbox","publicOrigin":"https://wayroost.example.com","bridge":{"enabled":true},"helper":{"enabled":true},"feed":{"enabled":true},"supervisor":{"socket":"/srv/demo/other.sock","keyFile":"/srv/demo/supervisor-key"}}
JSON
BEFORE="$(find "$ROOT" -type f -exec sha256sum {} + | sort)"
plan "$REPO/deploy/install-supervisor.sh" --components-file "$FIXTURE/components.json" --enable-actions --launch-script '/home/me/demo/a "quoted" launch.sh'
contains '"statusOnly": false'
contains '"launchScript": "/home/me/demo/a \"quoted\" launch.sh"'
contains '"holdDir": "/home/me/demo/logs"'
contains 'VERIFY /home/me/demo/a "quoted" launch.sh is root-owned'
contains 'VERIFY /home/me/demo/old-coder.sh is root-owned'
absent 'VERIFY /home/me/demo/old-launch.sh'
contains 'KEEP existing keys; the rescue key is not printed again.'
absent 'GENERATE two 256-bit'; absent 'DISPLAY'; absent 'obviously-fake-retained-key'
echo 'PASS supervisor updates: keys retained, adopt paths merged, JSON escaped, merged launchers verified'

plan "$REPO/deploy/install-supervisor.sh" --remove
contains 'systemctl disable --now wayroost-supervisor.service'
contains "rm -rf -- $ROOT/opt/wayroost/supervisor $ROOT/var/lib/wayroost-supervisor $ROOT/run/wayroost"
contains "rm -f -- $ROOT/etc/wayroost/supervisor.json"
contains 'KEEP supervisor-keys.json and server-key'
absent "rm -f -- $ROOT/etc/wayroost/supervisor-keys.json"
plan "$REPO/deploy/install-supervisor.sh" --remove --purge
contains "rm -f -- $ROOT/etc/wayroost/supervisor-keys.json $ROOT/etc/wayroost/server-key"
contains 'groupdel wayroost (only if neither Wayroost unit remains and the group has no members)'
echo 'PASS supervisor removal: stops own unit, removes own files, keys require explicit purge'

plan "$REPO/deploy/install-wayroost-server.sh"
contains "install -d -m 0755 -o root -g root -- $ROOT/opt/wayroost/server"
contains "WRITE $ROOT/etc/wayroost/config.json mode=0600 owner=root:root"
contains '"role": "shadow"'; contains '"host": "127.0.0.1"'; contains '"port": 8881'
contains '"stateDir": "/var/lib/wayroost-shadow"'
contains "\"supervisor\": {"$'\n'"    \"socket\": \"/run/wayroost/supervisor.sock\""$'\n'"  }"
absent '"keyFile"'
# Each writer is off by name, so a feature the shadow may run (pairing) can be on.
for key in bridge helper feed; do contains "\"$key\": {"$'\n'"    \"enabled\": false"$'\n'"  }"; done
contains "WRITE $ROOT/etc/systemd/system/wayroost-server.service mode=0644 owner=root:root"
contains 'DynamicUser=yes'; contains 'SupplementaryGroups=wayroost'
contains 'LoadCredential=supervisor-server-key:/etc/wayroost/server-key'
contains 'LoadCredential=config.json:/etc/wayroost/config.json'
contains 'LoadCredential=loopback-tls-key:/etc/wayroost/server-tls-key.pem'
contains 'LoadCredential=loopback-tls-cert:/etc/wayroost/server-tls-cert.pem'
contains '"tls": {'; contains '"https://127.0.0.1:8881"'
contains 'REQUIRE /etc/wayroost/supervisor-tls-cert.pem (re-run install-supervisor.sh if missing)'
absent 'http://127.0.0.1:8881'
contains "TLS private key $ROOT/etc/wayroost/server-tls-key.pem mode=0600 owner=root:root (never printed)"
absent 'BEGIN PRIVATE KEY'; absent 'BEGIN EC PRIVATE KEY'
contains 'Environment=WAYROOST_ROLE=shadow'; contains 'Environment=WAYROOST_CONFIG=%d/config.json'
contains 'StateDirectory=wayroost-shadow'; contains 'StateDirectoryMode=0700'
contains 'NoNewPrivileges=yes'; contains 'ProtectSystem=strict'; contains 'Restart=on-failure'
contains 'systemctl enable wayroost-server.service'; contains 'systemctl restart wayroost-server.service'
absent 'signalbox.service'; absent '/etc/signalbox'; absent '/var/lib/signalbox'
# The pairing wrapper: root-only, its paths fixed at install, the device kind always explicit.
contains "WRITE $ROOT/usr/local/sbin/wayroost mode=0750 owner=root:root"
contains "PAIR_CODE='/opt/wayroost/server/dist/server/pair-code.js'"
contains "CONFIG='/etc/wayroost/config.json'"; contains "ID='/usr/bin/id'"
contains 'pair) kind=--phone ;;'; contains 'pair-desktop) kind=--desktop ;;'
absent '@NODE@'; absent '@PAIR_CODE@'
echo 'PASS server: shadow forced on 127.0.0.1:8881, isolated state, credentials, DynamicUser and the pairing wrapper'

plan "$REPO/deploy/install-wayroost-server.sh" --remove
contains 'systemctl disable --now wayroost-server.service'
contains "rm -rf -- $ROOT/opt/wayroost/server"
contains "rm -f -- $ROOT/etc/wayroost/config.json $ROOT/usr/local/sbin/wayroost"
contains "rm -rf -- $ROOT/var/lib/wayroost-shadow $ROOT/var/lib/private/wayroost-shadow"
absent 'signalbox.service'; absent 'server-key'; absent 'supervisor-keys.json'
AFTER="$(find "$ROOT" -type f -exec sha256sum {} + | sort)"
[[ "$BEFORE" == "$AFTER" ]] || fail 'dry-run changed fixture files'
[[ "$(find "$ROOT" -type f | wc -l)" -eq 4 ]] || fail 'dry-run created fixture files'
echo 'PASS server removal and all dry runs: no file changes or host mutations'

mkdir -p "$FIXTURE/registry-root/etc/wayroost"
cp "$FIXTURE/components.json" "$FIXTURE/registry-root/etc/wayroost/components.local.json"
REGISTRY_BEFORE="$(sha256sum "$FIXTURE/registry-root/etc/wayroost/components.local.json")"
OUTPUT="$(PATH="$SAFE_PATH" bash "$REPO/deploy/install-supervisor.sh" --dry-run --root "$FIXTURE/registry-root" --enable-actions)"
contains '"statusOnly": false'
contains "WRITE $FIXTURE/registry-root/etc/wayroost/components.local.json mode=0600 owner=root:root"
contains '"name": "Demo operator model"'
[[ "$REGISTRY_BEFORE" == "$(sha256sum "$FIXTURE/registry-root/etc/wayroost/components.local.json")" ]] || fail 'registry dry-run changed files'
echo 'PASS component registry: generic status-only fallback, validated snapshot, existing entries retained, invalid input refused'

printf 'obviously-fake-paseo-password\n' > "$ROOT/etc/wayroost/paseo-password"
BEFORE="$(find "$ROOT" -type f -exec sha256sum {} + | sort)"
plan "$REPO/deploy/install-wayroost-server.sh" --safety-owner demo-owner --safety-paseo-config /home/me/demo-paseo/config.json
contains '"https://127.0.0.1:8881"'; contains '"devices": {'
contains 'LoadCredential=paseo-password:/etc/wayroost/paseo-password'
absent 'obviously-fake-paseo-password'
contains 'LoadCredential=safety-helper-key:/etc/wayroost/safety-helper-key'
contains 'User=demo-owner'; contains 'ReadWritePaths=/home/me/demo-paseo'
# The helper serves the shadow: no changes to the owner's Paseo config on its own.
contains 'Environment=WAYROOST_ROLE=shadow'
contains 'Environment=WAYROOST_SAFETY_CONFIG=%d/safety-helper.json'
contains 'ProtectHome=yes'; contains 'RuntimeDirectoryMode=0750'
contains 'systemctl restart wayroost-paseo-safety.service'
[[ "$BEFORE" == "$(find "$ROOT" -type f -exec sha256sum {} + | sort)" ]] || fail 'Safety dry-run changed files'
echo 'PASS Safety and password: scoped owner helper, paired origin, conditional credential, no file changes'

# Credential ownership is simulated only inside this fake root. No root access is needed.
REAL_STAT="$(command -v stat)"
cat > "$FIXTURE/blocked/stat" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == -c && "$2" == '%a:%u:%g' && "$3" == "$FAKE_CLOUD_KEY" ]]; then
  printf '%s:%s\n' "$("$REAL_STAT" -c '%a' "$3")" "${FAKE_CLOUD_OWNER:-0:0}"
else
  exec "$REAL_STAT" "$@"
fi
SH
chmod +x "$FIXTURE/blocked/stat"
export REAL_STAT FAKE_CLOUD_KEY="$ROOT/etc/wayroost/elevenlabs-api-key"
plan "$REPO/deploy/install-wayroost-server.sh"
absent 'systemctl enable wayroost-voice-cloud.service'
printf 'obviously-fake-elevenlabs-key\n' > "$FAKE_CLOUD_KEY"
chmod 0600 "$FAKE_CLOUD_KEY"
BEFORE="$(find "$ROOT" -type f -exec sha256sum {} + | sort)"
plan "$REPO/deploy/install-wayroost-server.sh"
contains 'systemctl enable wayroost-voice-cloud.service'
contains 'systemctl restart wayroost-voice-cloud.service'
contains 'LoadCredential=elevenlabs-api-key:/etc/wayroost/elevenlabs-api-key'
contains 'RuntimeDirectory=wayroost-voice-cloud'; contains 'Group=wayroost-voice-cloud'
contains 'groupadd --system wayroost-voice-cloud'
contains 'SupplementaryGroups=wayroost wayroost-voice-cloud'
contains 'IPAddressDeny=localhost link-local multicast'
contains 'IPAddressAllow=127.0.0.53'
contains 'InaccessiblePaths=-/mnt -/media -/srv'
contains 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6'
contains 'ReadWritePaths=/run/wayroost-voice-cloud'; absent 'obviously-fake-elevenlabs-key'
[[ "$BEFORE" == "$(find "$ROOT" -type f -exec sha256sum {} + | sort)" ]] || fail 'Cloud dry-run changed files'
# Simulate PATH selection and symlink resolution without creating host binaries.
REAL_NODE="$(command -v node)"
REAL_READLINK="$(command -v readlink)"
cat > "$FIXTURE/node-env" <<'SH'
command() {
  if [[ "$*" == '-v node' ]]; then printf '%s\n' "$FAKE_NODE_SELECTED";
  else builtin command "$@"; fi
}
/usr/local/bin/node() { builtin command "$REAL_NODE" "$@"; }
/usr/bin/node() { builtin command "$REAL_NODE" "$@"; }
readlink() {
  if [[ "$1" == -f && "${@: -1}" == "$FAKE_NODE_SELECTED" ]]; then printf '%s\n' "$FAKE_NODE_REAL";
  else "$REAL_READLINK" "$@"; fi
}
SH
node_plan() {
  OUTPUT="$(REAL_NODE="$REAL_NODE" REAL_READLINK="$REAL_READLINK" FAKE_NODE_SELECTED="$1" FAKE_NODE_REAL="$2" \
    BASH_ENV="$FIXTURE/node-env" PATH="$SAFE_PATH" bash "$REPO/deploy/install-wayroost-server.sh" --dry-run --root "$ROOT")"
  contains 'ExecStart=/opt/wayroost/server/voice-node /opt/wayroost/server/dist/server/voice-cloud.js'
  contains "BindReadOnlyPaths=$2:/opt/wayroost/server/voice-node"
  contains "install -m 0644 -o root -g root -- /dev/null $ROOT/opt/wayroost/server/voice-node"
  contains 'ProtectSystem=strict'; contains 'ProtectHome=yes'
  contains 'InaccessiblePaths=-/mnt -/media -/srv -/opt/signalbox -/usr/local'
  contains 'ReadWritePaths=/run/wayroost-voice-cloud'
  absent 'ExecSearchPath='; absent 'BindPaths='; absent '@NODE_REAL@'
  [[ "$BEFORE" == "$(find "$ROOT" -type f -exec sha256sum {} + | sort)" ]] || fail 'Node dry-run changed files'
}
node_plan /usr/local/bin/node /usr/local/bin/node
node_plan /usr/local/bin/node /usr/local/lib/demo-node/bin/node
node_plan /usr/local/bin/node /usr/bin/node
node_plan /usr/bin/node /usr/bin/node
for node_path in relative '/usr/local/demo node' '/usr/local/%h' '/usr/local/demo:node' '/usr/local/"demo"/node' "/usr/local/'demo'/node"; do
  if REAL_NODE="$REAL_NODE" REAL_READLINK="$REAL_READLINK" FAKE_NODE_SELECTED=/usr/local/bin/node FAKE_NODE_REAL="$node_path" \
    BASH_ENV="$FIXTURE/node-env" PATH="$SAFE_PATH" bash "$REPO/deploy/install-wayroost-server.sh" --dry-run --root "$ROOT" > "$FIXTURE/rejected" 2>&1; then
    fail 'unsafe Node bind path accepted'
  fi
  [[ "$(cat "$FIXTURE/rejected")" == *'Node.js executable needs an absolute path without controls or systemd delimiters.'* ]] || fail 'Node bind path failed for an unrelated reason'
done
echo 'PASS cloud runtime: /usr/local/bin/node, /usr/bin/node and resolved symlink targets are bound as one read-only file outside hidden directories'
chmod 0644 "$FAKE_CLOUD_KEY"
if PATH="$SAFE_PATH" bash "$REPO/deploy/install-wayroost-server.sh" --dry-run --root "$ROOT" > "$FIXTURE/rejected" 2>&1; then fail 'open cloud credential accepted'; fi
chmod 0600 "$FAKE_CLOUD_KEY"
if FAKE_CLOUD_OWNER=1000:1000 PATH="$SAFE_PATH" bash "$REPO/deploy/install-wayroost-server.sh" --dry-run --root "$ROOT" > "$FIXTURE/rejected" 2>&1; then fail 'non-root cloud credential accepted'; fi
rm "$FAKE_CLOUD_KEY"
plan "$REPO/deploy/install-wayroost-server.sh"
contains 'systemctl disable --now wayroost-voice-cloud.service'
contains 'groupdel wayroost-voice-cloud (only if the cloud unit is absent and the group has no members)'
absent 'systemctl enable wayroost-voice-cloud.service'
echo 'PASS cloud voice: conditional unit, credential metadata, redaction, removal, no mutations'

OUTPUT="$(PATH="$SAFE_PATH" bash "$REPO/deploy/install-wayroost-server.sh" --dry-run)"
contains 'CONDITIONAL INSTALL+ENABLE wayroost-voice-cloud if /etc/wayroost/elevenlabs-api-key exists (0600 root:root), else disable --now'
contains 'WRITE /etc/systemd/system/wayroost-voice-cloud.service mode=0644 owner=root:root'
absent 'PLAN systemctl disable --now wayroost-voice-cloud.service'
absent 'PLAN systemctl enable wayroost-voice-cloud.service'
echo 'PASS plain dry run: conditional cloud installation, unit preview, no live credential access'

mkdir -p "$FIXTURE/local-speech/etc/wayroost"
printf '{"publicOrigin":"https://wayroost.example.com","speech":{"enabled":true}}\n' > "$FIXTURE/local-speech/etc/wayroost/config.json"
OUTPUT="$(PATH="$SAFE_PATH" bash "$REPO/deploy/install-wayroost-server.sh" --dry-run --root "$FIXTURE/local-speech")"
contains 'SupplementaryGroups=wayroost signalbox-voice'
contains '"enabled": true'; absent 'systemctl restart signalbox-speech.service'
echo 'PASS local speech: server joins the sealed socket group only when local speech is enabled'

reject "$REPO/deploy/install-supervisor.sh" --root "$ROOT"
reject "$REPO/deploy/install-wayroost-server.sh" --root "$ROOT"
reject "$REPO/deploy/install-supervisor.sh" --dry-run --root /
reject "$REPO/deploy/install-wayroost-server.sh" --dry-run --root relative
reject "$REPO/deploy/install-supervisor.sh" --dry-run --purge
reject "$REPO/deploy/install-supervisor.sh" --dry-run --launch-script relative
reject "$REPO/deploy/install-supervisor.sh" --dry-run --root
reject "$REPO/deploy/install-wayroost-server.sh" --dry-run --unknown
rm "$ROOT/etc/wayroost/server-key"
reject "$REPO/deploy/install-supervisor.sh" --dry-run --root "$ROOT"
echo 'PASS incomplete keys: refuses regeneration rather than rotating a retained key'
mkdir -p "$FIXTURE/empty"
OUTPUT="$(PATH="$SAFE_PATH" bash "$REPO/deploy/install-wayroost-server.sh" --dry-run --root "$FIXTURE/empty")"
contains 'STOPPED: fill in /etc/wayroost/config.json'
absent 'systemctl restart wayroost-server.service'
[[ -z "$(find "$FIXTURE/empty" -mindepth 1 -print -quit)" ]] || fail 'dry-run modified the empty root'
mkdir -p "$FIXTURE/open"; chmod 0777 "$FIXTURE/open"; printf '#!/bin/sh\n' > "$FIXTURE/open/launch.sh"
# shellcheck disable=SC2016
if bash -c 'source "$1"; require_trusted_binary "$2"' _ "$REPO/deploy/lib.sh" "$FIXTURE/open/launch.sh" 2>/dev/null; then
  fail 'a launcher in a writable folder passed the ownership check'
fi
echo 'PASS argument validation and first install: fake root is dry-run-only, placeholders stay stopped'

if command -v shellcheck >/dev/null; then
  cd "$REPO"
  shellcheck -x deploy/wayroost-lib.sh deploy/install-supervisor.sh deploy/install-wayroost-server.sh tests/deploy-dryrun.sh
  echo 'PASS shellcheck'
else
  echo 'SKIP shellcheck: not installed'
fi
echo 'PASS TLS: installed HTTPS configs, independent root:root 0600 private keys, LoadCredential, no private key output'
echo 'PASS deploy dry-run checks'
