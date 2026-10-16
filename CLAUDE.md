# FactoryFlow: guidance for contributors and coding agents

FactoryFlow's product direction, manufacturing domain contracts, real-data integration requirements, and
development roadmap are documented in `docs/FACTORYFLOW_DESIGN.md`.

Before implementing a substantial new feature, read that file and inspect the current code. Treat it as an
architectural guide rather than a claim that all features exist (`docs/STATUS.md` says what does). Preserve
the separation between simulation, analytics, and rendering; avoid broad rewrites; implement thin, tested
vertical slices; keep synthetic, observed, and forecast data clearly distinguishable. When design and
existing implementation differ, identify the gap and propose the smallest safe change.

## Where things live

| Layer | Path | Rule |
| --- | --- | --- |
| Domain core | `src/manufacturing/` | Pure TypeScript. No DOM, Three.js or timers. Reducer in `state.ts` enforces business rules. |
| Simulation clock | `src/simulation/` | `SimulationController` is the **only** clock. Do not add a second one. |
| Analytics | `src/analytics/` | UI-independent reporting over a `ReportingSnapshot`. |
| Rendering | `src/graphics/`, `src/ui/` | Read state through selectors, `mapping.ts` and analytics. Never mutate state. |

Data path, IDs, events and KPI sources: `docs/ARCHITECTURE.md`. KPI semantics: `docs/KPI_DEFINITIONS.md`.

## Commands

```bash
npm test                # Vitest (includes tests/contract.test.ts)
npm run typecheck       # strict: manufacturing, scripts, tests, examples
npm run typecheck:app   # app code under src/
npm run validate:data   # re-validate generated data + determinism
npm run build           # tsc + vite build
```

CI runs all of the above (`.github/workflows/ci.yml`). Run them before declaring work done.

## Rules

- Inspect before changing. Prefer extending existing selectors, metrics and types over adding parallel ones.
- No database, broker, auth or framework without a concrete need.
- Keep the demo clearly labelled as synthetic data.
- Every on-screen number must trace to events and state. Define semantics (in `KPI_DEFINITIONS.md`) before
  building a chart or card.
- Money is integer cents, durations are integer minutes, timestamps are ISO UTC.
- Event shapes and reducer rules are a contract pinned by `tests/fixtures/canonical`. Changing them means
  updating the fixture deliberately, bumping `SCHEMA_VERSION` and noting a migration.
- Do not commit anything under `dist/`. `public/data` is a symlink to `data/generated/`.

## When you finish a change, report

What changed, which contracts changed, migration notes, tests run, and what remains hypothetical.
