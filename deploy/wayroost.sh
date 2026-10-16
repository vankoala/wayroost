#!/bin/bash -p
# wayroost pair | wayroost pair-desktop: a single-use pairing code from the running
# Wayroost server, asked through its recovery socket (root and the service only).
# install-wayroost-server.sh installs this as /usr/local/sbin/wayroost (root, 0750)
# with the @...@ paths filled in; it never takes a path from its caller.
set -euo pipefail
NODE='@NODE@'
PAIR_CODE='@PAIR_CODE@'
CONFIG='@CONFIG@'
ID='@ID@'

usage() { echo 'Usage: sudo wayroost pair          (a phone)' >&2; echo '       sudo wayroost pair-desktop  (the desktop app)' >&2; echo '       sudo wayroost fingerprints (offline public fingerprints)' >&2; echo '       sudo wayroost rotate-tls server|supervisor' >&2; echo '       sudo wayroost hold         (pause new bridge work; JSON)' >&2; echo '       sudo wayroost release      (allow new bridge work; JSON)' >&2; echo '       sudo wayroost quiet        (read drain counts; JSON)' >&2; }
if [[ "${1:-}" == rotate-tls ]]; then
  [[ $# == 2 && ( "$2" == server || "$2" == supervisor ) ]] || { usage; exit 2; }
  [[ "$("$ID" -u)" == 0 ]] || { echo 'Run certificate rotation as root.' >&2; exit 1; }
  output="$(/usr/bin/env -i PATH=/usr/bin:/bin "$NODE" "${PAIR_CODE%/*}/tls-certificates.js" "$2" rotate)"
  [[ "$output" =~ ^$2\ fingerprint:\ sha256/[A-Za-z0-9+/]{43}=$ ]] || { echo 'TLS tool did not confirm rotation; no service was restarted.' >&2; exit 1; }
  printf '%s\n' "$output"
  exec /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/systemctl restart "wayroost-$2.service"
fi
(( $# == 1 )) || { usage; exit 2; }
case "$1" in
  hold|release|quiet)
    [[ "$("$ID" -u)" == 0 ]] || { echo 'Run this as root: sudo wayroost '"$1" >&2; exit 1; }
    exec /usr/bin/env -i PATH=/usr/bin:/bin WAYROOST_ROLE="${WAYROOST_ROLE:-${SIGNALBOX_ROLE:-}}" "$NODE" --input-type=module - "$CONFIG" "$1" <<'JS'
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
try {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const override = process.env.WAYROOST_ROLE;
  if (override && override !== 'primary' && override !== 'shadow') throw new Error('Invalid server role.');
  const role = config.role === 'shadow' || override === 'shadow' ? 'shadow' : 'primary';
  const stateDir = config.stateDir ?? (role === 'shadow' ? '/var/lib/wayroost-shadow' : '/var/lib/wayroost');
  if (typeof stateDir !== 'string' || !stateDir.startsWith('/')) throw new Error('The fixed config needs an absolute state directory.');
  const result = await new Promise((resolve, reject) => {
    const socket = connect(join(stateDir, 'bridge-admin', 'admin.sock'));
    let output = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5_000, () => socket.destroy(new Error('The server did not answer.')));
    socket.on('connect', () => socket.write(`${JSON.stringify({ command: process.argv[3] })}\n`));
    socket.on('data', chunk => {
      output += chunk;
      if (output.length > 8192) socket.destroy(new Error('The server response was too large.'));
    });
    socket.on('error', reject);
    socket.on('close', () => {
      try {
        const reply = JSON.parse(output);
        if (reply.error) reject(new Error(reply.message ?? 'The maintenance command failed.'));
        else resolve(reply);
      } catch { reject(new Error('The server gave no maintenance response.')); }
    });
  });
  console.log(JSON.stringify(result));
} catch {
  console.error('Maintenance command failed. Check the running server and its fixed state directory.');
  process.exitCode = 1;
}
JS
    ;;
  pair) kind=--phone ;;
  pair-desktop) kind=--desktop ;;
  fingerprints)
    [[ "$("$ID" -u)" == 0 ]] || { echo 'Run this as root: sudo wayroost fingerprints' >&2; exit 1; }
    exec /usr/bin/env -i PATH=/usr/bin:/bin "$NODE" "${PAIR_CODE%/*}/tls-certificates.js" fingerprints ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac
[[ "$("$ID" -u)" == 0 ]] || { echo 'Run this as root: sudo wayroost '"$1" >&2; exit 1; }
exec /usr/bin/env -i PATH=/usr/bin:/bin "$NODE" "$PAIR_CODE" "$kind" --config "$CONFIG"
