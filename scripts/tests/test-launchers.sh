#!/usr/bin/env bash
# Exercise launchers in a disposable checkout with fake external runtimes.
set -euo pipefail
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)/relay with spaces"
mkdir -p "$fixture/scripts" "$fixture/frontend" "$fixture/bin"
launcher_pid=''
cleanup() {
    if [[ -n "$launcher_pid" ]]; then
        kill -TERM "$launcher_pid" 2>/dev/null || true
        wait "$launcher_pid" 2>/dev/null || true
    fi
    rm -rf -- "${fixture%/*}"
}
trap cleanup EXIT
cp "$source_root"/scripts/*.sh "$fixture/scripts/"
for script in "$fixture"/scripts/*.sh; do bash -n "$script"; done
export LAUNCH_LOG="$fixture/log"
export PATH="$fixture/bin:$PATH"
cat > "$fixture/bin/uv" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf 'uv:%s:%s\n' "$UV_PROJECT_ENVIRONMENT" "$*" >> "$LAUNCH_LOG"
[[ ${FAIL_STAGE:-} != sync ]] || exit 21
mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"
cp "$MOCK_PYTHON" "$UV_PROJECT_ENVIRONMENT/bin/python"
MOCK
cat > "$fixture/bin/node" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
cat > "$fixture/bin/npm" <<'MOCK'
#!/usr/bin/env bash
[[ $1 != --version ]] || { echo "${MOCK_NPM_VERSION:-10.0.0}"; exit; }
printf 'npm:%s\n' "$*" >> "$LAUNCH_LOG"
[[ ${FAIL_STAGE:-} != build || $* != 'run build' ]] || exit 22
MOCK
cat > "$fixture/bin/mock-python" <<'MOCK'
#!/usr/bin/env bash
printf 'python:%s\n' "$*" >> "$LAUNCH_LOG"
case "$2" in
    alembic) [[ ${FAIL_STAGE:-} != migration ]] || exit 23 ;;
    backend.safety_worker|uvicorn)
        module=$2
        printf '%s\n' "$$" > "$module.pid"
        trap 'printf "stopped:%s\n" "$module" >> "$LAUNCH_LOG"; exit 0' TERM INT
        if [[ $module == uvicorn && ${API_EXIT:-} == yes ]]; then
            # Wait for the worker to initialize so cleanup can be asserted.
            for ((i=0; i<100; i++)); do
                [[ -f backend.safety_worker.pid ]] && exit 24
                sleep 0.05
            done
            exit 25
        fi
        while :; do sleep 0.1; done ;;
esac
MOCK
chmod +x "$fixture/bin/"*
export MOCK_PYTHON="$fixture/bin/mock-python"
cd "${fixture%/*}" # The launchers must find their root from any working directory.

assert_log() { grep -F -- "$1" "$LAUNCH_LOG" >/dev/null; }
bash "$fixture/scripts/demo.sh" --port 8002 --no-browser
assert_log "uv:$fixture/data/demo/venv:sync --locked --python 3.11"
assert_log 'python:-m backend.demo --port 8002 --no-browser'
bash "$fixture/scripts/start-lab.sh" --port 8018
assert_log 'python:-m lab.server --port 8018'

for stage in sync build migration; do
    : > "$LAUNCH_LOG"
    if FAIL_STAGE=$stage bash "$fixture/scripts/start.sh"; then
        echo "Expected $stage failure" >&2; exit 1
    fi
    if grep -E 'python:-m (uvicorn|backend.safety_worker)' "$LAUNCH_LOG"; then
        echo 'Started services after failed setup' >&2; exit 1
    fi
done
if MOCK_NPM_VERSION=9.0.0 bash "$fixture/scripts/demo.sh"; then
    echo 'Accepted unsupported npm' >&2; exit 1
fi

mkdir -p "$fixture/.secrets"
printf 'existing-test-key' > "$fixture/.secrets/anthropic.key"
bash "$fixture/scripts/start.sh" &
launcher_pid=$!
for ((i=0; i<100; i++)); do
    [[ -f "$fixture/uvicorn.pid" && -f "$fixture/backend.safety_worker.pid" ]] && break
    sleep 0.05
done
[[ -f "$fixture/uvicorn.pid" && -f "$fixture/backend.safety_worker.pid" ]]
kill -TERM "$launcher_pid"
status=0
wait "$launcher_pid" || status=$?
launcher_pid=''
[[ $status == 143 ]]
assert_log 'stopped:uvicorn'
assert_log 'stopped:backend.safety_worker'
[[ $(cat "$fixture/.secrets/anthropic.key") == existing-test-key ]]
for pidfile in "$fixture/"*.pid; do
    if kill -0 "$(cat "$pidfile")" 2>/dev/null; then echo 'Leaked service' >&2; exit 1; fi
    rm "$pidfile"
done

: > "$LAUNCH_LOG"
status=0
API_EXIT=yes bash "$fixture/scripts/start.sh" || status=$?
[[ $status == 24 ]]
assert_log 'stopped:backend.safety_worker'
printf 'Bash launcher checks passed.\n'
