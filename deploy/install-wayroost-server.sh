#!/usr/bin/env bash
# Install the built Wayroost server beside Signalbox, in shadow mode only.
set -euo pipefail
set +x

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd -P)"
# shellcheck source=deploy/lib.sh
source "$REPO/deploy/lib.sh"
# shellcheck source=deploy/wayroost-lib.sh
source "$REPO/deploy/wayroost-lib.sh"
DRY_RUN=0 REMOVE=0 PURGE=0 ROOT_PREFIX=''
PASSWORD_FILE=/etc/wayroost/paseo-password SAFETY_OWNER='' SAFETY_CONFIG=''
usage() { echo "Usage: $0 [--dry-run] [--remove] [--paseo-password-file /protected/file] [--safety-owner USER --safety-paseo-config /owner/config.json] [--root /fake-root (dry-run tests only)]"; }
while (( $# )); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --remove) REMOVE=1; shift ;;
    --root|--paseo-password-file|--safety-owner|--safety-paseo-config)
      if (( $# < 2 )) || [[ -z "$2" || "$2" == --* ]]; then fail "Missing value for $1."; fi
      case "$1" in
        --root) ROOT_PREFIX="$2" ;;
        --paseo-password-file) PASSWORD_FILE="$2" ;;
        --safety-owner) SAFETY_OWNER="$2" ;;
        --safety-paseo-config) SAFETY_CONFIG="$2" ;;
      esac
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "Unknown option: $1" ;;
  esac
done
validate_options
preflight

remove_cloud_group() {
  if (( DRY_RUN )); then
    echo 'PLAN groupdel wayroost-voice-cloud (only if the cloud unit is absent and the group has no members)'
  elif [[ ! -f /etc/systemd/system/wayroost-voice-cloud.service ]]; then
    local members
    members="$(getent group wayroost-voice-cloud | cut -d: -f4)" || return 0
    if [[ -z "$members" ]]; then run groupdel wayroost-voice-cloud; fi
  fi
}

if (( REMOVE )); then
  remove_unit wayroost-server
  remove_unit wayroost-voice-cloud
  remove_cloud_group
  remove_unit wayroost-paseo-safety
  run rm -rf -- "$(path_at_root /opt/wayroost/server)"
  run rm -f -- "$(path_at_root /etc/wayroost/config.json)" "$(path_at_root /usr/local/sbin/wayroost)"
  # DynamicUser's StateDirectory may be a symlink into /var/lib/private.
  run rm -rf -- "$(path_at_root /var/lib/wayroost-shadow)" "$(path_at_root /var/lib/private/wayroost-shadow)"
  # Keep the Safety state/undo record and key so a later install can undo the policy.
  echo 'KEEP Safety helper state, settings and key; the Paseo owner config is never removed.'
  remove_shared_directories
  exit 0
fi
require_node
[[ "$PASSWORD_FILE" == /* && "$PASSWORD_FILE" != *[$'\n\r\t"\\% ']* ]] || fail 'Password source must be an absolute path without spaces, controls or systemd specifiers.'
[[ -z "$SAFETY_OWNER" && -z "$SAFETY_CONFIG" || -n "$SAFETY_OWNER" && -n "$SAFETY_CONFIG" ]] || fail 'Supply both Safety owner and Paseo config.'
if [[ -n "$SAFETY_OWNER" ]]; then
  [[ "$SAFETY_OWNER" =~ ^[a-z_][a-z0-9_-]*$ && "$SAFETY_OWNER" != root ]] || fail 'Safety owner must be a non-root Unix user.'
  [[ "$SAFETY_CONFIG" == /* && "$SAFETY_CONFIG" != *[$'\n\r\t"\\% ']* && "$SAFETY_CONFIG" != */../* ]] || fail 'Safety config must be an absolute path without spaces, controls or systemd specifiers.'
  [[ "$(dirname "$SAFETY_CONFIG")" != / ]] || fail 'Safety config needs its own directory.'
fi
PASSWORD_CREDENTIAL=''
CLOUD_VOICE=0
CLOUD_VOICE_UNKNOWN=0
# Inspect metadata only, never credential contents. A normal dry run skips /etc.
if (( ! DRY_RUN )) || [[ -n "$ROOT_PREFIX" ]]; then
  CLOUD_KEY="$(path_at_root /etc/wayroost/elevenlabs-api-key)"
  if [[ -e "$CLOUD_KEY" ]]; then
    [[ -f "$CLOUD_KEY" && ! -L "$CLOUD_KEY" ]] || fail 'ElevenLabs credential must be a regular root-only file.'
    [[ "$(stat -c '%a:%u:%g' "$CLOUD_KEY")" == '600:0:0' ]] || fail 'ElevenLabs credential must have mode 0600 and owner root:root.'
    if (( ! DRY_RUN )); then require_trusted_binary "$CLOUD_KEY"; fi
    CLOUD_VOICE=1
  fi
else
  CLOUD_VOICE_UNKNOWN=1
  echo 'CONDITIONAL INSTALL+ENABLE wayroost-voice-cloud if /etc/wayroost/elevenlabs-api-key exists (0600 root:root), else disable --now and remove the cloud unit and unused group.'
fi
# No credential contents are read or printed, including in a fake-root plan.
if (( ! DRY_RUN )) || [[ -n "$ROOT_PREFIX" ]]; then
  if [[ -f "$(path_at_root "$PASSWORD_FILE")" ]]; then
    if (( ! DRY_RUN )); then
      require_trusted_binary "$PASSWORD_FILE"
      [[ "$(stat -c '%a' "$PASSWORD_FILE")" == 600 ]] || fail 'Paseo password must have mode 0600, owned by root.'
    fi
    PASSWORD_CREDENTIAL="LoadCredential=paseo-password:$PASSWORD_FILE"
  fi
fi

if (( ! DRY_RUN )); then
  [[ -s /etc/wayroost/server-key ]] || fail 'Install the supervisor first; its server-key is required by LoadCredential.'
fi
require_supervisor_tls
CONFIG_PATH="$(path_at_root /etc/wayroost/config.json)"
CONFIG_SOURCE="$REPO/deploy/wayroost-config.example.json"
# Never read a live config during dry-run without the tests' fake root.
if (( ! DRY_RUN )) || [[ -n "$ROOT_PREFIX" ]]; then
  if [[ -f "$CONFIG_PATH" ]]; then CONFIG_SOURCE="$CONFIG_PATH"; fi
fi
CONFIG="$("$NODE" --input-type=module - "$CONFIG_SOURCE" "$SAFETY_OWNER" <<'JS'
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
config.role = 'shadow';
config.listen = { host: '127.0.0.1', port: 8881 };
// A shadow's own state: the server refuses a primary-owned directory such as /var/lib/wayroost.
config.stateDir = '/var/lib/wayroost-shadow';
config.staticDir = '/opt/wayroost/server/dist/web';
config.tls = { certFile: '/etc/wayroost/server-tls-cert.pem' };
config.origins = [...new Set([...(config.origins ?? []).filter(value => !/^http:\/\/(127\.|localhost)/.test(value)), 'https://127.0.0.1:8881'])];
config.devices = { ...config.devices, enabled: true };
if (process.argv[3]) config.safetyHelper = { socket: '/run/wayroost-paseo-safety/helper.sock' };
// These listeners and writers stay off even before the runtime's shadow gates.
for (const key of ['bridge', 'helper', 'feed']) config[key] = { ...config[key], enabled: false };
// Status & power through the supervisor's socket. Its key comes as the systemd
// credential supervisor-server-key (see the unit), never from a file named here.
config.supervisor = { socket: '/run/wayroost/supervisor.sock' };
console.log(JSON.stringify(config, null, 2));
JS
)"

install_group
install_build server /opt/wayroost/server index.js
if (( CLOUD_VOICE || CLOUD_VOICE_UNKNOWN )); then
  CLOUD_NODE="$(readlink -f -- "$NODE")" || fail 'Cannot resolve the Node.js executable.'
  [[ "$CLOUD_NODE" == /* && "$CLOUD_NODE" != *[[:cntrl:][:space:]\"\':%\\]* ]] || fail 'Node.js executable needs an absolute path without controls or systemd delimiters.'
  # A file mount outside the hidden trees exposes only the validated binary.
  run install -m 0644 -o root -g root -- /dev/null "$(path_at_root /opt/wayroost/server/voice-node)"
  if (( CLOUD_VOICE_UNKNOWN )); then
    echo 'CONDITIONAL groupadd --system wayroost-voice-cloud (only when the credential exists and the group is absent)'
  elif (( DRY_RUN )) || ! getent group wayroost-voice-cloud >/dev/null; then
    run groupadd --system wayroost-voice-cloud
  fi
  CLOUD_UNIT="$(cat "$REPO/deploy/wayroost-voice-cloud.service")"
  CLOUD_UNIT="${CLOUD_UNIT/BindReadOnlyPaths=\/usr\/bin\/node:/BindReadOnlyPaths=$CLOUD_NODE:}"
  # Avoid install_unit's PATH substitution: this source is already canonical.
  directory /etc/systemd/system 0755
  write_file /etc/systemd/system/wayroost-voice-cloud.service 0644 "$CLOUD_UNIT"
fi
directory /etc/wayroost 0750
install_tls server /opt/wayroost/server/dist/server/tls-certificates.js
write_file /etc/wayroost/config.json 0600 "$CONFIG"
# `sudo wayroost pair` / `sudo wayroost pair-desktop`: root-only, every path fixed here.
WRAPPER="$(cat "$REPO/deploy/wayroost.sh")"
WRAPPER="${WRAPPER//@NODE@/$NODE}"
WRAPPER="${WRAPPER//@PAIR_CODE@//opt/wayroost/server/dist/server/pair-code.js}"
WRAPPER="${WRAPPER//@CONFIG@//etc/wayroost/config.json}"
WRAPPER="${WRAPPER//@ID@//usr/bin/id}"
directory /usr/local/sbin 0755
write_file /usr/local/sbin/wayroost 0750 "$WRAPPER"
SERVER_UNIT="$(cat "$REPO/deploy/wayroost-server.service")"
if (( CLOUD_VOICE || CLOUD_VOICE_UNKNOWN )); then
  SERVER_UNIT="${SERVER_UNIT/SupplementaryGroups=wayroost/SupplementaryGroups=wayroost wayroost-voice-cloud}"
fi
LOCAL_SPEECH="$("$NODE" --input-type=module - "$CONFIG" <<'JS'
console.log(JSON.parse(process.argv[2]).speech?.enabled === true ? 'yes' : 'no');
JS
)"
if [[ "$LOCAL_SPEECH" == yes ]]; then
  if (( ! DRY_RUN )); then getent group signalbox-voice >/dev/null || fail 'Set up the local speech service first; its socket group is missing.'; fi
  SERVER_UNIT="${SERVER_UNIT/SupplementaryGroups=wayroost/SupplementaryGroups=wayroost signalbox-voice}"
fi
if [[ -n "$PASSWORD_CREDENTIAL" ]]; then SERVER_UNIT="${SERVER_UNIT/Restart=on-failure/$PASSWORD_CREDENTIAL$'\n'Restart=on-failure}"; fi

HELPER_SETTINGS="$(path_at_root /etc/wayroost/safety-helper.json)"
if [[ -n "$SAFETY_OWNER" ]]; then
  HELPER_SETTINGS_JSON="$("$NODE" --input-type=module - "$SAFETY_CONFIG" "$CONFIG" <<'JS'
const config = JSON.parse(process.argv[3]);
console.log(JSON.stringify({ configPath: process.argv[2], url: config.paseo?.url ?? 'ws://127.0.0.1:19007' }, null, 2));
JS
)"
  write_file /etc/wayroost/safety-helper.json 0600 "$HELPER_SETTINGS_JSON"
  SAFETY_KEY="$(path_at_root /etc/wayroost/safety-helper-key)"
  if (( DRY_RUN )); then
    echo 'KEEP or GENERATE safety-helper-key mode=0600 owner=root:root (never printed)'
  elif [[ ! -f "$SAFETY_KEY" ]]; then
    "$NODE" --input-type=module - "$SAFETY_KEY" <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
JS
  fi
  if (( ! DRY_RUN )); then
    require_trusted_binary "$SAFETY_KEY"
    [[ "$(stat -c '%a' "$SAFETY_KEY")" == 600 && -s "$SAFETY_KEY" ]] || fail 'Safety helper key must be nonempty, mode 0600 and owned by root.'
  fi
  HELPER_UNIT="$(cat "$REPO/deploy/wayroost-paseo-safety.service")"
  HELPER_UNIT="${HELPER_UNIT//YOUR-OWNER/$SAFETY_OWNER}"
  HELPER_UNIT="${HELPER_UNIT//YOUR-PASEO-DIRECTORY/$(dirname "$SAFETY_CONFIG")}"
  if [[ -n "$PASSWORD_CREDENTIAL" ]]; then HELPER_UNIT="${HELPER_UNIT/Restart=on-failure/$PASSWORD_CREDENTIAL$'\n'Restart=on-failure}"; fi
  install_unit wayroost-paseo-safety "$HELPER_UNIT"
fi
# Reinstalls retain an already configured helper and its credential.
if [[ -n "$SAFETY_OWNER" ]] || { { (( ! DRY_RUN )) || [[ -n "$ROOT_PREFIX" ]]; } && [[ -f "$HELPER_SETTINGS" ]]; }; then
  SERVER_UNIT="${SERVER_UNIT/Restart=on-failure/LoadCredential=safety-helper-key:\/etc\/wayroost\/safety-helper-key$'\n'Restart=on-failure}"
fi
install_unit wayroost-server "$SERVER_UNIT"
echo 'STATE /var/lib/wayroost-shadow mode=0700 (StateDirectory=wayroost-shadow, managed by DynamicUser)'
echo 'REQUIRE /etc/wayroost/server-key mode=0600 owner=root:root (from supervisor; never copied or printed)'
echo 'REQUIRE /etc/wayroost/supervisor-tls-cert.pem (re-run install-supervisor.sh if missing)'
run systemctl daemon-reload
if (( CLOUD_VOICE )); then
  run systemctl enable wayroost-voice-cloud.service
  run systemctl restart wayroost-voice-cloud.service
elif (( ! CLOUD_VOICE_UNKNOWN )); then
  # Re-running after removing the credential also turns off the old cloud process.
  remove_unit wayroost-voice-cloud
  remove_cloud_group
fi
if [[ -n "$SAFETY_OWNER" ]]; then
  run systemctl enable wayroost-paseo-safety.service
  run systemctl restart wayroost-paseo-safety.service
fi
if [[ "$CONFIG" == *YOUR-* ]]; then
  echo 'STOPPED: fill in /etc/wayroost/config.json with your own values, then re-run this installer.'
else
  run systemctl enable wayroost-server.service
  run systemctl restart wayroost-server.service
fi
echo 'Wayroost server planned/installed: shadow on 127.0.0.1:8881, state /var/lib/wayroost-shadow.'
