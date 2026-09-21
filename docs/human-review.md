# Human review

Open **Safety → Needs your decision**. Read the proposed action and reason, then choose **Approve** or **Deny**.

- **Approve** releases that exact request to the agent's native permission checks.
- **Deny** blocks it.
- **Expiry** blocks it automatically. The 60-second deadline includes evaluation and your response; an expired request must be submitted again.

Live reviews stay visible across all connections, regardless of history filters. **Pending** means automated evaluation; **Awaiting approval** needs you. An approval is separate from the judge recommendation, delivery receipt, and execution result. Resolving an incident never approves an action.

## Notifications

Choose **Enable notifications** in Safety and allow the browser permission. Keep a Relay tab open. Notifications show the tool, session, reason, and expiry; supported browsers also offer Approve/Deny. Clicking an alert opens the review. Browser suspension and OS settings can delay alerts. Turn them off in Safety settings.

## Technical safeguards

Review updates bind to the evaluation ID, action hash, review state, deadline, and absence of a prior decision or receipt. Concurrent decisions have one winner; stale clicks return a conflict. Truncated actions, deterministic denials, and shadow assessments cannot be approved. A release is counted only after a gate receipt.

This is a single-user local app. A process with the same OS permissions can access its API, database, and queue; it is not an authenticated approval service or security boundary.

Tests cover pause → review → approval/denial → receipt, expiry, action binding, and concurrent decisions. `scripts/check_judge_calibration.py` is an opt-in paid Anthropic check using built-in synthetic cases; it executes no proposed commands. See [testing](testing.md).
