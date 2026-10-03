#!/usr/bin/env bash
# Install the already-built supervisor. Run as root from a root-owned checkout.
# Status-only by default; --enable-actions opts into component actions.
set +x
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd -P)"
# shellcheck source=deploy/lib.sh
source "$REPO/deploy/lib.sh"
# shellcheck source=deploy/wayroost-lib.sh
source "$REPO/deploy/wayroost-lib.sh"
DRY_RUN=0 REMOVE=0 PURGE=0 ROOT_PREFIX='' STATUS_ONLY=true
LAUNCH_SCRIPT='' CODER_SCRIPT='' HOLD_DIR='' COMPONENTS_FILE=''

usage() {
  echo "Usage: $0 [--components-file /path/components.json] [--launch-script /path/launch.sh] [--coder-script /path/launch-vllm.sh] [--hold-dir /path/logs] [--status-only|--enable-actions] [--dry-run] [--remove [--purge]] [--root /fake-root (dry-run tests only)]"
}
while (( $# )); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --remove) REMOVE=1; shift ;;
    --purge) PURGE=1; shift ;;
    --status-only) STATUS_ONLY=true; shift ;;
    --enable-actions) STATUS_ONLY=false; shift ;;
    --root|--launch-script|--coder-script|--hold-dir|--components-file)
      if (( $# < 2 )) || [[ -z "$2" || "$2" == --* ]]; then fail "Missing value for $1."; fi
      case "$1" in
        --root) ROOT_PREFIX="$2" ;;
        --launch-script) LAUNCH_SCRIPT="$2" ;;
        --coder-script) CODER_SCRIPT="$2" ;;
        --hold-dir) HOLD_DIR="$2" ;;
        --components-file) COMPONENTS_FILE="$2" ;;
      esac
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "Unknown option: $1" ;;
  esac
done
validate_options
preflight

if (( REMOVE )); then
  remove_unit wayroost-supervisor
  run rm -rf -- "$(path_at_root /opt/wayroost/supervisor)" "$(path_at_root /var/lib/wayroost-supervisor)" "$(path_at_root /run/wayroost)"
  run rm -f -- "$(path_at_root /etc/wayroost/supervisor.json)"
  if (( PURGE )); then
    run rm -f -- "$(path_at_root /etc/wayroost/supervisor-keys.json)" "$(path_at_root /etc/wayroost/server-key)"
  else
    echo 'KEEP supervisor-keys.json and server-key (use --remove --purge to erase keys).'
  fi
  remove_shared_directories
  exit 0
fi
require_node

REGISTRY="$(path_at_root /etc/wayroost/components.local.json)"
REGISTRY_SOURCE="$COMPONENTS_FILE"
if [[ -n "$REGISTRY_SOURCE" ]]; then
  [[ "$REGISTRY_SOURCE" == /* && -f "$REGISTRY_SOURCE" ]] || fail '--components-file needs an absolute path to a JSON file.'
elif (( ! DRY_RUN )) || [[ -n "$ROOT_PREFIX" ]]; then
  if [[ -f "$REGISTRY" ]]; then REGISTRY_SOURCE="$REGISTRY"; fi
fi
if [[ -z "$REGISTRY_SOURCE" ]]; then REGISTRY_SOURCE="$REPO/deploy/components.example.json"; fi

# Pass values as argv to JSON.stringify, never interpolate paths into JSON/shell.
READ_EXISTING=true
if (( DRY_RUN )) && [[ -z "$ROOT_PREFIX" ]]; then READ_EXISTING=false; fi
CONFIG="$("$NODE" --input-type=module - "$(path_at_root /etc/wayroost/supervisor.json)" "$STATUS_ONLY" "$LAUNCH_SCRIPT" "$CODER_SCRIPT" "$HOLD_DIR" "$READ_EXISTING" <<'JS'
import { existsSync, readFileSync } from 'node:fs';
const [path, statusOnly, launchScript, coderScript, holdDir, readExisting] = process.argv.slice(2);
const previous = readExisting === 'true' && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const adopt = { ...previous.adopt };
for (const [key, value] of Object.entries({ launchScript, coderScript, holdDir })) if (value) adopt[key] = value;
// Merged values from an existing supervisor.json get the same checks as new ones.
for (const [key, value] of Object.entries(adopt)) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f]/.test(value)) throw new Error(`${key} must be an absolute path without control characters.`);
}
console.log(JSON.stringify({ ...previous, socket: '/run/wayroost/supervisor.sock', rescueHost: '127.0.0.1', rescuePort: 8880,
  keysFile: '/etc/wayroost/supervisor-keys.json', stateDir: '/var/lib/wayroost-supervisor',
  registryOverrides: '/etc/wayroost/components.local.json', development: false, tls: { certFile: '/etc/wayroost/supervisor-tls-cert.pem' }, statusOnly: statusOnly === 'true', adopt }, null, 2));
JS
)"

# Dry runs use source and local fixtures; live installs use the already-built validator.
REGISTRY_MODULE="$REPO/dist/supervisor/supervisor/src/install-registry.js"
NODE_OPTIONS_REGISTRY=()
if (( DRY_RUN )); then
  REGISTRY_MODULE="$REPO/supervisor/src/install-registry.ts"
  NODE_OPTIONS_REGISTRY=(--import tsx)
else
  [[ -f "$REGISTRY_MODULE" ]] || fail 'Build first: npm run build:supervisor.'
  # Validation imports Zod before install_build replaces the installed dependencies.
  require_trusted_binary "$REPO/node_modules/zod/package.json"
  require_root_owned_tree "$REPO/node_modules/zod"
fi
REGISTRY_PLAN="$("$NODE" "${NODE_OPTIONS_REGISTRY[@]}" --input-type=module - "$REGISTRY_MODULE" "$REGISTRY_SOURCE" "$CONFIG" "$DRY_RUN" <<'JS'
import { pathToFileURL } from 'node:url';
const [modulePath, source, config, dryRun] = process.argv.slice(2);
const { prepareRegistry } = await import(pathToFileURL(modulePath).href);
// A dry run cannot install commands. Production always uses the full root-only path check.
const snapshot = await prepareRegistry(source, JSON.parse(config).adopt, dryRun === '1' ? async path => path : undefined);
console.log(JSON.stringify(snapshot));
JS
)"
if [[ "$("$NODE" -e 'console.log(JSON.parse(process.argv[1]).generic)' "$REGISTRY_PLAN")" == true ]]; then
  STATUS_ONLY=true
  CONFIG="$("$NODE" -e 'console.log(JSON.stringify({ ...JSON.parse(process.argv[1]), statusOnly: true }, null, 2))' "$CONFIG")"
  echo 'Generic example registry: actions remain disabled. Supply --components-file with the installed layout before enabling actions.'
fi
REGISTRY_CONTENTS="$("$NODE" -e 'process.stdout.write(JSON.parse(process.argv[1]).contents)' "$REGISTRY_PLAN")"

# Root runs both launchers, so nobody else may be able to change them (the file,
# its folders, any symlink on the way). The supervisor repeats this before every launch.
while IFS= read -r -d '' script; do
  if (( DRY_RUN )); then
    echo "VERIFY $script is root-owned and not group- or other-writable along its whole path (skipped in dry run)"
  else
    require_trusted_binary "$script"
  fi
done < <("$NODE" -e 'const { adopt } = JSON.parse(process.argv[1]); for (const key of ["launchScript", "coderScript"]) if (adopt[key]) process.stdout.write(adopt[key] + "\0");' "$CONFIG")

KEYS="$(path_at_root /etc/wayroost/supervisor-keys.json)"
SERVER_KEY="$(path_at_root /etc/wayroost/server-key)"
GENERATE=1
# A plain dry run never examines this machine's keys.
if (( ! DRY_RUN )) || [[ -n "$ROOT_PREFIX" ]]; then
  if [[ -f "$KEYS" && -f "$SERVER_KEY" ]]; then
    GENERATE=0
  elif [[ -e "$KEYS" || -e "$SERVER_KEY" ]]; then
    fail 'Incomplete key pair; refusing to rotate keys. Restore the missing file or explicitly remove with --purge.'
  fi
fi
if (( GENERATE && ! DRY_RUN )); then
  # A controlling terminal avoids stdout/stderr redirection and journald.
  [[ -t 0 ]] || fail 'First install needs an interactive terminal to display the rescue key once.'
  exec 3>/dev/tty || fail 'Cannot open a terminal for the rescue key.'
fi

install_group
install_build supervisor /opt/wayroost/supervisor supervisor/src/index.js
directory /etc/wayroost 0750
directory /var/lib/wayroost-supervisor 0700
write_file /etc/wayroost/supervisor.json 0600 "$CONFIG"
write_file /etc/wayroost/components.local.json 0600 "$REGISTRY_CONTENTS"
install_tls supervisor /opt/wayroost/supervisor/dist/supervisor/scripts/tls-certificates.js
install_unit wayroost-supervisor
echo 'RUNTIME /run/wayroost mode=0750 owner=root:wayroost (RuntimeDirectory=wayroost)'

if (( GENERATE )); then
  if (( DRY_RUN )); then
    printf 'GENERATE two 256-bit keys from /dev/urandom\nWRITE %s mode=0600 owner=root:root (SHA-256 hashes only)\nWRITE %s mode=0600 owner=root:root (raw server key for LoadCredential)\n' "$KEYS" "$SERVER_KEY"
    echo 'DISPLAY rescue key ONCE on /dev/tty only; never stdout, stderr or a log (no key generated during dry-run).'
  else
    "$NODE" --input-type=module - "$KEYS" "$SERVER_KEY" <<'JS'
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, writeFileSync, writeSync, chownSync } from 'node:fs';
const fd = openSync('/dev/urandom', 'r');
function key() {
  const bytes = Buffer.alloc(32);
  let offset = 0;
  while (offset < bytes.length) offset += readSync(fd, bytes, offset, bytes.length - offset, null);
  return bytes.toString('hex');
}
const server = key(), rescue = key();
closeSync(fd);
const hash = value => createHash('sha256').update(value).digest('hex');
writeFileSync(process.argv[2], JSON.stringify([
  { name: 'server', scope: 'server', sha256: hash(server) },
  { name: 'desktop-rescue', scope: 'rescue', sha256: hash(rescue) },
], null, 2) + '\n', { mode: 0o600, flag: 'wx' });
writeFileSync(process.argv[3], server, { mode: 0o600, flag: 'wx' });
chownSync(process.argv[2], 0, 0);
chownSync(process.argv[3], 0, 0);
writeSync(3, `Desktop rescue key (shown once; save it and the supervisor fingerprint printed above for the desktop app's recovery form, not for pairing). Later, sudo wayroost fingerprints reads fingerprints from the root-installed files without a running server:\n${rescue}\n`);
JS
    exec 3>&-
  fi
else
  echo 'KEEP existing keys; the rescue key is not printed again.'
  run chown root:root -- "$KEYS" "$SERVER_KEY"
  run chmod 0600 -- "$KEYS" "$SERVER_KEY"
fi

run systemctl daemon-reload
run systemctl enable wayroost-supervisor.service
run systemctl restart wayroost-supervisor.service
echo "Supervisor planned/installed: statusOnly=$STATUS_ONLY."
