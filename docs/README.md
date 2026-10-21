# FactoryFlow documentation

Start with [`STATUS.md`](STATUS.md): it says what exists today. Everything else is either a description of the
current code or a plan, and each file says which.

## What exists and how it works

| Document | What it is |
| --- | --- |
| [`STATUS.md`](STATUS.md) | Implemented, partial and proposed capabilities. The current truth when documents disagree |
| [`PLANT_MANAGER_GUIDE.md`](PLANT_MANAGER_GUIDE.md) | How the plant, the screens and the numbers work, for plant managers and manufacturing reviewers |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Data path, layers, IDs, events, and the function and records behind each on-screen number |
| [`KPI_DEFINITIONS.md`](KPI_DEFINITIONS.md) | Definition of every metric: numerator, denominator, window, N/A rules, limitations |
| [`REDUCER_RULES.md`](REDUCER_RULES.md) | Every business rule the reducer enforces, classified |
| [`PERFORMANCE.md`](PERFORMANCE.md) | Measured baselines (recorded, not asserted in CI) |
| [`RELEASE_0.1.0.md`](RELEASE_0.1.0.md) | Release record for 0.1.0: checks run, license and asset review, smoke test, open items |
| [`../src/manufacturing/README.md`](../src/manufacturing/README.md) | The synthetic data model and its sources of variability |

## Plans and intent (not implemented unless `STATUS.md` says so)

| Document | What it is |
| --- | --- |
| [`OPEN_SOURCE_DEVELOPMENT_PLAN.md`](OPEN_SOURCE_DEVELOPMENT_PLAN.md) | Release scope and roadmap (0.1.0, 0.1.x, 0.2.0, 0.3.0), slice specifications, owner decisions |
| [`SOURCE_INTEGRATION_PLAN_REV3.md`](SOURCE_INTEGRATION_PLAN_REV3.md) | Authoritative design for source independence (the `src/sources/` boundary) |
| [`FACTORYFLOW_DESIGN.md`](FACTORYFLOW_DESIGN.md) | Long-term product and domain intent |

## Archived

| Document | Status |
| --- | --- |
| [`SOURCE_INTEGRATION_PLAN.md`](SOURCE_INTEGRATION_PLAN.md) | Revision 1, superseded by Revision 3 |
| [`SOURCE_INTEGRATION_PLAN_REV2.md`](SOURCE_INTEGRATION_PLAN_REV2.md) | Revision 2, superseded by Revision 3 |

Contributor workflow: [`../CONTRIBUTING.md`](../CONTRIBUTING.md). Agent and contributor rules: [`../CLAUDE.md`](../CLAUDE.md).
