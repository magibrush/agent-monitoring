# Relay Lab

> Anthropic is the default and recommended judge provider. OpenAI is also available for judgments and incident analysis, but has not been tested with live API calls. See [OpenAI setup](../docs/setup.md#optional-openai-credentials-untested). Anthropic-specific details below describe the default configuration.

A separate local app for sending synthetic agent activity through Relay. It needs
the same Python environment as Relay; there is no additional frontend build.

From the repository root:

```powershell
.venv\Scripts\python.exe -m lab.server
```

Open **http://127.0.0.1:8010**. `--port 8018` chooses another local port.

## What to run

- **Scenarios:** select the six policy examples, boundary cases, built-in
  root-deletion protection, and judge decisions. Each selected scenario runs exactly once.
- **Custom request:** enter the user request, tool name, and JSON arguments.
  Runs one request. In live mode, expected results are comparison targets; in
  simulated mode, they supply the judge response.
- **Load test:** start with a burst, capacity saturation, replay and
  reordering, or a recoverable provider error. Judge responses are simulated.
  Request mix and advanced controls are collapsed by default. Adjust up to 10,000 actions,
  256 simultaneous queue clients, 32 connections, and 8 workers. A rate of zero
  submits as fast as clients become available; a positive rate paces arrivals.
- **Real gate-hook processes:** exercises the actual stdin/exit-code boundary,
  limited to 32 concurrent Python processes. Queue clients share the production
  capture, reply validation, and receipt functions, avoiding thousands of Python
  processes while preserving the durable protocol.
- **Unanswered review:** keeps the real 60-second deadline. **Workers offline**
  exercises automated-budget expiry. No production timing or capacity limits
  are relaxed for the tests.

## Two different kinds of evidence

**Scripted** is the default and never calls an LLM. The real worker claims jobs,
retries, and persists results, but an injected evaluator returns a known response.
This proves the pipeline handles deny, review, allow-with-suspicion, severity,
receipts, and incidents correctly. It does **not** prove model detection accuracy.

**Live judge** calls the configured judge provider with synthetic conversation
and action data. Nothing asks an upstream LLM to generate the action, and neither
the expected verdict nor test instructions enter the model snapshot. Live runs
are limited to 25 actions and 4 concurrent clients. Model disagreement is shown
separately from a pipeline failure. In particular, “allow but suspicious” examples
are hypotheses for the live model, not guaranteed classifications. Use made-up
data in custom scenarios; live mode sends it to the configured judge provider and incurs API charges.
The action's working directory is a fictional `Workspaces/storefront` path. It is
never created or accessed; the real transcript location stays out of the model
snapshot so that a lab directory name cannot give away the test framing.

**Include incident analysis** also runs the existing independent analysis lane,
including its real debounce and evidence checks. Scripted analysis returns cited
fixtures; live analysis uses the configured provider. The drain window is up to
185 seconds, with a maximum of 25 actions so the analysis queue can settle.
Without this option, incident creation is tested and analysis remains
queued; it is never reported as tested.

## Reading a run

- A **delivered** request has a persisted gate receipt. A release is permission,
  not evidence that the tool ran. The lab never executes a tool command.
- **Passed** means the expected assessment and required delivery/incident checks
  passed. **Capacity blocked** means Relay rejected overload safely; it is not a
  successful model assessment. **Fault blocked** means an injected outage failed
  closed. **Judge differed** identifies a live result outside the expected fields.
- Missing or mismatched receipts, unsafe releases, duplicate evaluations, missed
  incidents, incomplete messages, and leftover hook files remain visible failures.
- Latencies run from a client's submission through its gate return. Percentiles
  include only requests with both a client return and persisted receipt. The rate
  divides delivered receipts by traffic duration, excluding the final drain.
  Blocked requests count toward this delivery rate; it is not model throughput.
- Completion hooks are synthetic. The out-of-order option intentionally delivers
  a completion before a request, even for actions that subsequently get blocked.
- Stop prevents new submissions. In-flight requests keep their normal deadlines
  and collectors drain. A stopped/crashed run never counts unstarted work as passed.

## Isolation and artifacts

Every run starts a subprocess with a new migrated database in
`data/lab/<uuid>/relay.db`, private queues, and synthetic transcript files. It does
not connect to port 8000, modify provider hook settings, read real conversations,
or reuse the production database. The application has no arbitrary target URL.
Only one run is active at a time through the UI.

Each directory retains `config.json`, `report.json`, `runner.log`, and per-action
`evidence/<index>.json` with the exact frozen context and incident evidence.
Export JSON downloads the full report, including all rows; the UI paginates them.
Restarting the lab preserves results and marks unfinished runs interrupted.
There is no automatic deletion of run data.

The collector and worker run in separate processes, with the real worker service,
lanes, heartbeat, and independent analysis capacity. The only production service
change is an optional stop event for cleanly shutting down the owned worker.
The lab measures this pipeline and SQLite contention on this machine; it does
not benchmark Relay's HTTP server. Large queue runs can still compete with other
local applications for CPU and disk.
Each action uses a fresh Codex CLI conversation, so this load includes session
creation and transcript ingestion. Claude and Desktop adapter coverage remains
in the main backend test suite.

## Tests

```powershell
.venv\Scripts\python.exe -m pytest lab/tests -q
```

Browser tests use `frontend/playwright.lab.config.ts` and a separate lab server
on port 8018. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to your Chrome path if needed.
