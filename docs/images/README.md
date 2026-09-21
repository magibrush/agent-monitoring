# Screenshot sources

All images capture the real UI using synthetic fixtures. No generated images, private conversations, or live model calls were used.

| Images | Source |
| --- | --- |
| `demo-guided-tour.png`, `demo-overview.png`, `demo-incident.png`, `demo-connections.png` | `frontend/demo-tests/demo.spec.ts`; actual demo server |
| `overview.png` | `frontend/tests/workflows.spec.ts` |
| `incident.png` | `frontend/tests/incidents.spec.ts` |

See [testing](../testing.md) to regenerate. Main-suite captures go to ignored `data/qa/`; demo captures go to `frontend/test-results/`. Inspect every new capture for private content before copying it here. Fixture timestamps/counts may change between runs.
