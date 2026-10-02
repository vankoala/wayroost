#!/usr/bin/env bash
# Create (or reuse) a dedicated Cloudflare Tunnel for Signalbox, point your
# hostname at it, fill in publicOrigin and the Access team + AUD in
# /etc/signalbox/config.json, write the tunnel config, and (re)start Signalbox
# and the tunnel. Safe to re-run. Run as root after:
#   1. `cloudflared tunnel login` (once, as root),
#   2. creating the Cloudflare Access application for the hostname, and
#   3. writing /etc/signalbox/config.json and running deploy/install.sh.
#
#   sudo deploy/setup-tunnel.sh signalbox.example.com
#
# TUNNEL_NAME picks another tunnel name (default: signalbox).
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd -P)"
# shellcheck source=deploy/lib.sh
source "$REPO/deploy/lib.sh"
ETC=/etc/signalbox
UNITS=/etc/systemd/system
HOSTNAME_="${1:-}"
TUNNEL_NAME="${TUNNEL_NAME:-signalbox}"

# Lowercase letters, digits and hyphens in dot-separated labels, at least one dot.
is_hostname() {
  local LC_ALL=C label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
  (( ${#1} <= 253 )) && [[ "$1" =~ ^${label}(\.${label})+$ ]]
}

is_tunnel_name() {
  local LC_ALL=C
  [[ "$1" =~ ^[A-Za-z0-9._-]{1,64}$ ]]
}

# Sets TEAM and AUD from a Cloudflare Access login redirect:
# https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<host>?kid=<aud>&...
parse_access_redirect() {
  local LC_ALL=C
  local re='^https://([a-z0-9][a-z0-9-]*)\.cloudflareaccess\.com/[^?#]*\?([^#]*&)?kid=([0-9a-f]+)(&|#|$)'
  [[ "$1" =~ $re ]] || return 1
  TEAM="${BASH_REMATCH[1]}"
  AUD="${BASH_REMATCH[3]}"
}

# The Python helpers below get values only through argv and the environment,
# never by pasting them into their source.

# Prints listen.port from the config (default 8790), or exits if the config is unusable.
config_port() {
  python3 -I - "$1" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path) as f:
        cfg = json.load(f)
except (OSError, ValueError) as e:
    sys.exit(f"Can't read {path}: {e}")
if not isinstance(cfg, dict) or not all(isinstance(cfg.get(k, {}), dict) for k in ("listen", "access")):
    sys.exit(f"{path} must be a JSON object laid out like deploy/config.example.json.")
port = cfg.get("listen", {}).get("port", 8790)
if isinstance(port, float) and port.is_integer():
    port = int(port)
if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
    sys.exit(f"listen.port in {path} must be a whole number from 1 to 65535.")
print(port)
PY
}

# Prints the id of the live tunnel named $TUNNEL_NAME, or nothing if there is none.
find_tunnel() {
  local json
  if ! json="$("$CLOUDFLARED" tunnel --origincert "$CERT" list --output json --name="$TUNNEL_NAME")"; then
    echo "cloudflared couldn't list your tunnels (see the error above)." >&2
    return 1
  fi
  TUNNELS_JSON="$json" python3 -I - "$TUNNEL_NAME" <<'PY'
import json, os, re, sys
name = sys.argv[1]
try:
    tunnels = json.loads(os.environ["TUNNELS_JSON"]) or []
except ValueError:
    sys.exit("cloudflared tunnel list printed something that isn't JSON.")
if not isinstance(tunnels, list):
    sys.exit("cloudflared tunnel list printed something unexpected.")
for t in tunnels:
    if not isinstance(t, dict) or t.get("name") != name:
        continue
    # Live tunnels have a zero deleted_at ("0001-01-01T00:00:00Z").
    deleted = str(t.get("deleted_at") or "")
    if deleted and not deleted.startswith("0001-01-01"):
        continue
    tunnel_id = str(t.get("id") or "").lower()
    if re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", tunnel_id):
        print(tunnel_id)
        break
PY
}

# Prints the TunnelID in a tunnel credentials file, or nothing if it can't be read.
creds_tunnel_id() {
  python3 -I - "$1" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        print(str(json.load(f).get("TunnelID") or "").lower())
except (OSError, ValueError, AttributeError):
    pass
PY
}

# update_config <path> <hostname> <team> <aud>: set publicOrigin and the Access
# values, keeping everything else, the file's owner and its mode.
update_config() {
  python3 -I - "$@" <<'PY'
import json, os, sys, tempfile
path, host, team, aud = sys.argv[1:]
with open(path) as f:
    cfg = json.load(f)
cfg["publicOrigin"] = f"https://{host}"
access = cfg.setdefault("access", {})
access["teamDomain"] = f"https://{team}.cloudflareaccess.com"
access["aud"] = aud
st = os.stat(path)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".config.json.")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    os.chmod(tmp, st.st_mode & 0o7777)
    os.chown(tmp, st.st_uid, st.st_gid)
    os.replace(tmp, path)
except BaseException:
    os.unlink(tmp)
    raise
PY
}

# render <template> <dest> <octal mode> [<placeholder> <value>]...: fill in a
# template and replace <dest> with the result in one step.
render() {
  python3 -I - "$@" <<'PY'
import os, re, sys, tempfile
src, dest, mode, *pairs = sys.argv[1:]
with open(src) as f:
    text = f.read()
for placeholder, value in zip(pairs[0::2], pairs[1::2]):
    text = text.replace(placeholder, value)
left = sorted(set(re.findall(r"__[A-Z_]+__", text)))
if left:
    sys.exit(f"{src} has placeholders this script doesn't fill in: {', '.join(left)}")
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest), prefix=f".{os.path.basename(dest)}.")
try:
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, int(mode, 8))
    os.replace(tmp, dest)
except BaseException:
    os.unlink(tmp)
    raise
PY
}

require_root
# This script installs units and config from $REPO as root.
require_root_owned_tree "$REPO"
cd /  # so nothing below picks up files from wherever this was started

if [[ -z "$HOSTNAME_" ]]; then echo "Usage: $0 <hostname>" >&2; exit 1; fi
HOSTNAME_="${HOSTNAME_,,}"
if ! is_hostname "$HOSTNAME_"; then
  echo "Invalid hostname: $1" >&2
  echo "Give just the hostname, like signalbox.example.com: letters, digits and hyphens in dot-separated labels, no https:// and no path." >&2
  exit 1
fi
if ! is_tunnel_name "$TUNNEL_NAME"; then
  echo "Invalid TUNNEL_NAME: $TUNNEL_NAME (use 1 to 64 letters, digits, dots, underscores or hyphens)." >&2
  exit 1
fi

CLOUDFLARED="$(command -v cloudflared || true)"
if [[ -z "$CLOUDFLARED" ]]; then echo "cloudflared is not installed." >&2; exit 1; fi
require_trusted_binary "$CLOUDFLARED"
CERT="$HOME/.cloudflared/cert.pem"
if [[ ! -f "$CERT" ]]; then
  # shellcheck disable=SC2016  # the backticks are meant literally
  echo 'Run `cloudflared tunnel login` first (as root).' >&2
  exit 1
fi
if [[ ! -f "$ETC/config.json" ]]; then
  echo "$ETC/config.json doesn't exist. Create it from deploy/config.example.json first (see docs/setup.md)." >&2
  exit 1
fi
PORT="$(config_port "$ETC/config.json")"
if [[ ! -f "$UNITS/signalbox.service" ]]; then
  echo "Signalbox isn't installed yet. Run sudo deploy/install.sh first." >&2
  exit 1
fi

echo "==> Tunnel"
TUNNEL_ID="$(find_tunnel)"
if [[ -z "$TUNNEL_ID" ]]; then
  "$CLOUDFLARED" tunnel --origincert "$CERT" create -- "$TUNNEL_NAME" >/dev/null
  TUNNEL_ID="$(find_tunnel)"
  if [[ -z "$TUNNEL_ID" ]]; then
    echo "Created tunnel $TUNNEL_NAME, but cloudflared tunnel list doesn't show it yet. Re-run this script." >&2
    exit 1
  fi
fi
echo "    $TUNNEL_NAME = $TUNNEL_ID"
# The credentials cloudflared wrote when it created the tunnel. Copy them again
# whenever the installed ones belong to another tunnel, e.g. after the tunnel
# was deleted and recreated.
CREDS="$ETC/tunnel-credentials.json"
NEW_CREDS="$HOME/.cloudflared/$TUNNEL_ID.json"
if [[ "$(creds_tunnel_id "$CREDS")" != "$TUNNEL_ID" ]]; then
  if [[ ! -f "$NEW_CREDS" ]]; then
    echo "Tunnel credentials not found at $NEW_CREDS." >&2
    echo "If the tunnel was created elsewhere, fetch them with: sudo cloudflared tunnel token --cred-file $NEW_CREDS $TUNNEL_ID" >&2
    exit 1
  fi
  if [[ "$(creds_tunnel_id "$NEW_CREDS")" != "$TUNNEL_ID" ]]; then
    echo "$NEW_CREDS doesn't hold the credentials of tunnel $TUNNEL_ID." >&2
    exit 1
  fi
  install -m 600 -o root -g root "$NEW_CREDS" "$CREDS"
  echo "    installed its credentials as $CREDS"
fi

echo "==> DNS: $HOSTNAME_ → $TUNNEL_NAME"
# `route dns` silently prefers the tunnel named in ~/.cloudflared/config.yml if
# one exists, so always hand it a config that names our tunnel explicitly.
ROUTE_CFG="$(mktemp "$ETC/.route-dns.XXXXXX")"
trap 'rm -f "$ROUTE_CFG"' EXIT
printf 'tunnel: %s\ncredentials-file: %s\n' "$TUNNEL_ID" "$CREDS" > "$ROUTE_CFG"
"$CLOUDFLARED" tunnel --origincert "$CERT" --config "$ROUTE_CFG" route dns --overwrite-dns "$TUNNEL_ID" "$HOSTNAME_"
rm -f "$ROUTE_CFG"

echo "==> Reading Access team and AUD from the login redirect"
LOCATION=""
for _ in $(seq 1 12); do
  LOCATION="$(curl -s -o /dev/null -m 10 -w '%{redirect_url}' "https://$HOSTNAME_/" || true)"
  [[ "$LOCATION" == *".cloudflareaccess.com/"* ]] && break
  sleep 5
done
if [[ "$LOCATION" != *".cloudflareaccess.com/"* ]]; then
  echo "https://$HOSTNAME_ is not behind Cloudflare Access yet. Create the Access application" >&2
  echo "for this hostname first (docs/setup.md), then re-run this script." >&2
  exit 1
fi
TEAM="" AUD=""
parse_access_redirect "$LOCATION" || { echo "Could not parse the Access redirect: $LOCATION" >&2; exit 1; }
echo "    team=$TEAM aud=${AUD:0:8}…"
update_config "$ETC/config.json" "$HOSTNAME_" "$TEAM" "$AUD"
echo "    updated $ETC/config.json"

echo "==> Tunnel config and service"
render "$REPO/deploy/cloudflared.yml.template" "$ETC/cloudflared.yml" 644 \
  __TUNNEL_ID__ "$TUNNEL_ID" __HOSTNAME__ "$HOSTNAME_" __TEAM_NAME__ "$TEAM" __AUD__ "$AUD" __PORT__ "$PORT"
render "$REPO/deploy/signalbox-tunnel.service" "$UNITS/signalbox-tunnel.service" 644 \
  /usr/local/bin/cloudflared "$CLOUDFLARED"
systemctl daemon-reload
systemctl enable signalbox-tunnel.service >/dev/null
# Clear any earlier start-limit failure so these restarts aren't refused.
systemctl reset-failed signalbox.service signalbox-tunnel.service 2>/dev/null || true
systemctl restart signalbox.service
systemctl restart signalbox-tunnel.service
sleep 10
systemctl --no-pager --lines=3 status signalbox.service signalbox-tunnel.service || true
echo
echo "Open https://$HOSTNAME_ on your phone and sign in."
