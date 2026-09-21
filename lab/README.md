# Relay Lab

[← Relay](../README.md)

Test synthetic tool requests through Relay's decision pipeline. Lab never executes the described commands and keeps each run separate from your monitoring data.

## Start

Requires [uv](https://docs.astral.sh/uv/); no Node build or coding agent is needed. From the repository root, these commands work in Windows PowerShell and Linux Bash (uv installs Python 3.11 if needed):

```sh
uv sync --locked --python 3.11
uv run --locked python -m lab.server
```

Open **http://127.0.0.1:8010**. Use `--port 8018` for another port; Ctrl+C stops the server.

On Linux, `bash scripts/start-lab.sh --port 8018` combines dependency setup and launch. On Windows, after syncing dependencies, `powershell -ExecutionPolicy Bypass -File scripts/start-lab.ps1 --port 8018` launches the same server.

## Try one request

1. Select **Custom request** and keep **Evaluate with → Simulated responses**.
2. Keep the prefilled **Unexpected data transfer** example and its Deny verdict.
3. Click **Test request**. Inspect the assessment, delivery receipt, and conversation evidence.
4. Use **Export JSON** to save the report.

Simulated responses need no API key. To explore rules, switch to **Scenarios** and choose a small selection.

## Screenshots

### Choose what to test

Select synthetic scenarios to exercise safety rules and the decision pipeline.

![Relay Lab scenario selection with synthetic test cases](../docs/images/lab-scenarios.png)

### Inspect a result

A completed simulated request shows its assessment, delivery receipt, and checks. Open a result to inspect the recorded evidence, or export the report as JSON.

![Relay Lab completed simulated request with results and delivery checks](../docs/images/lab-results.png)

## Choose a mode

| Mode | Purpose |
| --- | --- |
| Scenarios | Run each selected policy or boundary case once. |
| Custom request | Supply user intent, a tool name, and JSON arguments. |
| Load test | Exercise bursts, capacity limits, replay/reordering, or recoverable faults with simulated responses. |

**Simulated responses** use the real collection, worker, retry, and receipt machinery with a known evaluator result. They test the pipeline, not model detection accuracy.

**Live judge** sends synthetic action and conversation data to the configured provider using [configured credentials](../docs/live-safety.md#1-add-your-anthropic-key), incurring API charges. Anthropic is the default; [OpenAI support](../docs/live-safety.md#optional-openai-credentials-untested) has not been tested with live calls. Expected results are comparison targets and are not sent to the judge. Use made-up data. Live runs allow at most 25 actions and four concurrent clients; model disagreements are separate from pipeline failures.

**Include incident analysis** exercises the independent analysis lane with real debounce/evidence checks. It limits runs to 25 actions and allows up to 185 seconds to drain. Without it, incident creation is checked but analysis remains queued and is not reported as tested.

## Read the results

| Result | Meaning |
| --- | --- |
| Passed | Expected assessment and required delivery/incident checks passed. |
| Capacity blocked | Overload was rejected safely; this is not a completed model assessment. |
| Fault blocked | An injected outage caused a safe denial. |
| Judge differed | A live verdict differed from expected fields. |
| Delivered | A gate receipt was persisted; permission does not prove tool execution. |

Missing/mismatched receipts, unsafe releases, duplicate evaluations, missed incidents, incomplete messages, and leftover hook files remain failures. **Stop** prevents new submissions; in-flight work keeps its deadlines and drains. Unstarted work never counts as passed.

Latency measures client submission through gate return, using only requests with both a return and receipt. Delivery rate includes blocked requests and excludes final drain time; it is not model throughput. Completion hooks are synthetic, and reordering tests can deliver a completion before a request that is later blocked.

## Load controls and isolation

Queue mode supports up to 10,000 actions, 256 clients, 32 connections, and eight workers. Zero rate submits as fast as clients allow; positive rates pace arrivals. **Real gate-hook processes** test the stdin/exit-code boundary with at most 32 concurrent Python processes. Queue clients use the same capture, reply validation, and receipt functions.

**Unanswered review** keeps the real 60-second deadline; **Workers offline** tests automated-budget expiry. Production limits are not relaxed. Each action uses a fresh Codex CLI conversation, so load includes session creation and ingestion. This measures the local pipeline and SQLite contention, not HTTP-server throughput. Claude and Desktop adapter coverage lives in backend tests.

Each run has a subprocess, migrated database, private queues, and synthetic transcripts under `data/lab/<uuid>/`. It neither reads real conversations nor changes provider hooks. The UI runs one experiment at a time.

Artifacts include `relay.db`, `config.json`, `report.json`, `runner.log`, and `evidence/<index>.json`. JSON exports include every row. Restarting preserves results and marks unfinished runs interrupted; run data is not automatically deleted.

See [testing](../docs/testing.md) for Python/browser commands and [validation records](VALIDATION.md) for historical results, including failures.
