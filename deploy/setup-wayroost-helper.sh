#!/usr/bin/env bash
# Publish the owner helper and selected environment settings.
set -euo pipefail
set +x

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd -P)"
# shellcheck source=deploy/wayroost-lib.sh
source "$REPO/deploy/wayroost-lib.sh"
wayroost_transaction helper "$@"
