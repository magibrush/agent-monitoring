# CV release checklist and roadmap

This checklist distinguishes prepared materials from release gates. An unchecked item means release evidence or a decision is still needed.

See [local verification results](release-preparation-verification.md) for the checks already performed and their limits.

## Prepared materials

- [x] Short README with purpose, components, prerequisites, credentials, and limitations.
- [x] Detailed setup, architecture, demo, and testing guides.
- [x] Preserve detailed existing usage notes outside the README.
- [x] Add a Windows CI workflow for Python, frontend build, and browser checks.
- [x] Document a key-free synthetic Lab walkthrough.

## Before tagging a release

- [ ] Review and commit the intended source changes, including the Lab and pre-existing work in the branch.
- [ ] Verify installation in a clean Windows environment with standard runtimes and no personal configuration.
- [ ] Run all documented checks on the release commit; inspect the remote CI result.
- [ ] Verify the short demo on that commit; document any setup deviations.
- [ ] Review tracked files and Git history for secrets and private data. Ignore rules do not remove earlier commits.
- [ ] Choose a license and add its text before advertising open-source reuse.
- [x] Capture two synthetic-data screenshots and inspect them for private content.
- [ ] Record a short walkthrough and link it from the README.
- [ ] Add the final repository description and topics on the hosting platform.
- [ ] Write release notes, choose a version, and publish a tag/release.
- [ ] Add the public repository/release link to the CV and verify it is accessible while signed out.

No license, public publishing action, or version tag is selected by this checklist. Those are repository-owner decisions.

## Release-note outline

- What Relay does and who the local prototype is for.
- Supported integrations and tested operating system/runtime versions.
- Key-free Lab demo and optional Anthropic setup.
- Verification performed on the release commit.
- Known limitations: hook coverage, local plaintext data, model uncertainty, and contention.
- Next priorities without promised dates.

## Near-term roadmap

1. Provide a dedicated synthetic main-dashboard demo, independent of browser-test fixtures and real agent history.
2. Calibrate live judge cases and report false positives, false negatives, and model disagreements separately from pipeline failures.
3. Measure and reduce database contention at realistic local arrival rates; retain failed-run evidence.
4. Validate additional operating systems before documenting them as supported.

Authenticated multi-user operation, protected policy storage, executor isolation, distributed queues, and PostgreSQL are future architecture work, not prerequisites for a clearly scoped portfolio release.

## CV wording

> Built Relay, a local monitoring and safety-review application for AI coding agents using React, TypeScript, FastAPI, and SQLite, with recoverable transcript ingestion, policy-based tool review, incident investigations, and an isolated reliability-testing lab.

Adjust emphasis to the target role. Add numerical claims only when tied to a reproducible result and an honest definition of what was measured.
