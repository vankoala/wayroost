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

usage() { echo 'Usage: sudo wayroost pair          (a phone)' >&2; echo '       sudo wayroost pair-desktop  (the desktop app)' >&2; echo '       sudo wayroost fingerprints (offline public fingerprints)' >&2; echo '       sudo wayroost rotate-tls server|supervisor' >&2; }
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
