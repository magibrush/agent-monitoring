#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

check_frontend_runtime
export UV_CACHE_DIR="${UV_CACHE_DIR:-$project_root/.uv-cache}"
export npm_config_cache="${npm_config_cache:-$project_root/.npm-cache}"
printf 'Preparing Relay. First run downloads locked dependencies.\n'
UV_PROJECT_ENVIRONMENT="$project_root/.venv" uv sync --locked --python 3.11
(cd frontend && npm ci && npm run build)
prepare_key_file
.venv/bin/python -m alembic upgrade head

worker_pid=''
api_pid=''
cleanup() {
    trap - EXIT INT TERM
    for pid in "$api_pid" "$worker_pid"; do
        if [[ -n "$pid" ]]; then kill -TERM "$pid" 2>/dev/null || true; fi
    done
    for pid in "$api_pid" "$worker_pid"; do
        if [[ -n "$pid" ]]; then wait "$pid" 2>/dev/null || true; fi
    done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
.venv/bin/python -m backend.safety_worker --workers 2 &
worker_pid=$!
printf 'Relay is starting at http://127.0.0.1:8000. Press Ctrl+C to stop.\n'
.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 &
api_pid=$!
wait "$api_pid"
