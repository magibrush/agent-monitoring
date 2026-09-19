# RFC 006: Predictable safety decisions and operator triage

Status: milestones 1 and 2 implemented, 19 September 2026. Later milestones are proposals.

## Problem and current system

Relay proves synchronous pre-tool interception, deterministic prohibitions, a durable SQLite queue, concurrent Haiku evaluation, exact-action human approval, and delivery receipts. Every action not deterministically denied still reaches Haiku. The 60-second hook deadline includes ingestion, queueing, model attempts, human review, and delivery. A receipt is not proof of execution, and installed hooks are not proof of coverage.

Current bottlenecks: transcript and hook ingestion share a process lock; shadow traffic shares admission and worker capacity with blocking traffic; a 25-second model attempt plus retry can exhaust the human-response window; 120-second leases outlive blocking requests. Last-attempt latency conceals queueing and prior attempts.

## Target architecture

Paused request → validate typed action and resource scope → deterministic policy → release, deny, or bounded judge assessment → human approval where authority is missing → immutable decision and receipt.

Audit, incident correlation, retrospective evaluation and policy-impact analysis run independently. A stronger judge is an optional measured escalation for difficult interpretation, not a substitute for missing authorization or evidence. No asynchronous audit can undo an action already released.

## Milestone 1: Measure and isolate

- Separate hook collection/decision delivery from transcript synchronization's application lock. Bound production transcript write batches and retain atomic checkpoint/event commits. SQLite remains a single-writer database; this removes application-level head-of-line blocking, not all storage contention.
- Persist intake, rules duration, first worker start, review-ready, and first reply-publication timestamps. Preserve attempt durations and usage across retries. Expose queue, inference, human, delivery, and complete gate-pause timing without relabeling partial measurements as complete.
- Provide a compact operational summary with p50/p95/p99, sample counts, failures/expiries, and aggregate blocked-agent time. Keep raw context out of metric labels; old records with missing timing remain unknown.
- Add a versioned synthetic calibration corpus: routine allow, concrete deny, material uncertainty, prompt-injection/false-lock claims, and incomplete evidence. Offline checks always run; optional live judging uses only built-in synthetic evidence, never historical user conversations. Report confusion counts and per-case results rather than claim general accuracy.

## Milestone 2: Protect the deadline

- Keep the original 60-second gate deadline. Reserve 30 seconds for a person and a small delivery margin. Propagate the earlier automated-evaluation cutoff through admission, claims, network calls, retries, leases, and result acceptance.
- No budget exhaustion silently allows an action. Requests that cannot complete evaluation fail visibly and remain blocked; genuine judge review recommendations enter human review. Expired actions cannot be revived.
- Bound real judge execution with a wall-clock supervisor, not only a socket inactivity timeout. Fence late results. Recover abandoned blocking leases only while another bounded attempt can fit.
- Reserve admission capacity for blocking jobs; enforce a per-connection pending cap to prevent one source consuming it. Keep global capacity bounded. Preserve blocking-first, earliest-deadline claiming.
- Reserve worker lanes for blocking work. Shadow work uses only designated shared lanes. A one-worker configuration serves blocking work only and reports that shadow processing needs additional capacity. Reservations are per worker process, not a claim of a distributed provider quota limiter.
- Publish and consume decisions before and between small hook batches. Do not allow historical missing receipts to starve current requests.

Initial performance hypotheses: deterministic p95 under 100 ms including hook overhead where feasible; automatic gate-pause p95 under five seconds by path; human reviews presented with at least 30 seconds remaining. These are targets, not measured guarantees. Track p99, missing receipts, failures and expiry alongside percentiles to avoid success-only reporting. The browser polling/OS notification delay still consumes part of the human window.

## Milestone 3: Narrow fast approvals

Implemented as rules-first local policies with all/selected connection scopes; typed file, shell, Git-push, credential, network and exact-tool activities; conflict notices; historical previews; optional observational live tests; explicit application and history-based rollback. Normalization is separate from matching and lifecycle. Fast approvals are limited to supported file reads with explicit connection, directory and extension scope. Matching requests bypass the queue and model; no-match requests retain existing judging. See [the policy guide](policies.md) for boundaries and operating instructions. Multi-user authenticated authorship and a policy store outside the monitored OS account remain future work.

## Later milestones

Human approval never automatically becomes a permanent rule. Shell prefixes are insufficient proof of bounded effects.

4. Operator triage: Decide now, Investigate, Protection. Order reviews by urgency; group incidents without bulk authorizing requests. Distinguish historical unassessed imports from expected-but-missing protection. Add authenticated ownership, assignment, audit and service-backed alerts independent of an open browser. Incident acknowledgment never releases a request.

5. Selective stronger-model escalation only when labeled evaluations demonstrate enough quality gain for its latency/cost. Improve evidence provenance, resource scope and cross-action context before simply increasing transcript size. Sample allowed actions as well as blocked ones; human overrides are feedback, not ground truth.

6. Multi-host authentication/RBAC and an executor boundary the monitored agent cannot bypass. Migrate to PostgreSQL/broker/autoscaling only against measured load. Define per-action-class outage behavior and snapshot retention/access policy. Do not add a global fail-open switch.

## Validation and rollout

Synthetic tests cover queue reservations, fairness caps, attempt time budgets, worker loss/stale result fencing, hard wall-clock limits, timing correctness, concurrent hooks during backfill, and migration compatibility. No test executes proposed harmful commands. Back up the local database before migration; restart API and worker together with no live blocking requests. Manually verify ordinary release, human review countdown and notification, large backfill responsiveness, offline worker/late result handling, and the health summary. External judge calls remain opt-in.

## References

- Existing design: [ingestion and enforcement](ingestion-and-enforcement.md), [blocking safety](rfc-005-blocking-safety.md), [human review](human-review.md).
- [Anthropic routing/workflow guidance](https://www.anthropic.com/engineering/building-effective-agents).
- [OPA versioned policy bundles](https://www.openpolicyagent.org/docs/management-bundles) and [decision logs](https://www.openpolicyagent.org/docs/management-decision-logs).
- [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/concepts/semantic-conventions/).

## Implementation verification

124 backend tests and 24 browser tests pass; TypeScript and production build pass. Migration 0010 passed upgrade/downgrade/upgrade on an isolated database. The 12-case offline corpus routes 11 cases to the judge and deterministically rejects one; no live calibration API calls were made, so this establishes plumbing and policy behavior, not model accuracy or production latency. The local database was backed up before migration and the API/two-lane worker restarted with no active blocking requests.

The current implementation remains single-host SQLite. Per-connection admission caps and process-local reserved lanes are not distributed rate limiting. Browser notifications still require an open tab. Interpreter startup before gate-wrapper entry is outside recorded pause time. Protecting SQLite from arbitrary long filesystem I/O or migrating to a separate decision datastore remains future work if measurements show contention.
