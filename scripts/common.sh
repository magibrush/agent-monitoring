#!/usr/bin/env bash
# Shared setup for the Bash launchers. Source this file, rather than running it.
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_root"

require_command() {
    command -v "$1" >/dev/null 2>&1 || {
        printf 'Missing %s. See docs/setup.md for prerequisites.\n' "$1" >&2
        exit 1
    }
}

check_frontend_runtime() {
    require_command uv
    require_command node
    require_command npm
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error("Node.js 22.12+ is required."); process.exit(1); }'
    local npm_version
    npm_version="$(npm --version)"
    if (( ${npm_version%%.*} < 10 )); then
        printf 'npm 10+ is required.\n' >&2
        exit 1
    fi
}

prepare_key_file() {
    # Restrict newly created credentials without changing an existing key.
    (umask 077; mkdir -p .secrets; touch .secrets/anthropic.key)
}

require_environment() {
    if [[ ! -x .venv/bin/python ]]; then
        printf 'Run bash scripts/start.sh or uv sync --locked --python 3.11 first.\n' >&2
        exit 1
    fi
}
