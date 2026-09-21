# Testing and release verification

Install dependencies with `uv sync --locked` and `npm ci` in `frontend/`. Run from the repository root unless stated otherwise. These commands do not request live model evaluation.

## Backend and Lab

```powershell
uv run --locked pytest backend/tests lab/tests -q
```

The explicit directories matter: plain `pytest` uses the project's default `backend/tests` configuration and does not include the Lab suite. Tests cover ingestion/replay, policy matching, request lifecycle, worker behavior, incidents, and synthetic Lab scenarios. Subprocess and timing checks need a machine able to start worker processes.

## Build and browser workflows

```powershell
Set-Location frontend
npm ci
npm run build
npx playwright install chromium
$env:RELAY_E2E_PORT = "18000"
npm run test:e2e
npx playwright test --config playwright.lab.config.ts
Set-Location ..
```

Main browser tests start their own backend and reset only `data/e2e.db`. Their fixtures are synthetic and their server disables real judge credentials. Port 18000 avoids a running application on 8000. Do not run two main browser suites in the same checkout concurrently: they share the fixture database and directories.

Lab browser tests start a separate Lab server on port 8018 and create isolated run directories under `data/lab/`. Avoid running another Lab browser suite at the same time. Existing Lab history can remain visible; run CI from a clean checkout. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` is an optional local override, not a requirement; CI installs Chromium through Playwright.

## CI

Full CI runs when a pull request is opened, reopened, or updated. Pushes alone do not trigger CI, including merge pushes. Manual runs remain available through workflow dispatch. A newer run cancels an older run for the same PR; manual runs are grouped separately by branch.

The Windows GitHub Actions workflow installs Python 3.11, uv, Node 22, locked dependencies, and Playwright Chromium. It runs both Python suites, the production frontend build, and the main, Lab, and demo browser suites. Browser failure artifacts are uploaded for inspection. CI needs no Anthropic or OpenAI secrets.

### Main-dashboard demo checks

From the repository root, run `uv run --locked pytest backend/tests/test_demo.py -q` to check isolation, rejected live operations, credential suppression, incident edits, and reset. After building, run `npx playwright test --config playwright.demo.config.ts` from `frontend` for the guided walkthrough. It starts `backend.demo` on port 18001 (override with `RELAY_DEMO_TEST_PORT`) and resets `data/demo/monitor.db`. Stop any interactive demo first.

A committed workflow is not evidence of a passing remote run. Check its result on the exact release commit before publishing a badge or release claim.

## Manual release smoke test

Use a clean clone on a Windows account or machine without the developer's bundled runtimes, environment, or database:

1. Follow the [demo launcher instructions](../README.md#run-the-sample-demo), then stop the demo and follow [full setup](setup.md).
2. Open the health endpoint and the main dashboard.
3. Add a supported local source; confirm a new conversation appears once and remains the same session after resume.
4. Confirm the key-free Lab walkthrough produces an inspectable report.
5. Stop and restart services; verify history remains available.
6. If the release claims live blocking, separately verify hooks, worker readiness, a harmless reviewed request, and an expired request. Record provider/model and observed behavior without credentials.

## Interpreting results

Scripted tests validate pipeline behavior, not model accuracy. Live evaluations incur charges and measure a particular model, prompt, and case set. Load tests include blocked and failed requests; receipt throughput is not successful judge throughput.

[Lab validation](../lab/VALIDATION.md) records historical results and known failures. Rerun relevant checks on the release candidate, record its commit and environment, and do not present old test totals as current results.

The [release-preparation verification record](release-preparation-verification.md) records earlier local checks and environment adjustments.

## Optional judge calibration

`uv run --locked python scripts/evaluate_safety.py` runs the offline synthetic policy baseline. Add `--live` for paid evaluation with the configured judge provider of 12 built-in cases. `scripts/check_judge_calibration.py` provides an additional opt-in live check. These send synthetic evidence, execute no proposed commands, and do not establish general model accuracy.

## OpenAI support status

OpenAI judge support is available but has not been tested with live API calls; Anthropic remains recommended. `backend/tests/test_openai_judge.py` checks mocked request/response handling, credential selection, redaction, incident analysis, error sanitization and fail-closed validation. Passing these offline tests does not establish live model compatibility or verdict quality.
