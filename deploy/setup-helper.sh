#!/usr/bin/env bash
# Turn on the Signalbox helper, which gives Settings → Connectors its Google
# sign-in and mail triggers. It runs as <user> (the user Hermes runs as) and
# listens on 127.0.0.1 only. Run as root after install.sh:
#
#   sudo deploy/setup-helper.sh <user>            # set up (safe to re-run)
#   sudo deploy/setup-helper.sh <user> --remove   # undo it
#
# What it does:
#   * makes a shared secret in /etc/signalbox/helper.token (root only); systemd
#     hands it to both services (LoadCredential), so neither can read the other's files
#   * installs /etc/systemd/system/signalbox-helper.service for <user>
#   * adds /etc/systemd/system/signalbox.service.d/10-helper.conf (the secret for Signalbox)
#   * sets "helper": {"enabled": true} in /etc/signalbox/config.json (backed up first)
#   * with SIGNALBOX_WINDOWS_HOME=/mnt/c/Users/<name> (WSL), lets Settings → Skills keep the
#     Windows skill folders too (signalbox-helper.service.d/30-skills-windows.conf)
#   * starts the helper and restarts Signalbox
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd -P)"
# shellcheck source=deploy/lib.sh
source "$REPO/deploy/lib.sh"
ETC=/etc/signalbox
TOKEN_FILE=$ETC/helper.token
UNIT=/etc/systemd/system/signalbox-helper.service
DROPIN_DIR=/etc/systemd/system/signalbox.service.d
DROPIN=$DROPIN_DIR/10-helper.conf
PORT=8793

usage() {
  echo "Usage: $0 <user> [--remove]" >&2
  exit 1
}

TARGET="" REMOVE=0
for arg in "$@"; do
  case "$arg" in
    --remove) REMOVE=1 ;;
    -*) usage ;;
    *) [[ -z "$TARGET" ]] || usage; TARGET="$arg" ;;
  esac
done
[[ -n "$TARGET" ]] || usage

require_root
require_root_owned_tree "$REPO"
id "$TARGET" >/dev/null 2>&1 || { echo "No such user: $TARGET" >&2; exit 1; }
HOME_DIR="$(getent passwd "$TARGET" | cut -d: -f6)"
HERMES_HOME="$HOME_DIR/.hermes"
STAMP="$(date +%Y%m%d-%H%M%S)"

set_config() {
  local enabled="$1"
  [[ -f "$ETC/config.json" ]] || { echo "No $ETC/config.json yet; set \"helper\": {\"enabled\": $enabled} there yourself."; return; }
  cp -p "$ETC/config.json" "$ETC/config.json.bak-helper-$STAMP"
  python3 - "$ETC/config.json" "$enabled" <<'PY'
import json, os, sys
path, enabled = sys.argv[1], sys.argv[2] == "true"
with open(path) as f:
    cfg = json.load(f)
if enabled:
    cfg["helper"] = {**(cfg.get("helper") or {}), "enabled": True}
else:
    cfg.pop("helper", None)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
}

if (( REMOVE )); then
  echo "==> Removing the Signalbox helper"
  systemctl disable --now signalbox-helper.service 2>/dev/null || true
  rm -f "$UNIT" "$DROPIN" /etc/systemd/system/signalbox-helper.service.d/30-skills-windows.conf
  rmdir "$DROPIN_DIR" 2>/dev/null || true
  set_config false
  systemctl daemon-reload
  systemctl restart signalbox.service
  rm -f "$TOKEN_FILE"
  echo "Done. Trigger folders stay in $HERMES_HOME/signalbox-triggers until you delete them."
  exit 0
fi

[[ -d "$HERMES_HOME" ]] || { echo "No Hermes home at $HERMES_HOME" >&2; exit 1; }
[[ -f /opt/signalbox/bin/signalbox-helper.py ]] || { echo "Run deploy/install.sh first." >&2; exit 1; }

echo "==> Shared secret"
install -d -m 755 "$ETC"
if [[ ! -s "$TOKEN_FILE" ]]; then
  (umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(48))' > "$TOKEN_FILE")
fi
chown root:root "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

echo "==> Units"
sed -e "s#@USER@#$TARGET#g" -e "s#@HERMES_HOME@#$HERMES_HOME#g" -e "s#@HOME@#$HOME_DIR#g" -e "s#@PORT@#$PORT#g" \
  "$REPO/deploy/signalbox-helper.service" > "$UNIT"
chmod 644 "$UNIT"
install -d -m 755 "$DROPIN_DIR"
cat > "$DROPIN" <<EOF
# Added by deploy/setup-helper.sh: the secret Signalbox sends the helper.
[Service]
LoadCredential=helper-token:$TOKEN_FILE
EOF
chmod 644 "$DROPIN"

WIN_DROPIN=/etc/systemd/system/signalbox-helper.service.d/30-skills-windows.conf
if [[ -n "${SIGNALBOX_WINDOWS_HOME:-}" ]]; then
  WIN="${SIGNALBOX_WINDOWS_HOME%/}"
  [[ -d "$WIN" && "$WIN" != *[[:space:]]* ]] || { echo "No Windows home at $WIN (or it has spaces)" >&2; exit 1; }
  install -d -m 755 "$(dirname "$WIN_DROPIN")"
  cat > "$WIN_DROPIN" <<EOF
# Added by deploy/setup-helper.sh: Settings → Skills also keeps the Windows skill folders.
[Service]
Environment=SIGNALBOX_SKILLS_WINDOWS_HOME=$WIN
ReadWritePaths=-$WIN/.agents/skills -$WIN/.claude/skills -$WIN/.codex/skills -$WIN/AppData/Local/hermes/skills
EOF
  chmod 644 "$WIN_DROPIN"
fi

echo "==> Config"
set_config true

systemctl daemon-reload
systemctl enable signalbox-helper.service >/dev/null
systemctl restart signalbox-helper.service
systemctl reset-failed signalbox.service 2>/dev/null || true
systemctl restart signalbox.service
sleep 2
systemctl --no-pager --lines=3 status signalbox-helper.service || true
echo "Done. Settings → Connectors now offers Google and mail triggers."
