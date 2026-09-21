#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

check_frontend_runtime
printf 'Preparing the synthetic Relay demo. First run downloads locked dependencies.\n'
UV_PROJECT_ENVIRONMENT="$project_root/data/demo/venv" uv sync --locked --python 3.11
(cd frontend && npm ci && npm run build)
exec data/demo/venv/bin/python -m backend.demo "$@"
