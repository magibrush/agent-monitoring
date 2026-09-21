# RFC 007: Automated incident investigation

> Anthropic is the default and recommended judge provider. OpenAI is also available for judgments and incident analysis, but has not been tested with live API calls. See [OpenAI setup](live-safety.md#optional-openai-credentials-untested). Anthropic-specific details below describe the default configuration.

> Historical design record. Setup, UI, and timing details may have changed. See [current setup](setup.md), [architecture](architecture.md), and [usage](usage-reference.md). Test results below belong to this milestone.

Implemented 20 September 2026. Extends RFC 006's operator-triage milestone.

## Value and workflow

Routine decisions stay with the rules. The judge can let an action continue while flagging a concern, and Relay automatically gathers the conversation, relevant requests and recorded outcomes into an incident. The user gets an explanation and evidence-backed suggestions instead of a ticket to fill out.

Safety keeps live approvals at the top. Incidents are ranked Critical, High, Medium, Low, then newest. The inspector leads with the concern and outcome, followed by automatic Haiku analysis, cited findings, suggested next steps, and a conversation timeline. Each assessed action shows its own severity and reason. Technical request details remain secondary. Notes, manual attachment and administrative history are no longer exposed in this flow; existing data and APIs are preserved.

## Routing and judgment

1. Built-in prohibitions retain priority, including protected credential directories and explicit root deletion.
2. Applied custom rules handle known actions deterministically. Allow, review and deny shortcuts avoid model calls; an explicit judge rule goes to the judge.
3. Unmatched actions get bounded threat-pattern hints for destructive commands, history rewrites, network transfers, credential access, privilege/persistence and obfuscated execution.
4. The judge decides using the action, recorded context, policy and those hints. Unknown unmatched actions also reach the judge. A missing regex match is never an automatic allowance, and a pattern match is not proof of malicious intent. No new shell fast-approval path was added: aliases, configured helpers and compound syntax can conceal effects.

The judge's strict structured result includes `recommendation` (allow/review/deny), `suspicious` (boolean) and `severity` (low/medium/high/critical), plus the existing reason/evidence/context and legacy risk field. Suspicion and severity are separate from permission. Allow+suspicious+low is valid. Review and deny have a server-enforced high severity floor. Critical does not itself override the verdict. Missing or malformed new fields fail schema validation and use the existing bounded failure behavior.

A verdict does not prove that a hook released a request. A delivered pass does not prove successful execution. The timeline labels assessment, gate receipt and execution separately; shadow recommendations never claim to have blocked an action.

## Incident creation and grouping

A separate correlation cycle reads at most 100 eligible persisted assessments every two seconds. It never calls a model or participates in the live gate decision.

- Suspicious judge findings create an incident immediately, including allowed actions at low severity.
- Judge reviews and deny recommendations create an incident immediately; reviews have high severity even if a legacy result says low.
- A routine policy review does not create an additional task. Repeated deterministic denials and service failures retain the three-in-ten-minutes threshold.
- Judge concerns now group by connection and conversation, across tools and threat categories. Deterministic patterns retain their existing rule/resource grouping.
- Severity is the highest linked assessment severity. Existing records are backfilled from their saved evidence on upgrade.
- New suspicious evidence after dismissal brings back the same incident. Earlier requests completing late attach without reopening it. Routine repeated patterns still need their threshold.
- Debug assessments and retrospective retries are excluded. Restart-safe candidate records prevent duplicate processing. Existing historical assessments are not re-judged.

Dismissal is optional and does not change a rule, approval or gate decision. Legacy saved policy investigations retain their exact-rule navigation and focused draft comparison.

## Automatic analysis

A dedicated worker lane runs independently of the configured live gate lanes. New evidence queues an analysis after a 30-second debounce. Completed analyses have at least a 60-second cooldown; a bounded idle sweep catches later receipts and transcript changes. There are at most two attempts per evidence revision. No key means no network calls or consumed attempts. Automatic uploads require an enabled connection with protection hooks, using the existing Anthropic credential.

The analysis model is `claude-haiku-4-5-20251001`. Its evidence bundle is bounded to 20 linked requests, 40 total records and 40,000 characters, with redaction and per-record excerpts. Flagged actions are budgeted before neighboring context. Original truncation is disclosed. Real event IDs and session identities accompany user intent, messages, tool requests and results; unverified live-context text is not assigned invented IDs.

The analyst gets no executable tools. All transcript content is explicitly untrusted. Structured findings and recommendations must cite event IDs present in the supplied bundle; unknown references and oversized outputs are rejected. Suggestions never execute, change rules or approve requests. Model output is labeled Haiku analysis and is not a claim of verified compromise or remediation.

Claims happen in short database transactions. The database is closed during the model call, which runs in a separate process with a 25-second wall-clock budget and bounded response size. Publication checks lease, revision, current evidence and source eligibility. Deleted incidents cannot be recreated by a late result. New evidence hides stale advice; failed, unavailable and missing-key states show the recorded timeline without claiming analysis is in progress.

## Storage and rollout

Migration 0016 adds incident severity and `incident_analyses` to the existing 0015 schema. Analysis rows cascade with incidents and connection deletion. The migration derives existing severity from linked assessments, without model calls. Existing saved incidents without analysis remain readable; new linked evidence queues analysis when eligible.

Back up the local database, allow blocking requests to finish, migrate to head, rebuild the frontend and restart both API and safety worker. The external gate contract is unchanged. Source transcripts are untouched.

## Validation

Architecture/design/security review approved after corrections to category grouping, historical severity, evidence retention, stale refresh and outcome wording. Backend tests cover threat routing, explicit policy precedence, strict verdicts, suspicious allowances, severity ranking, correlation, migration round trips, redaction, citations, leases, stale/deleted publication, cooldowns and late receipts. Browser fixtures cover an allowed-but-flagged force push that Git subsequently rejected, cited advice, conversation navigation, dismissal, per-action severity, existing policy comparisons, diagnostics and unavailable analysis.

Browser analysis text uses deterministic test fixtures; it is not evidence of live model judgment quality. Model quality and calibration need observation on real, authorized traffic separately from integration tests.

Final validation: 246 backend tests passed, followed by all 16 incident tests with the historical-severity migration case. All 35 browser scenarios passed across the full run and focused rerun after updating the per-action-severity assertion. Production build and TypeScript pass. UI/UX review approved fresh desktop, mobile and missing-key captures after the requested refinements. Local migration 0016, API health and worker startup were verified after a database backup. Existing saved evidence was not submitted to the model during rollout; future incidents use the installed automation.
