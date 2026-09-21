# Release preparation: local verification

## September 21: main-dashboard demo iteration

Checked locally on `main` after pulling `4a7140d`, with the demo implementation still uncommitted. These results are not a tagged-release or remote CI claim.

| Check | Result |
| --- | --- |
| Backend and Lab Python suites, Python 3.13.1 | 299 passed |
| Demo isolation tests in the launcher's Python 3.11.16 environment | 18 passed |
| TypeScript and production frontend build | Passed; existing chunk-size warning remains |
| Existing main browser workflows | 40 passed |
| Existing Lab browser workflows | 5 passed |
| Actual demo browser walkthrough, dismissal, and reset | 1 passed |
| Windows PowerShell demo launcher | Installed locked dependencies into a separate Python environment, built UI, started on port 18002, and returned healthy demo status |
| Synthetic demo screenshots | Visually reviewed and added to README/tour |

The machine's default Node 20 and npm 6 are below the documented requirements; prerequisite checks reject them before installation. Startup verification used installed Node 24.19.0 and npm 10.5.2 through an explicit PATH. The Visual Studio npm wrapper itself uses Node 20.13.1 and emitted engine warnings during dependency installation; the build used Node 24.19.0. This mixed developer environment is **not** clean-machine verification. Browser checks used the installed Chromium executable override. Python temporary-directory access and build/browser subprocesses required execution outside the tool sandbox.

The demo launcher now installs Python 3.11 into `data/demo/venv` to avoid replacing an existing development environment. An earlier launcher attempt tried to replace the existing Python environment and hit a locked executable; its dependencies were restored with the locked Python 3.13 setup before continuing verification.

Remaining release gates: clean Windows installation with standard runtimes, remote CI on the final commit, history/privacy audit, license, recorded walkthrough, and versioned release.

## Earlier documentation preparation

Verified during the September 2026 documentation preparation on `codex/cv-release-preparation`. This records a working-tree check, not a tagged release or a remote CI result. Existing application changes were present, and additional application work was occurring during verification; rerun against the final release commit.

## Results

| Check | Result |
| --- | --- |
| TypeScript and production frontend build | Passed; Vite retained its warning for a JavaScript chunk over 500 kB |
| Main browser workflows | 35 passed |
| Lab browser workflows | 5 passed, including synthetic request evidence/export |
| Backend and Lab Python tests | 268 passed in the full run; the other 13 passed after correcting the temporary-directory configuration |
| Relative Markdown links in the new documentation | Passed |
| Git whitespace check | Passed |

Local runtimes were Python 3.13.1 and Node 24.19.0. The machine's default Node was 20.15.0, so the build used an installed compatible runtime explicitly. Browser tests used the supported `PLAYWRIGHT_CHROMIUM_EXECUTABLE` override for installed Chromium because the browser revision expected by the installed Playwright package was absent.

## Environment corrections

The initial sandboxed Python run could not access pytest temporary directories. Running outside the sandbox resolved that permissions issue. A subsequent run used `data/release-pytest-verified` as its temporary root; this caused 13 policy checks to reject automatic-read rules because Relay deliberately excludes its own data directory from fast approvals. Those 13 checks passed with pytest's normal temporary storage. No policy code was changed to bypass that safeguard.

Vite's esbuild subprocess also required execution outside the sandbox. No application change was needed for the build. Main browser tests used port 18000 and `data/e2e.db`; Lab browser tests used port 8018. These checks used synthetic data and requested no paid model evaluation.

## Still required before release

- A clean installation using the documented locked dependency commands and standard runtimes.
- One complete check run against the final committed source and a successful remote CI run.
- A review of tracked content and history for private data or credentials.
- A license decision, final version/release notes, and a public walkthrough link.

The new README screenshots were visually inspected and contain synthetic test fixtures. This does not constitute a full repository privacy audit. See the [release checklist](release-checklist.md).
