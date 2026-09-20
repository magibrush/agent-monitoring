# Release preparation: local verification

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
