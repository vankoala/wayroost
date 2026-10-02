# shellcheck shell=bash
# Checks shared by install.sh and the setup-*.sh scripts. Source this file; don't run it.
#
# Both scripts run as root and use code, config and programs from disk. An agent
# running as your user must not be able to change any of them, so the scripts
# refuse to go on whenever anyone but root could.

# Exit unless running as root.
require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "Run as root (sudo)." >&2
    exit 1
  fi
  # sudo can keep the caller's HOME, and npm, cloudflared and curl read their
  # settings from it. Use root's own.
  local home=~root
  [[ "$home" == /* ]] || home=/root
  export HOME="$home"
}

# Exit unless only root can modify <dir>: the directory, every directory above
# it, and everything in it except node_modules (npm ci replaces that).
require_root_owned_tree() {
  local tree dir owner mode bad
  tree="$(readlink -f -- "$1")" || tree="$1"
  dir="$tree"
  while :; do
    read -r owner mode <<<"$(stat -c '%u %a' "$dir" 2>/dev/null)" || true
    # Fail closed: a folder stat can't read counts as not root's.
    if [[ ! "$mode" =~ ^[0-7]+$ || "$owner" != 0 || $(( 8#$mode & 8#022 )) -ne 0 ]]; then
      echo "Refusing to use $tree: $dir must be owned by root and not writable by others." >&2
      echo "Clone Signalbox somewhere root-owned, e.g. /opt/src/signalbox." >&2
      exit 1
    fi
    [[ "$dir" == / ]] && break
    dir="$(dirname "$dir")"
  done
  # A symlink's own mode is always 777 and means nothing; its owner still counts.
  bad="$(find "$tree" -path "$tree/node_modules" -prune -o \( ! -user root -o \( ! -type l -perm /022 \) \) -print -quit)" || true
  if [[ -n "$bad" ]]; then
    echo "Refusing to use $tree: $bad must be owned by root and not writable by others." >&2
    exit 1
  fi
}

# Exit unless only root can change what running <path> executes. Follows the
# path the way the kernel does, symlink by symlink, and checks every directory
# it passes through (including the ones holding the symlinks) and the file it
# ends at.
require_trusted_binary() {
  local bin="$1" dir=/ rest="$1" part next target hops=0
  if [[ "$bin" != /* ]]; then
    echo "Refusing to run $bin: not an absolute path." >&2
    exit 1
  fi
  _require_root_only "$bin" /
  while :; do
    rest="${rest#"${rest%%[!/]*}"}"  # drop leading slashes
    [[ -n "$rest" ]] || break
    part="${rest%%/*}"
    if [[ "$rest" == */* ]]; then rest="${rest#*/}"; else rest=""; fi
    case "$part" in
      .) continue ;;
      ..) dir="$(dirname -- "$dir")"; continue ;;
    esac
    next="${dir%/}/$part"
    if [[ -L "$next" ]]; then
      if (( ++hops > 40 )); then
        echo "Refusing to run $bin: too many symlinks." >&2
        exit 1
      fi
      target="$(readlink -- "$next")"
      [[ "$target" == /* ]] && dir=/
      rest="$target/$rest"
    else
      _require_root_only "$bin" "$next"
      dir="$next"
    fi
  done
  if [[ ! -f "$dir" ]]; then
    echo "Refusing to run $bin: $dir is not a regular file." >&2
    exit 1
  fi
}

# _require_root_only <binary> <path>: part of require_trusted_binary.
_require_root_only() {
  local owner mode
  read -r owner mode <<<"$(stat -c '%u %a' -- "$2" 2>/dev/null)"
  if [[ "$owner" != 0 || ! "$mode" =~ ^[0-7]+$ ]] || (( 8#$mode & 8#022 )); then
    echo "Refusing to run $1: $2 must be owned by root and not writable by others." >&2
    exit 1
  fi
}
