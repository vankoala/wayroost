#!/usr/bin/env bash
# Publish a prepared runtime without changing service state.
set -euo pipefail
set +x

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd -P)"
# shellcheck source=deploy/wayroost-lib.sh
source "$REPO/deploy/wayroost-lib.sh"
wayroost_transaction runtime "$@"
