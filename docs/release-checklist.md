# Release checklist

The demo, screenshots, guides, and Windows CI workflow are in place. [Local verification](release-preparation-verification.md) records development checks; it is not release certification.

## Before tagging

- [ ] Commit the intended source changes.
- [ ] Follow [setup](setup.md) and the [demo](../README.md#run-the-sample-demo) on a clean Windows environment with standard runtimes.
- [ ] Run [all checks](testing.md) on the release commit and inspect remote CI.
- [ ] Review tracked files and Git history for secrets/private data.
- [ ] Choose a license and add its text.
- [ ] Record a short walkthrough and replace “Video coming soon” in the README and demo guide with its link.
- [ ] Set the repository description/topics and verify public access while signed out.
- [ ] Write release notes, choose a version, and publish the tag/release.

Release notes should state supported integrations, tested runtimes, demo/setup links, verification on that commit, and known limits. Tie numerical claims to reproducible measurements.

## Next priorities

1. Calibrate live judgments, separating model disagreements from pipeline failures.
2. Measure and reduce SQLite contention at realistic arrival rates.
3. Verify other operating systems before claiming support.

See [architecture](architecture.md#trade-offs) for longer-term changes needed for multi-host operation.
