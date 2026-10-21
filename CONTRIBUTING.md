# Contributing to FactoryFlow

Thanks for your interest. FactoryFlow is a small, opinionated reference implementation, so the bar is less
"more features" and more "every number is defined, traceable and tested".

## Setup

Requires Node.js 22+ and npm.

```bash
git clone https://github.com/djmartin2019/FactoryFlow.git
cd FactoryFlow
npm install
npm run dev
```

## Before you open a pull request

Run what CI runs (`.github/workflows/ci.yml`); all five must pass:

```bash
npm run typecheck       # strict: domain, scripts, tests, examples
npm run typecheck:app   # app code under src/
npm test                # Vitest, including the contract tests
npm run validate:data   # re-validate the committed dataset and prove determinism
npm run build           # typecheck + production build
```

The 3D scene and DOM components have no automated tests. If you change them, say in the PR what you checked
by hand and in which browser.

## Rules that keep the project honest

The full list is in [`CLAUDE.md`](CLAUDE.md). The ones reviewers check first:

- **Layers.** `src/manufacturing/` is pure TypeScript (no DOM, Three.js or timers). `SimulationController` is
  the only clock. `src/analytics/` is UI-independent. `src/ui/` and `src/graphics/` read state and never mutate it.
- **Definitions before charts.** A new on-screen number needs a definition in
  [`docs/KPI_DEFINITIONS.md`](docs/KPI_DEFINITIONS.md) first, and a test that recomputes it.
- **Observed, synthetic and forecast data stay distinguishable.** Anything estimated is labelled as a forecast.
  The demo stays labelled as synthetic.
- **Units.** Money is integer cents, durations are integer minutes, timestamps are ISO UTC.
- **Contracts.** Event shapes and reducer rules are pinned by `tests/fixtures/canonical` and its hash. Changing
  them means updating the fixture deliberately, bumping `SCHEMA_VERSION` and writing a migration note, in a
  PR that contains nothing else.
- **No new runtime dependency, database, backend or framework** without a concrete need discussed first.
- Update [`docs/STATUS.md`](docs/STATUS.md) when something moves from proposed to implemented.

## Where to start

[`docs/OPEN_SOURCE_DEVELOPMENT_PLAN.md`](docs/OPEN_SOURCE_DEVELOPMENT_PLAN.md) lists the planned slices with
their acceptance criteria (section E). Open an issue before starting anything large, so the definition can be
agreed first.

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
