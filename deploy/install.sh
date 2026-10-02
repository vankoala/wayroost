#!/usr/bin/env bash
# Build Signalbox and (re)install it to /opt/signalbox. Run as root:
#   sudo /opt/src/signalbox/deploy/install.sh
# Safe to re-run for updates. Signalbox starts once /etc/signalbox/config.json
# is filled in; deploy/setup-tunnel.sh fills in the Access values and starts it.
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd -P)"
# shellcheck source=deploy/lib.sh
source "$REPO/deploy/lib.sh"
DEST=/opt/signalbox
ETC=/etc/signalbox

require_root
# This script runs code from $REPO as root, so only root may be able to change
# it (otherwise an agent running as your user could swap it).
require_root_owned_tree "$REPO"

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "Node.js 22 or newer is required (node not found)." >&2
  exit 1
fi
require_trusted_binary "$NODE"
NPM="$(command -v npm || true)"
if [[ -z "$NPM" ]]; then
  echo "npm is required (npm not found)." >&2
  exit 1
fi
require_trusted_binary "$NPM"
if (( $("$NODE" -p 'process.versions.node.split(".")[0]') < 22 )); then
  echo "Node.js 22 or newer is required (found $("$NODE" --version))." >&2
  exit 1
fi

cd "$REPO"
echo "==> Installing build dependencies"
"$NPM" ci --ignore-scripts --no-audit --no-fund
echo "==> Running tests"
"$NPM" test
echo "==> Building"
"$NPM" run build

echo "==> Installing to $DEST"
install -d -m 755 "$DEST"
rsync -a --delete dist package.json package-lock.json .npmrc README.md SECURITY.md LICENSE NOTICE "$DEST/"
(cd "$DEST" && "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund)
# The stdio MCP server agents start for the project bridge (deploy/setup-bridge.sh registers it).
install -d -m 755 -o root -g root "$DEST/bin"
install -m 755 -o root -g root bridge/signalbox-bridge.mjs "$DEST/bin/signalbox-bridge.mjs"
# The Claude Code hook that reports `claude -p` runs agents start (deploy/setup-bridge.sh registers it).
install -m 755 -o root -g root claude-hook/signalbox-claude-hook.py "$DEST/bin/signalbox-claude-hook.py"
# The Connectors helper and the mail-trigger gate it hands Hermes (deploy/setup-helper.sh turns it on).
install -m 755 -o root -g root helper/signalbox-helper.py "$DEST/bin/signalbox-helper.py"
install -m 644 -o root -g root helper/signalbox_mail_trigger.py "$DEST/bin/signalbox_mail_trigger.py"
install -m 644 -o root -g root helper/signalbox_skills.py "$DEST/bin/signalbox_skills.py"
# The speech service voice mode uses (deploy/setup-speech.sh turns it on).
speech_changed=0
cmp -s speech/signalbox-speech.py "$DEST/bin/signalbox-speech.py" || speech_changed=1
install -m 644 -o root -g root speech/signalbox-speech.py "$DEST/bin/signalbox-speech.py"
chown -R root:root "$DEST"
chmod -R go-w "$DEST"

echo "==> Installing systemd unit"
sed "s#/usr/bin/node#$NODE#" deploy/signalbox.service > /etc/systemd/system/signalbox.service
chmod 644 /etc/systemd/system/signalbox.service
install -d -m 755 "$ETC"
systemctl daemon-reload
systemctl enable signalbox.service >/dev/null

# Starting with a missing or placeholder config would only fail, so leave that
# to setup-tunnel.sh, which fills in the Access values.
if [[ -f "$ETC/config.json" ]] && ! grep -qF 'YOUR-' "$ETC/config.json"; then
  # Clear any earlier start-limit failure so this restart isn't refused.
  systemctl reset-failed signalbox.service 2>/dev/null || true
  systemctl restart signalbox.service
  # The helper runs the files just installed; pick them up if it is set up.
  if systemctl is-enabled --quiet signalbox-helper.service 2>/dev/null; then systemctl restart signalbox-helper.service; fi
  # Voice mode, when it's set up: bring its units and program up to date, and
  # restart only what changed (loading the models takes a few seconds).
  if systemctl is-enabled --quiet signalbox-speech.service 2>/dev/null; then
    unit_changed=0 socket_changed=0
    cmp -s deploy/signalbox-speech.service /etc/systemd/system/signalbox-speech.service || unit_changed=1
    cmp -s deploy/signalbox-speech.socket /etc/systemd/system/signalbox-speech.socket || socket_changed=1
    if (( unit_changed || socket_changed )); then
      install -d -m 755 -o root -g root /opt/signalbox-speech/root  # the unit's RootDirectory
      install -m 644 -o root -g root deploy/signalbox-speech.service /etc/systemd/system/signalbox-speech.service
      install -m 644 -o root -g root deploy/signalbox-speech.socket /etc/systemd/system/signalbox-speech.socket
      systemctl daemon-reload
    fi
    if (( socket_changed )); then systemctl restart signalbox-speech.socket; fi
    if (( speech_changed || unit_changed || socket_changed )); then systemctl restart signalbox-speech.service; fi
  fi
  sleep 2
  systemctl --no-pager --lines=5 status signalbox.service || true
else
  echo
  if [[ ! -f "$ETC/config.json" ]]; then
    echo "First create $ETC/config.json from deploy/config.example.json (see docs/setup.md)."
  fi
  echo "Next: sudo deploy/setup-tunnel.sh <hostname> — it fills in the Access values and starts Signalbox."
fi
