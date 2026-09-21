#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_command uv
UV_PROJECT_ENVIRONMENT="$project_root/.venv" uv sync --locked --python 3.11
exec .venv/bin/python -m lab.server "$@"
