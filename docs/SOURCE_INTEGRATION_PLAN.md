# Source independence for FactoryFlow: integration boundary plan

> **Archived. Superseded by [`SOURCE_INTEGRATION_PLAN_REV3.md`](SOURCE_INTEGRATION_PLAN_REV3.md), which governs.** Kept for the
> history of the design decisions only; do not implement from this file.

Status: **proposal for approval. No code has been changed.**

## Context

FactoryFlow's generator, reducer, loader, analytics and UI all share one set of types (`src/manufacturing/types.ts`).
The app loads JSON with an `as` cast (`src/simulation/loadSimulationData.ts:13-15`), so nothing marks where
"a source" ends and "the product" begins. The goal is that a different source (JSON fixtures first, later ERP/MES)
can replace the simulation without touching domain logic, analytics or presentation.

Decisions already made with you:
1. **Contracts**: existing domain types stay canonical. Add an ingestion/provenance envelope. Loosen strict `*_CREATED` payload rules only when a real sparse source forces it.
2. **Sequencing**: an ingestion stage dedupes, orders and stamps the canonical `sequence`. The reducer stays strict.
3. **Sim schema**: a modest independent wire schema, with its own field names, units and status codes. It is not an ERP imitation.
4. **Interfaces**: milestone 1 builds only a narrow read-model port. Historical-query interfaces are written as types/docs and not implemented.

## 1. Assessment of the current architecture

**Already good, so preserve it**
- `FactoryReplay` (`src/manufacturing/replay.ts`) is pure, has no timers, and its header already calls it an integration point.
- Analytics takes a plain `ReportingSnapshot {asOfMs,startMs,master,state,events}` (`src/analytics/types.ts`) and imports nothing from `src/simulation`.
- The reducer (`state.ts`) enforces real business invariants and is pinned by `tests/contract.test.ts` plus the fixture in `tests/fixtures/canonical`.
- `validateDataset` (`validation.ts`) is a strong post-hoc oracle for any event stream.

**Coupling and gaps (concrete)**
| Finding | Where |
| --- | --- |
| Loader casts JSON, with no shape or version check. `SCHEMA_VERSION` is never read at runtime. | `loadSimulationData.ts:13-15` |
| Generator output *is* the internal type, so there is no wire format. | `generator.ts` `emit()` -> `buildEvent` |
| UI and graphics hold the live `SimulationController` and reach through it to `engine.master` and `engine.onEvent`. | `Dashboard.ts`, `StationDetails` wiring, `OperationsExplorer.ts`, `SceneManager.ts:5` |
| Only seam into analytics: `reportingSnapshot(sim)`. | `src/simulation/reportingSnapshot.ts` |
| Two "now"s: `controller.currentTime` vs `state.asOf`. `workstationViews` and `WipBuffers` default to `state.asOf`. | `selectors.ts:89`, `WipBuffers.ts` |
| Reducer is not exception-safe in place: a throw can leave `state` half-mutated. Rejections are untyped strings. | `state.ts` `applyEventInPlace`, `replay.ts:72` |
| Reducer requires contiguous `sequence` and monotonic timestamps. There is no dedupe, reorder, quarantine or late-event handling. | `state.ts:248-249` |
| No event provenance (source, occurred/ingested time, idempotency key). | `EventEnvelope`, `types.ts:646` |
| History exists only by replay (backward seek is O(n)). No stored KPI or work-order history. | `replay.ts:96`, `analytics/*` |
| Domain-purity leaks: `masterData.ts:1` imports 3D layout; `selectors.ts:5` imports a graphics type; generator/rng exported from the domain barrel; shift calendar is a hardcoded constant. | `src/manufacturing/` |
| No shared test helper for building a `ReportingSnapshot` (hand-built in 5 test files). | `tests/*` |

**Challenge to the framing.** "Dashboard independent of source" is mostly true at the analytics layer already. The real
work is (a) the *input* boundary (validation, provenance, ordering) and (b) the *UI/graphics -> SimulationController*
dependency. A bigger query/subscription/snapshot hierarchy is premature until a second source needs history; hence the
narrow port.

## 2. Dependency and data-flow diagram

```
 sources (outside the app's core)            integration boundary                core (unchanged vocabulary)         presentation
 ┌────────────────────────┐   wire records  ┌───────────────────────────┐ canon. ┌──────────────────────────┐        ┌──────────────┐
 │ simulation emitter      │ ─────────────▶ │ SourceAdapter<TWire>       │ ─────▶ │ Ingest (dedupe, order,    │        │ ui/graphics  │
 │ (generator + sim wire)  │                │  validate (runtime)        │ events │  quarantine, stamp seq)   │        └──────▲───────┘
 ├────────────────────────┤                │  normalize (ids/time/units)│  +     │          │                │               │
 │ JSON fixture source     │ ─────────────▶ │  map -> canonical          │ master │          ▼                │      ┌────────┴────────┐
 ├────────────────────────┤                │  provenance + issues       │ +      │ FactoryReplay / reducer   │ ─────▶ │ OperationalView  │ (port)
 │ future ERP/MES/DB/API   │                └───────────────────────────┘ state  │ (state.ts, unchanged)     │ state  │  state, master,  │
 └────────────────────────┘                          │ MappingIssue[]            └──────────────────────────┘        │  now, subscribe  │
                                                       ▼                                       ▲                         └────────▲────────┘
                                              issue/quarantine report                          │ clock (replay mode only)         │
                                                                                      SimulationController ────────────────────┘
                                                                                      (implements OperationalView)
                                                                                                │
                                                                          analytics (ReportingSnapshot) ◀── built from OperationalView
```

**Dependency direction** (arrows = "may import"):
`ui/graphics -> OperationalView port -> analytics, manufacturing (contracts+reducer)`.
`adapters -> contracts` (canonical types and provenance), never the reverse.
`sources/simulation/*` -> `adapters` (nothing in core imports a source).
`src/manufacturing` imports no adapter, no simulation clock, and no source schema. The clock lives behind the port and
only for replay-capable sources.

## 3. Responsibilities

**Source adapter (new, `src/sources/`)**
- Parse and runtime-validate wire records; produce `MappingIssue`s instead of fabricating values.
- Normalize ids, timestamps (to ISO UTC), units (minutes, integer cents), and status codes (unknown status -> issue, not a guess).
- Map to the *existing* canonical `FactoryEvent` payloads and `InitialStateFile` (master and opening state).
- Attach provenance (`sourceId`, `sourceEventId`, `occurredAt`, `ingestedAt`, `origin: "observed" | "synthetic" | "inferred"`).
- Does **not** apply business rules or call the reducer.

**Ingest stage (new, pure TS)**
- Idempotency by `(sourceId, sourceEventId)`, ordering by `occurredAt`, stamping `sequence`/`id`, quarantine for late/invalid events.
- Optionally pre-checks with a **non-mutating** apply (see risk 1) so one rejected event cannot corrupt live state.

**Contracts (additions only to `src/manufacturing/types.ts` or a sibling `contracts.ts`)**
- Existing entities and events remain the canonical shape.
- Add `EventProvenance`, `IngestedEvent = {event: FactoryEvent, provenance}`, `MappingIssue`, `SourceCapabilities`.
- Provenance sits **beside** the event (a parallel record keyed by event id), so the pinned event shape, fixture and `SCHEMA_VERSION` need no change in milestone 1.
- Distinguish **actual source events** from **inferred-from-snapshot-diff** events via `provenance.origin: "inferred"`; the UI must label these.

**Domain core:** unchanged, other than the optional atomic-apply helper.

## 4. Proposed interfaces and validation boundaries

```ts
// src/sources/types.ts
export interface SourceAdapter<TWire> {
  readonly sourceId: string;
  readonly capabilities: SourceCapabilities;            // { liveEvents, historyQuery, snapshots, ... }
  parseInitial(raw: unknown): Result<InitialStateFile, MappingIssue[]>;
  parseEvents(raw: unknown): { events: IngestedEvent[]; issues: MappingIssue[] };
}
export interface MappingIssue { severity: "error"|"warning"; code: string; sourceRef?: string; path?: string; message: string }
export interface EventProvenance { sourceId: string; sourceEventId: string; occurredAt: IsoTimestamp; ingestedAt: IsoTimestamp; origin: "observed"|"synthetic"|"inferred"; schemaVersion: string }

// src/sources/ingest.ts  (pure)
export function ingest(batch: IngestedEvent[], state: IngestState): { accepted: FactoryEvent[]; quarantined: Quarantined[]; state: IngestState };

// src/simulation or src/app: the narrow read-model port the UI consumes
export interface OperationalView {
  readonly state: Readonly<FactoryState>;
  readonly master: MasterData;
  readonly now: Date;                    // single "now" (resolves the two-clock issue)
  readonly range: { start: Date; end: Date | null };
  readonly epoch: number;                // history-discarded counter
  onEvent(l: (e: FactoryEvent, s: Readonly<FactoryState>) => void): () => void;
  reportingSnapshot(): ReportingSnapshot;
}
// types only for now (documented, not implemented):
export interface HistoryQuery { stateAt(t): Promise<...>; workOrderDetail(id): Promise<...>; throughput(win): Promise<...> }
```

**Runtime validation tool:** hand-written validators vs `zod`. Open question; I recommend **zod**, one dependency, scoped to
`src/sources`, because the wire schema and its types then have a single definition (details under "decisions to confirm" below).

**Simulation wire schema (`src/sources/simulation/wire.ts`)**: deliberately different from domain types, e.g. snake_case
keys, `occurred_at` with explicit `Z`, quantities as `qty`, durations in seconds (adapter converts to integer minutes),
status codes like `"RUN"/"IDLE"/"DOWN"` mapped to domain statuses, a source-native event id, and an `event_kind` string
instead of the domain `type` union. An **emitter** (`src/sources/simulation/emit.ts`) converts generator output
(`FactoryEvent`) to wire records; the generator itself is not rewritten. `data/generated/` gains `sim_wire_events.json`.

## 5. Incremental plan with acceptance criteria

Each step is a separate, testable commit. Existing suite stays green at every step.

**M0. Characterization safety net (tests only).**
Add a shared `tests/helpers/snapshot.ts` replacing the 5 hand-built `ReportingSnapshot` literals; add a test that replays
the canonical fixture and pins final-state hash. *Accept:* `npm test` green, no `src/` changes.

**M1. Contracts + provenance types + runtime validation primitives.**
Add `src/sources/types.ts` (interfaces above) and zod wire schemas. *Accept:* types compile in `typecheck`; unit tests
for validator failures (missing field, wrong unit, unknown status) return `MappingIssue`s and never throw.

**M2. Simulation wire format + emitter + adapter.**
Emitter produces `sim_wire_events.json` (+ initial state wire file) from the generator. `SimulationAdapter` maps back.
*Accept (source-independence proof):* `adapter(emit(events))` deep-equals the original `events`; generator `eventLogHash`
and `tests/fixtures/canonical` hash `6ed76381` are unchanged; `validate:data` green.

**M3. Ingest stage.**
Pure `ingest()` with dedupe, ordering, late quarantine, sequence stamping. *Accept:* duplicates ignored (idempotent
replay), shuffled input produces the identical accepted stream, a late event is quarantined with an issue, replay of
accepted events reproduces `final_state.json`.

**M4. Route the app through the boundary (the stated milestone).**
`loadSimulationData` becomes `loadSource(adapter)`: fetch wire files -> adapter -> ingest -> existing `SimulationController`.
App behavior must be identical. *Accept:* with the app run via `npm run dev`, the dashboard, 3D scene and explorer show the
same numbers as before at identical sim times (compare KPI cards at 3 fixed seek points before/after); `npm run build`,
`npm test`, `npm run typecheck`, `typecheck:app`, `validate:data` all green; a grep test asserts nothing outside
`src/sources/simulation` and `scripts` imports the sim wire schema.

**M5. OperationalView port.**
`SimulationController` implements `OperationalView`; `Dashboard`, `PlaybackToolbar`, `OperationsExplorer`, `SceneManager`
take the port; remove `engine.*` access from UI; `reportingSnapshot` becomes a method. Unify "now" (pass the view's `now`
into `workstationViews` / `WipBuffers`). *Accept:* an import-boundary test (ts-based or grep) fails if `src/ui` or
`src/graphics` imports `src/simulation/*` or `engine`; behavior identical to M4.

**M6. Second adapter: independent JSON fixtures.**
Hand-authored fixture files in a different shape than the sim wire (e.g. a tiny MES-like export) under
`tests/fixtures/sources/json-mes/`, plus `JsonFixtureAdapter` and a loader that selects the source by config/query param.
*Accept:* app boots from the fixture source with the simulation module not loaded (a test imports the app bootstrap with
simulation emitter mocked out); analytics test suite runs against a fixture-sourced snapshot; fixture replay satisfies
`validateDataset`'s invariants.

**M7. Hardening (separate PR).**
Non-mutating/atomic apply path for ingest pre-check; typed rejection codes; bump `SCHEMA_VERSION` + migration note only
if canonical shapes change.

## 6. Design rationale

| Decision | Solves | Layer | Alternatives | Cost | How to prove it is real |
| --- | --- | --- | --- | --- | --- |
| Domain types stay canonical | Avoids a second vocabulary and fixture rewrite | `manufacturing` | Separate neutral contracts | Heavy adapters for sparse sources | M6 fixture in a different shape maps cleanly |
| Provenance beside events | Pinned event shape/fixture untouched | contracts | Fields on the envelope (needs schema bump) | Parallel lookup | Contract test unchanged |
| Ingest assigns sequence | Real sources lack contiguous sequence | new pure module | Source sequence; relax reducer | New logic to test | Shuffle/dup tests |
| Independent sim wire + emitter | Adapter does real translation | `sources/simulation` | Envelope only; ERP tables | Extra schema to maintain | Round-trip equality; import-boundary test |
| zod at the boundary | Types and runtime validation come from one definition | `sources` | Hand-written guards | One dependency | Malformed-input tests |
| Narrow `OperationalView` | Removes UI->controller/engine coupling | app/simulation seam | Full 3-interface hierarchy | Refactor of 4 UI files | Import-boundary test; swapping a stub view in tests |
| History queries as types only | Avoids premature abstraction | docs | Build now | Deferred work | Revisit at first real DB/API source |

**Abstraction-is-real test:** M6 passes with the simulation module absent from the bundle graph, and M4/M5 show zero
behavior change. If the second adapter forces edits in `analytics/`, `ui/` or `graphics/`, the boundary is cosmetic.

## 7. Decisions to confirm before implementation

1. **zod (recommended) vs hand-written validators.** One new dependency, scoped to `src/sources`. CLAUDE.md says no new framework without need; I argue the single-definition benefit is the need. Your call.
2. **Which source is default in the app** after M6 (simulation, with fixtures behind a query param/env flag?). Recommend simulation default.
3. **Shift calendar** is a hardcoded constant and not master data. A real source will bring its own calendars. Do we move it to `MasterData` in this effort (a schema bump) or defer? Recommend defer, but list it as the first blocker for a real source.
4. **Inferred events from snapshot diffs**: build the `origin:"inferred"` path now, or only reserve the field? Recommend reserve the field, defer the diffing.
5. **Domain-purity leaks** (`masterData.ts` -> layout, `selectors.ts` -> graphics type, generator in the barrel): fix inside this effort or separately? Recommend a separate small PR after M5.

## 8. Risks, failure modes, testing

1. **Reducer is not atomic in place** (`state.ts`, `replay.ts:72`): a rejected event can corrupt live state. Ingest must pre-check on a clone or quarantine before the live replay; M7 hardens this.
2. **Strict `*_CREATED` payloads** (routing-match, BOM-exact reservations): a sparse ERP cannot satisfy them. The adapter must synthesise operations/reservations from master data, which can hide source errors. Mitigation: emit a `warning` issue and tag `origin:"inferred"`.
3. **Cosmetic boundary**: the emitter/adapter could degenerate to identity. Mitigation: the wire schema differs in names/units/status codes and the round-trip test must exercise conversions.
4. **Backward seek is O(n)** in the browser for large real histories. Out of scope for M0-M6; it motivates the deferred `HistoryQuery`.
5. **Two clocks** (`controller.currentTime` vs `state.asOf`) can disagree by hours at high speed; M5 makes the view's `now` the single source.
6. **Type-safety gap**: `src/ui`, `graphics`, `simulation`, `analytics` are checked only by the non-strict app config. New `src/sources` should be placed under the strict config.
7. **Contract drift**: any change to canonical shapes needs the fixture update, `SCHEMA_VERSION` bump and migration note (CLAUDE.md).

**Testing strategy:** (a) wire round-trip equality (M2); (b) validator negative tests (M1); (c) ingest property tests: idempotence, order-independence, late handling (M3); (d) golden-hash tests: generator hash and fixture hash unchanged; (e) before/after KPI parity at fixed seek points (M4, M5); (f) import-boundary tests (M4, M5); (g) second-source run of analytics and `validateDataset` (M6).

## Verification (end-to-end, after each milestone)
```bash
npm test && npm run typecheck && npm run typecheck:app && npm run validate:data && npm run build
npm run dev   # manual: compare KPI cards at 3 seek points against the pre-change baseline
```

## Critical files
`src/simulation/loadSimulationData.ts`, `src/simulation/SimulationController.ts`, `src/simulation/reportingSnapshot.ts`,
`src/manufacturing/{types,state,replay,events,selectors}.ts`, `src/analytics/types.ts`, `src/ui/{Dashboard,PlaybackToolbar}.ts`,
`src/ui/explorer/OperationsExplorer.ts`, `src/graphics/SceneManager.ts`, `src/main.ts`, `scripts/{generate,validate}.ts`,
`tests/contract.test.ts`; new: `src/sources/**`, `tests/helpers/snapshot.ts`, `tests/fixtures/sources/**`.

## Reporting on completion (per CLAUDE.md)
What changed, contracts changed (none through M6 by design), migration notes, tests run, what remains hypothetical (HistoryQuery, inferred events, live transport).
