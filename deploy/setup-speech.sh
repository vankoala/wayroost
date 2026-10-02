#!/usr/bin/env bash
# Turn on voice mode: the speech service that writes down what you say and reads
# agents' replies aloud, on the CPU. Run as root after install.sh:
#
#   sudo deploy/setup-speech.sh                     # set up (safe to re-run); downloads the models (~1 GB)
#   sudo deploy/setup-speech.sh --stt-dir DIR --kokoro-archive FILE
#                                                   # use copies already on this PC instead
#   sudo deploy/setup-speech.sh --remove            # turn it off again
#
# What it does:
#   * makes the system group signalbox-voice (who may open the speech socket)
#   * checks that only root can change /opt/signalbox-speech (and every folder
#     above it), then builds a fresh root-owned Python venv there from
#     speech/requirements.txt (pinned by hash, wheels only)
#   * puts the models in /opt/signalbox-speech/models, checking every file
#     against the publishers' SHA-256 below (local copies get the same check):
#       Parakeet TDT 0.6B v2 int8 (speech-to-text), from Hugging Face
#       Kokoro-82M multi-lang v1.0 (text-to-speech), from the sherpa-onnx releases
#   * makes /opt/signalbox-speech/root, the empty folder that is the service's
#     whole view of the system (see the unit), and installs
#     signalbox-speech.socket and signalbox-speech.service
#   * adds /etc/systemd/system/signalbox.service.d/20-speech.conf (the group, for Signalbox)
#   * sets "speech": {"enabled": true} in /etc/signalbox/config.json (backed up first)
#   * starts the speech service and restarts Signalbox
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd -P)"
# shellcheck source=deploy/lib.sh
source "$REPO/deploy/lib.sh"
ETC=/etc/signalbox
OPT=/opt/signalbox-speech
VENV=$OPT/venv
MODELS=$OPT/models
ROOTDIR=$OPT/root
GROUP=signalbox-voice
SOCKET=/run/signalbox-speech.sock
DROPIN_DIR=/etc/systemd/system/signalbox.service.d
DROPIN=$DROPIN_DIR/20-speech.conf
PYTHON=/usr/bin/python3

STT_NAME=parakeet-tdt-0.6b-v2-int8
STT_URL=https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/main
# Hugging Face's LFS SHA-256 for the three models. tokens.txt isn't in LFS: its
# SHA-256 here was taken from a copy that matched Hugging Face's git blob id
# (f0742785f6073e80b911964c455b05f3609bf23b).
declare -A STT_FILES=(
  [encoder.int8.onnx]=a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab
  [decoder.int8.onnx]=b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e
  [joiner.int8.onnx]=7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2
  [tokens.txt]=ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d
)
TTS_NAME=kokoro-multi-lang-v1_0
TTS_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/$TTS_NAME.tar.bz2
# The release asset's digest as GitHub reports it.
TTS_SHA256=c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298
TTS_MEMBERS=(model.onnx voices.bin tokens.txt lexicon-us-en.txt espeak-ng-data)
# The files from that archive, so a re-run checks them again (not only the stamp).
declare -A TTS_FILES=(
  [model.onnx]=b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11
  [voices.bin]=1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29
  [tokens.txt]=6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425
  [lexicon-us-en.txt]=7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14
)

usage() {
  echo "Usage: $0 [--stt-dir DIR] [--kokoro-archive FILE] | --remove" >&2
  exit 1
}

REMOVE=0 STT_DIR="" TTS_ARCHIVE=""
while (( $# )); do
  case "$1" in
    --remove) REMOVE=1 ;;
    --stt-dir) [[ $# -ge 2 ]] || usage; STT_DIR="$2"; shift ;;
    --kokoro-archive) [[ $# -ge 2 ]] || usage; TTS_ARCHIVE="$2"; shift ;;
    *) usage ;;
  esac
  shift
done

require_root
require_root_owned_tree "$REPO"
require_trusted_binary "$PYTHON"
# The venv links to the real interpreter, not /usr/bin/python3: that goes through
# /etc/alternatives, which the service's sealed view doesn't have.
PYTHON_REAL="$(readlink -f "$PYTHON")"
require_trusted_binary "$PYTHON_REAL"
STAMP="$(date +%Y%m%d-%H%M%S)"

set_config() {
  local enabled="$1"
  [[ -f "$ETC/config.json" ]] || { echo "No $ETC/config.json yet; set \"speech\": {\"enabled\": $enabled} there yourself."; return; }
  cp -p "$ETC/config.json" "$ETC/config.json.bak-speech-$STAMP"
  "$PYTHON" - "$ETC/config.json" "$enabled" <<'PY'
import json, os, sys
path, enabled = sys.argv[1], sys.argv[2] == "true"
with open(path) as f:
    cfg = json.load(f)
if enabled:
    cfg["speech"] = {**(cfg.get("speech") or {}), "enabled": True}
else:
    cfg.pop("speech", None)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
os.chmod(tmp, os.stat(path).st_mode & 0o777)  # keep its mode
os.replace(tmp, path)
PY
}

if (( REMOVE )); then
  echo "==> Turning voice mode off"
  systemctl disable --now signalbox-speech.service signalbox-speech.socket 2>/dev/null || true
  rm -f /etc/systemd/system/signalbox-speech.service /etc/systemd/system/signalbox-speech.socket "$DROPIN"
  rmdir "$DROPIN_DIR" 2>/dev/null || true
  set_config false
  systemctl daemon-reload
  systemctl restart signalbox.service
  echo "Done. The venv and models stay in $OPT (about 1.2 GB); delete it to free the space."
  exit 0
fi

[[ -f /opt/signalbox/bin/signalbox-speech.py ]] || { echo "Run deploy/install.sh first." >&2; exit 1; }

sha_ok() { [[ -f "$1" ]] && [[ "$(sha256sum "$1" | cut -d' ' -f1)" == "$2" ]]; }

# Root runs things from $OPT below, so first make sure nobody else could have
# put anything there: it, every folder above it, and everything in it.
install -d -m 755 -o root -g root "$OPT"
require_root_owned_tree "$OPT"

WORK="$(mktemp -d "$OPT/.setup.XXXXXX")"
trap 'rm -rf -- "${WORK:?}"' EXIT

echo "==> Group $GROUP"
getent group "$GROUP" >/dev/null || groupadd --system "$GROUP"

echo "==> Python packages ($VENV)"
# Always a fresh venv: nothing left from before is trusted.
"$PYTHON_REAL" -m venv --clear "$VENV"
require_trusted_binary "$VENV/bin/python"
"$VENV/bin/python" -m pip install --quiet --no-input --no-cache-dir --disable-pip-version-check \
  --require-hashes --only-binary=:all: -r "$REPO/speech/requirements.txt"

echo "==> Speech-to-text model ($STT_NAME)"
install -d -m 755 -o root -g root "$MODELS"
stt_target="$MODELS/$STT_NAME"
install -d -m 755 -o root -g root "$stt_target"
for file in "${!STT_FILES[@]}"; do
  want="${STT_FILES[$file]}"
  sha_ok "$stt_target/$file" "$want" && continue
  if [[ -n "$STT_DIR" ]]; then
    cp -- "$STT_DIR/$file" "$WORK/$file"
  else
    curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 -o "$WORK/$file" "$STT_URL/$file"
  fi
  sha_ok "$WORK/$file" "$want" || { echo "$file doesn't match its published SHA-256; not installing it." >&2; exit 1; }
  install -m 644 -o root -g root "$WORK/$file" "$stt_target/$file"
  rm -f -- "${WORK:?}/${file:?}"
done

echo "==> Text-to-speech model ($TTS_NAME)"
tts_target="$MODELS/$TTS_NAME"
tts_ok=1
[[ "$(cat "$tts_target/.archive-sha256" 2>/dev/null)" == "$TTS_SHA256" ]] || tts_ok=0
for file in "${!TTS_FILES[@]}"; do
  sha_ok "$tts_target/$file" "${TTS_FILES[$file]}" || tts_ok=0
done
if (( ! tts_ok )); then
  archive="$WORK/$TTS_NAME.tar.bz2"
  if [[ -n "$TTS_ARCHIVE" ]]; then
    cp -- "$TTS_ARCHIVE" "$archive"
  else
    curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 -o "$archive" "$TTS_URL"
  fi
  sha_ok "$archive" "$TTS_SHA256" || { echo "$TTS_NAME.tar.bz2 doesn't match its published SHA-256; not installing it." >&2; exit 1; }
  tar -xjf "$archive" -C "$WORK" --no-same-owner --no-same-permissions "${TTS_MEMBERS[@]/#/$TTS_NAME/}"
  for file in "${!TTS_FILES[@]}"; do
    sha_ok "$WORK/$TTS_NAME/$file" "${TTS_FILES[$file]}" || { echo "$file from the archive isn't the expected file; not installing it." >&2; exit 1; }
  done
  echo "$TTS_SHA256" > "$WORK/$TTS_NAME/.archive-sha256"
  chown -R root:root "$WORK/$TTS_NAME"
  chmod -R u=rwX,go=rX "$WORK/$TTS_NAME"
  rm -rf -- "${tts_target:?}"
  mv "$WORK/$TTS_NAME" "$tts_target"
fi
# The service's whole view of the system: an empty folder, with its program,
# models and the system's libraries mounted in by the unit.
install -d -m 755 -o root -g root "$ROOTDIR"
chown -R root:root "$OPT"
chmod -R go-w "$OPT"

echo "==> Units"
install -m 644 -o root -g root "$REPO/deploy/signalbox-speech.socket" /etc/systemd/system/signalbox-speech.socket
install -m 644 -o root -g root "$REPO/deploy/signalbox-speech.service" /etc/systemd/system/signalbox-speech.service
install -d -m 755 "$DROPIN_DIR"
cat > "$DROPIN" <<EOF
# Added by deploy/setup-speech.sh: lets Signalbox open the speech socket ($SOCKET).
[Service]
SupplementaryGroups=$GROUP
EOF
chmod 644 "$DROPIN"

echo "==> Config"
set_config true

systemctl daemon-reload
systemctl enable --now signalbox-speech.socket >/dev/null
systemctl enable signalbox-speech.service >/dev/null
systemctl reset-failed signalbox-speech.service 2>/dev/null || true
systemctl restart signalbox-speech.service
echo "==> Waiting for the models to load"
for _ in $(seq 1 90); do
  curl -fs --max-time 5 --unix-socket "$SOCKET" http://localhost/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fs --max-time 5 --unix-socket "$SOCKET" http://localhost/health >/dev/null \
  || { echo "The speech service didn't come up; see: journalctl -u signalbox-speech" >&2; exit 1; }
systemctl reset-failed signalbox.service 2>/dev/null || true
systemctl restart signalbox.service
sleep 2
systemctl --no-pager --lines=3 status signalbox-speech.service || true
echo "Done. Voice mode is on: a mic button appears in every chat's message box."
