#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_environment
prepare_key_file
exec .venv/bin/python -m backend.safety_worker --workers 2 "$@"
