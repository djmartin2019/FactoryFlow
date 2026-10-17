# Source independence for FactoryFlow: integration boundary plan (revision 3)

Status: **proposal for approval. No application code, tests, fixtures or dependencies have been changed.**
This document is self-contained and supersedes `SOURCE_INTEGRATION_PLAN.md` (rev 1) and
`SOURCE_INTEGRATION_PLAN_REV2.md` (rev 2), both left untouched for history.

## Contents

1. Context and decisions already made
2. Revision 3 Decision Summary
3. Revision history and architectural findings
4. Principles
5. Current architecture assessment
6. Dependency and data-flow diagram
7. Responsibilities, contracts and policies (7.1 responsibilities, 7.2 time, 7.3 identity, 7.4 ingestion and conflicts,
   7.5 ordering, 7.6 reducer atomicity, 7.7 observations versus events, 7.8 capabilities and provenance,
   7.9 integrity versus plan conformance, 7.10 OperationalView, 7.11 simulation wire schema)
8. Incremental plan with acceptance criteria (M0 to M7)
9. Messy-data outcome matrix
10. What M6 proves and what it does not
11. Architectural decisions and deferred capabilities
12. Design rationale
13. Decisions requiring approval
14. Risks, failure modes, testing strategy and performance
15. Verification, critical files, reporting
- Appendix A: reducer invariant classification
- Appendix B: evidence from the current event log

## 1. Context and decisions already made

FactoryFlow's generator, reducer, loader, analytics and UI share one set of types (`src/manufacturing/types.ts`). The
app loads JSON with an `as` cast (`src/simulation/loadSimulationData.ts:13-15`), so nothing marks where "a source" ends
and "the product" begins. The goal: replace the simulation with another source (JSON fixtures first, later ERP, MES, DB
or API) without changing domain logic, analytics or presentation. Source independence must mean more than swapping one
JSON format for another. Real systems are incomplete, late, inconsistent and sometimes contradictory, and FactoryFlow
must not fabricate manufacturing history to hide that. The long-term goal is to preserve **actual operational facts**,
even when they differ from the manufacturing plan.

Decisions agreed earlier and retained:
1. Existing domain types stay the canonical vocabulary. Provenance sits beside events, not inside the pinned envelope.
2. An ingestion stage, not the source, assigns the canonical `sequence`. The reducer stays strict.
3. The simulation emits a modest, independent wire schema (own names, units, status codes) that an adapter maps back.
4. The first read-model port is narrow and explicitly transitional; richer query interfaces are documented, not built.
5. The `CanonicalInput` union (business event, snapshot observation, CDC change); observations never become fictional events.
6. Reducer-level atomicity by validate-before-mutate (not clone-per-event); M3 is split into M3a and M3b.

## 2. Revision 3 Decision Summary

| Issue | Verdict | Resolution in rev 3 | Where | Milestones |
| --- | --- | --- | --- | --- |
| **A.** Determinism vs "first accepted wins" | Valid: a real contradiction | Remove first-wins. Ingest produces a **candidate log** that is a pure function of the record set, persisted resolutions and hints, identity map and master/initial state. Conflicting duplicates **fail closed** (no member accepted) unless the source declares comparable versions (higher version supersedes) or a persisted **resolution** picks one. The **published log** is append-only; any change to already-published history is a **pending change** applied only by explicit `reproject`. Order independence is guaranteed for the candidate; stability for the published log; both cannot hold for the served log at all times (counterexample in §7.4) | §7.4 | M1, M3b |
| **B.** Deterministic vs causal ordering | Valid, and the repository refutes rev 2's acceptance criterion: 95.7% of simulated events share a timestamp and 42 event-type pairs occur in both orders within ties, so a global `lifecycleRank` cannot reproduce the simulation's own order | Four notions separated. Order = `occurredAt`, then **source-declared ordinals** (stream-scoped, semantics declared). Unordered ties between **independent** records get a documented arbitrary-but-fixed order; unordered ties between **interacting** records are **quarantined as `AMBIGUOUS_ORDER`** unless a persisted order hint or adapter-derived (labelled) ordinals exist. Reducer dry-run is the validity oracle. No global rank, no dependency graph | §7.5 | M1, M3b |
| **C.** M6 conflates event-capable and observation-only sources | Valid | M6a (event-capable MES-like fixture, full replay, analytics, boot without simulation, hand-authored expected KPIs) and M6b (snapshot-only ERP-like fixture, retained observations, zero events, no analytics claim) with separate fixtures and test paths. Observation-only sources are refused at boot with an explanation instead of rendering zeros | §8 M6, §10 | M4, M6 |
| **D.** Atomicity should be structural | Valid; partly addressed by rev 2 (hoisting) but dependent on discipline | `prepareEvent(DeepReadonly<state>, event) -> Commit` inside the existing single `switch`; the dispatcher alone commits and advances `lastSequence`/`asOf`. Mutation inside prepare becomes a **compile error**; a runtime **deep-freeze test** and a **differential test against a frozen copy of the current reducer** back it. Commit failure is a distinct, tainting error | §7.6 | M0, M3a |
| **F.** Plan conformance vs integrity | Valid; rev 2's two classes are insufficient | Five-way taxonomy (`LOG`, `REFERENCE`, `INTEGRITY`, `PLAN_CONFORMANCE`, `AMBIGUOUS`), documented in M1, coded in M7. Strict reducer unchanged. Plan-conformance rejections stay in the ledger with class and provenance so a future recording path can use them. Relaxed profile is **not** built; pilot evidence criteria defined | §7.9, Appendix A | M1, M7 |

## 3. Revision history and architectural findings

| Area | Rev 1 | Rev 2 | Rev 3 |
| --- | --- | --- | --- |
| Reducer atomicity | M7 | M3a, hoist `req`s, `applyMoves` | M3a with structural prepare/commit, freeze test, differential test; M0 harness extended |
| Ingest | Stamp permanent sequences | Ledger set function, first-wins duplicates, `latePolicy` | Candidate/published/pending model; fail-closed conflicts; persisted resolutions |
| Ordering | `(occurredAt, sourceId, ordinal ?? lifecycleRank, id)` | Same | Ordinals with declared semantics; ambiguity quarantine; no global rank |
| Adapter output | Always `FactoryEvent` | `CanonicalInput` union | Unchanged |
| M6 | Second adapter | + messy fixtures | M6a event-capable and M6b observation-only |
| Rule classes | none | `INTEGRITY`, `PLAN_CONFORMANCE` in M7 | Five classes, documented in M1 (Appendix A) |
| Identity, time, OperationalView | n/a / basic | Full policies | Retained; minor additions (`streamId`, `sourceVersion`, content key) |

**Findings that drive revision 3** (verified against the repository; line numbers refer to `src/manufacturing/state.ts`):
- **Atomicity defect is real.** By code reading, 11 of the 22 event types can mutate and then throw (`MATERIAL_RECEIVED`,
  `PRODUCTION_ORDER_RELEASED`, `MATERIAL_CONSUMED`, both cancellations, `OPERATION_STARTED`, `OPERATION_COMPLETED`,
  `REWORK_REQUESTED`, `FINISHED_GOODS_RECEIVED`, `SHIPMENT_DISPATCHED`, `MACHINE_FAILED`). The existing rejection tests
  call the cloning wrapper `applyEvent` and assert the input is unchanged (`tests/manufacturing.test.ts:213-215`), which
  is trivially true. M0 proves or corrects this list.
- **Clone-per-event is infeasible.** `structuredClone` of the final state (5,098 transactions, 223 orders, 1,088
  operations, 3.6 MB as JSON) measured about 26 ms, so per-event cloning over 4,651 events is about 60 s against about
  30 ms today.
- **Ties are the norm, not an edge case** (Appendix B). 1,145 of 1,346 distinct timestamps hold multiple events; 4,450 of
  4,651 events (95.7%) are in a tie group, up to 20 events; 42 event-type pairs occur in both orders within ties.
  The simulation is only replayable because `sequence` is an authoritative ordinal.
- **Interaction in ties is common.** 864 tie groups contain events sharing a `productionOrderId`; 853 share a
  `workstationId`; only 102 are fully independent. Any source that has coarse timestamps and no ordinals will produce
  mostly ambiguous ties.
- **The reducer encodes simulation plan rules** (Appendix A), for example setup minutes must equal the changeover table
  (`:565`), `quantityProduced === order.quantity` (`:625`), consumption must equal reservation and BOM (`:505`).
- **The simulation module is separable.** Nothing in `src/` imports `generator.ts`, `rng.ts` or the `manufacturing`
  barrel; the one exception is `src/analytics/workOrders.ts:7`, which imports `WORK_CENTER_NAMES` from `masterData.ts`
  (the generator-side constant, which also imports the 3D layout). Fixing it (M5) makes "boot without the simulation
  module" testable.
- **Other source-specific leaks:** hard-coded shift calendar (`calendar.ts`), `masterData.ts:1` imports 3D layout,
  `selectors.ts:5` imports a graphics type, `fnv1a` is 32-bit, `docs/STATUS.md` says schema `1.0.0` in one row (code is `1.3.0`).

## 4. Principles

- **P1** Missing information is not zero. Unknown, unsupported and known-zero are distinct.
- **P2** An observed state is not proof of the business events that produced it.
- **P3** The strict event-sourced core is preserved. Weaker sources get a different path, not a weaker reducer.
- **P4** A rejected external event must never partially mutate accepted operational state (invariant I1, §7.6).
- **P5** The simulation passes through the same boundary as any source; no bypass.
- **P6** The **candidate log** is a deterministic function of the *set* of source records, persisted resolutions and
  hints, the identity map, and the initial/master state. Arrival order, batching, wall clock and `ingestedAt` do not
  affect it. The **published log** is append-only; history changes only by explicit reprojection (§7.4).
- **P7** Every accepted, quarantined or pending record is attributable to a source record and to adapter, schema and
  identity-map versions.
- **P8** Ambiguity is reported, not resolved by guessing. Where order, identity or version cannot be established from
  the source, the record is quarantined with an explicit reason.
- **P9** Actual operational facts are preserved even when they deviate from plan. Until a recording path exists, deviations
  are quarantined with their class and retained, never discarded or "corrected".
- **P10** No database, broker, transport or framework is introduced for hypothetical integrations.

## 5. Current architecture assessment

**Preserve**
- `FactoryReplay` (`src/manufacturing/replay.ts`): pure, no timers; header already calls it an integration point.
- Strict reducer and `rules.ts` (shared by generator and reducer); contract fixture and hashes (`tests/fixtures/canonical`, `6ed76381`).
- Analytics input `ReportingSnapshot {asOfMs, startMs, master, state, events}` (`src/analytics/types.ts`).
- `validateDataset` (`validation.ts`) as an oracle for any event stream; `replayWithGuard`, `buildEvent`, `entityRefsFor`, `eventIdFor`.
- The single clock `SimulationController`; the seeded generator and `Rng`.

**Gaps**
| Finding | Where |
| --- | --- |
| Loader casts JSON; no shape or version check; `SCHEMA_VERSION` never read at runtime | `loadSimulationData.ts:13-15` |
| Generator output *is* the internal type; no wire format | `generator.ts` `emit()` -> `buildEvent` |
| UI/graphics hold the live controller and reach into `engine.master` / `engine.onEvent` | `Dashboard.ts`, `OperationsExplorer.ts`, `SceneManager.ts:5` |
| Only seam into analytics is `reportingSnapshot(sim)`; its `state` is the live object | `src/simulation/reportingSnapshot.ts` |
| Two "now"s: `controller.currentTime` vs `state.asOf` | `selectors.ts:89`, `WipBuffers.ts` |
| `SimulationController.update` lets a replay throw reach the render loop; no fault state | `SimulationController.ts:46-56` |
| Reducer can mutate then throw; rejections untyped | `state.ts`, `replay.ts:72` |
| No dedupe, reorder, quarantine or late handling; strict `sequence === lastSequence+1` | `state.ts:248-249` |
| No provenance on events | `EventEnvelope`, `types.ts:646` |
| History exists only by replay in the browser | `replay.ts:96` |
| Source-specific leaks (see §3) | `analytics/workOrders.ts:7`, `calendar.ts`, `masterData.ts:1`, `selectors.ts:5` |
| `ReportingSnapshot` hand-built in 5 test files | `tests/*` |

## 6. Dependency and data-flow diagram

```
 sources                         integration boundary                                core                              presentation
 ┌──────────────────┐  raw    ┌────────────────────────────┐ CanonicalInput  ┌─────────────────────────────────┐
 │ simulation emitter│ ─────▶ │ SourceAdapter<TWire>        │ ─────────────▶ │ Ingest (pure)                    │
 │ (sim wire schema) │        │  validate → normalize →     │ business_event │  ledger: records+resolutions     │
 ├──────────────────┤        │  resolve identity → map     │ snapshot_obs.  │  conflicts · versions · ordering │
 │ MES-like fixture  │ ─────▶ │  provenance · MappingIssue[]│ cdc_change     │  dry-run on shadow state         │
 ├──────────────────┤        └──────────────┬─────────────┘                │  → CANDIDATE log                 │
 │ ERP-like snapshot │ ─────▶                │ IdentityResolver             └───────┬───────────┬──────────────┘
 ├──────────────────┤                        ▼ (versioned identity map)           │ publish   │ snapshot/CDC
 │ future ERP/MES/DB │                                                              ▼           ▼ (retained, not projected)
 └──────────────────┘            QuarantineRecord[] / PendingChange[] / MappingIssue[]   PUBLISHED log (append-only)
                                                                                    │                 ┌──────────────┐
                                                     FactoryEvent                   ▼                 │ ObservedState │
                                                ┌─────────────────────────────────────────────┐      │ (DEFERRED)    │
                                                │ FactoryReplay + strict reducer               │      └──────────────┘
                                                │ prepareEvent(readonly) → Commit (state.ts)   │
                                                └──────────────────────┬──────────────────────┘
   SimulationController (clock; replay-capable sources only) ─────────▶│ FactoryState
                                                                        ▼
                                    OperationalView (transitional port) ──▶ analytics ──▶ ui / graphics
```

**Dependency direction** (arrow = "may import"):
`ui, graphics -> OperationalView -> analytics -> manufacturing (contracts + reducer)`;
`sources/* (adapters, identity, ingest) -> manufacturing types`; `sources/simulation/* -> sources/*`;
`scripts -> sources/simulation`. Nothing in `manufacturing`, `analytics`, `ui` or `graphics` imports an adapter, a wire
schema, the simulation emitter, `generator.ts`, `rng.ts` or generator-side `masterData.ts` helpers. The clock lives behind the
port and only for replay-capable sources.

## 7. Responsibilities, contracts and policies

### 7.1 Responsibilities

| Component | Does | Does **not** |
| --- | --- | --- |
| **Source adapter** (`src/sources/**`) | Parse and runtime-validate wire data; normalize timestamps, units, statuses; resolve identity; map to `CanonicalInput`; attach provenance, ordinal and version metadata; report `MappingIssue`s | Apply business rules; call the reducer; infer events from state; invent defaults for missing fields; choose between conflicting records |
| **Identity resolver** | Map `SourceKey` -> canonical id; report unresolved/conflicting keys | Fuzzy-match; merge entities on its own |
| **Ingest** (pure) | Group by idempotency key, apply versions and resolutions, order, dry-run on a shadow state, quarantine, stamp `sequence`/`id` via `buildEvent`, produce the candidate log; `publish`/`reproject` | Hold a clock; touch the UI; run the live replay; guess order or winners |
| **Interpretation policy** (DEFERRED) | Decide whether observations *directly* support a domain event | Exist by default |
| **Reducer / `FactoryReplay`** | Enforce domain invariants; atomic on reject (§7.6); replay | Know about sources, provenance, quarantine or classes (classes arrive in M7 as codes only) |
| **OperationalView** | Give UI/graphics state, master, `now`, subscription, `reportingSnapshot()`, `dataOrigin`, ingest counts | Be the long-term contract (§7.10) |

### 7.2 Time semantics

| # | Concept | Field | Notes |
| --- | --- | --- | --- |
| 1 | Source ordering/versioning | `sourceOrdinal?`, `streamId`, `sourceVersion?` | Ordinal: position in a source stream with declared semantics (§7.5). Version: source-declared revision of one record (§7.4) |
| 2 | Business occurrence time | `occurredAt` (`FactoryEvent.timestamp`) | UTC instant normalized to ms. `null` if the source cannot say |
| 3 | Observation/capture time | `observedAt` | When the source recorded or extracted it. Never substituted silently for `occurredAt` |
| 4 | Ingestion/acceptance time | `ingestedAt` | **Injected** via `IngestContext` (no `Date.now()` in the core). Never part of ordering, hashes or equality |
| 5 | Canonical replay order | `sequence` / `EVT-` id | Position in a *log revision*; revision-scoped, not a permanent identity |

`occurredAtQuality`: `reported` | `observed_proxy` | `unknown`. An adapter may use `observedAt` as `occurredAt` only if
explicitly declared for that event type, and records `observed_proxy`. Otherwise a record without `occurredAt` cannot
be placed in the event log and is retained as an observation. Timestamp precision is normalized to ms; sources declare
`timePrecision` ("ms", "second", ...) because coarse precision multiplies ties (§7.5).

### 7.3 Identity policy

- **Key.** `SourceKey = { sourceId, entityType, key, scope?: { tenantId?, siteId? } }`. Equality is over all fields, so "1042" in two systems never collides. `entityType` uses the domain's own names.
- **Canonical id.** Opaque string, charset `[A-Za-z0-9._-]` and **never containing `::`** (`inventoryKey` joins `locationId::itemId`, `state.ts:97`).
  - Simulation namespace: **passthrough** (`canonicalId = key`). Preserves hashes and the 3D coupling (location/workstation ids are scene object ids).
  - Other sources: default **derived composite** `PREFIX-<sourceId>-<escaped key>` with reversible escaping so distinct keys cannot collide.
  - Cross-system equivalence only by explicit **crosswalk** entry (canonical id with aliases, e.g. ERP `1042` and MES `WO-001042`). Crosswalk wins over derivation.
- **Resolution result:** `resolved | unresolved | conflict(candidates)`.
- **Failures.** `unresolved` -> `UNRESOLVED_IDENTITY` (recoverable when the map gains the entry). `conflict` (one key -> several canonical ids, or two distinct keys of the same source/type -> one canonical id without declared aliasing) -> `IDENTITY_CONFLICT`, all affected records fail closed. No fuzzy matching, no auto-merge.
- **Reproducibility.** The identity map is a versioned, content-identified input artifact. Adapters are pure functions of `(raw, identityMap, context)`. Provenance records `identityMapVersion`, `adapterVersion`, `schemaVersion` and a `contentKey` (§7.4). Newly derived ids are returned as `derivedMappings` for audit.
- **Not built:** survivorship rules, MDM UI, probabilistic matching, tenant enforcement (the `scope` fields exist so key shape never changes later).
- **Deferred coupling:** location/workstation canonical ids are 3D scene ids today. A real source needs a `SceneObjectBinding` (design §5, §6.5); unbound objects must simply not be drawn.

### 7.4 Ingestion: ledger, conflicts, candidate, published, pending

**Why rev 2 was inconsistent.** P6 said the output depends only on the set of records, yet duplicates with the same
`(sourceId, sourceEventId)` and different content were resolved by "first accepted wins". Two arrival orders select
different winners, so the output depended on arrival order.

**Model**
- **Ledger** = append-only data: all records ever received (normalized content retained), plus persisted
  **resolutions** and **order hints** (file-based, versioned artifacts like the identity map; no UI). Nothing in the
  ledger depends on arrival order except `ingestedAt` metadata, which is excluded from every comparison.
- **Candidate** = `ingest(ledger.records, ledger.resolutions, ctx)`: a pure function. It is "the log we would publish
  if we started from scratch with everything we know".
- **Published log** = the log consumers actually replay. It is **append-only** per revision.
- `publish(published, candidate)`: if `published` is a prefix of `candidate.accepted` (compared by
  `(sourceId, sourceEventId, contentKey)` per position) the candidate is adopted. Otherwise the published log is left
  unchanged and the differences are returned as **pending changes**.
- `reproject(published, candidate)`: explicit operation that adopts the candidate even when it rewrites history;
  `revision` increments, `rewrite.fromSequence` reports the first changed position, and `EVT-` ids after it change.
  Consumers treat it like the existing `epoch` bump.

```ts
// illustrative, finalized in M1 / M3b
interface Ledger { records: LedgerRecord[]; resolutions: ConflictResolution[]; hints: OrderHint[] }
interface IngestContext { master: MasterData; initial: FactoryState; identityMap: IdentityMap }   // no clock
interface Candidate { accepted: AcceptedEvent[]; quarantined: QuarantineRecord[]; unprojected: UnprojectedRecord[]; issues: MappingIssue[] }
interface AcceptedEvent { event: FactoryEvent; provenance: InputProvenance; orderQuality: OrderQuality }
type OrderQuality = "time_only" | "source_ordinal" | "adapter_derived" | "hint" | "arbitrary_independent";
function ingest(records: LedgerRecord[], resolutions: ConflictResolution[], hints: OrderHint[], ctx: IngestContext): Candidate;
function publish(published: PublishedLog, candidate: Candidate): { published: PublishedLog; pending: PendingChange[] };
function reproject(published: PublishedLog, candidate: Candidate): { published: PublishedLog; rewrite: { fromSequence: number } | null };
type PendingChange = { kind: "late" | "correction" | "retraction" | "order_change"; refs: EventRef[]; fromSequence: number };
```

**Idempotency groups and conflicts.** Records are grouped by `(sourceId, sourceEventId)`. Equality of two records is
**exact equality of canonical JSON of the adapter's normalized content** (`contentKey` is a display/audit digest only,
so a hash collision can never hide a conflict; cosmetic differences such as key order or timestamp formatting are removed
by normalization before comparison).

| Group content | Candidate outcome | Code |
| --- | --- | --- |
| All members equal | One record; others ignored | `DUPLICATE_IGNORED` (info) |
| Differing content, source declares `versioning` and every member has a comparable `sourceVersion`, one maximum | Highest version accepted; lower versions kept in ledger as superseded | `SUPERSEDED` (info) |
| Differing content, equal maximum versions | **No member accepted** | `DUPLICATE_CONFLICT` |
| Differing content, no/partial versioning | **No member accepted** (fail closed) | `DUPLICATE_CONFLICT` |
| A persisted `ConflictResolution` names a member's content (or `"none"`) | The chosen member is treated as the sole member | resolution recorded in provenance |

- **Legitimate correction vs accidental id reuse.** Cannot be distinguished from content. Only a source-declared version
  (capability `versioning`) marks a correction. Everything else fails closed and needs a human-supplied resolution. The
  conflict report lists the differing field paths to help that decision; it makes no decision itself.
- **Records already published.** If a conflict, correction or resolution changes the candidate relative to the
  published log, the candidate and published logs diverge: the change appears as a `PendingChange`
  (`correction`, `retraction`). The published log continues to serve the earlier accepted record until `reproject`.
  See open decision D9 for the alternative (retract automatically).
- **Does resolution trigger reprojection?** Only if it changes already-published history. A resolution that picks the
  already-published member closes the conflict with no rewrite. One that picks another member or `"none"` produces a
  pending change; adopting it is always an explicit `reproject`.
- **Late records** (valid, but sorting before the published watermark) are accepted by the *candidate* and appear as
  `PendingChange { kind: "late" }`. This is the recoverable "held" state requested for late data; the published log is
  not rewritten and nothing is lost. `reproject` adopts them.

**What can and cannot be guaranteed.**
- **G1 (candidate determinism, tested):** the candidate depends only on the record set, resolutions, hints, identity
  map, master and initial state. Any permutation of arrival, any partition into batches, and any `ingestedAt` yields a
  deep-equal candidate.
- **G2 (published prefix stability, by construction):** the published log changes only by appending, except through an
  explicit `reproject`.
- **G3 (convergence, tested):** after `reproject`, the published log equals the candidate regardless of how records arrived.
- **Not guaranteed:** that the published log is arrival-order independent *before* `reproject`. Counterexample:
  batch 1 = `{A@10}`, batch 2 = `{B@5}` publishes `[A]` with `B` pending; the reverse arrival publishes `[B, A]`. Any
  design that promises append-only stability must accept this; the divergence is explicit (`pending`), bounded and
  closed by `reproject`. For single-batch sources, including the simulation, the two logs are identical.

**Property tests (M3b).** Seeded (`Rng` from `src/manufacturing/rng.ts`), over the canonical fixture converted to
inputs plus injected duplicates, conflicting duplicates, versioned corrections, late records and cross-source ties:
1. N shuffled arrival orders -> deep-equal candidates (including conflicting-duplicate groups).
2. Random partitions into sequential batches, folded through the ledger -> same candidate as one batch.
3. A conflict group has no accepted member without a resolution; with a resolution exactly the chosen one, in every order.
4. Versioned group: highest version wins in every order; equal top versions conflict in every order; mixed versioned/unversioned conflicts.
5. `ingestedAt` varied -> identical candidate.
6. `publish` on any prefix split yields a prefix of the candidate; after `reproject`, published equals candidate.
7. Dependents of a conflicted event are quarantined as a cascade and recovered when the conflict is resolved.
8. Idempotence: re-ingesting the same records changes nothing.

**Documented, not built:** live append into a running `SimulationController`; correction events as first-class
inputs beyond `sourceVersion`; persisted ledgers; checkpoints; any streaming infrastructure.

### 7.5 Event ordering policy

Four notions, kept apart:
1. **Deterministic ordering**: a total order that makes the output reproducible. It carries no causal claim.
2. **Source-authoritative ordering**: an order the source itself asserts (ordinals), scoped to a stream.
3. **Causal dependency**: event B's preconditions require the effect of event A. Domain knowledge; the reducer is the only
   complete authority on it.
4. **Reducer-compatible replay order**: a linearization the reducer accepts (contiguous sequence, non-decreasing
   timestamps, preconditions satisfied). Established only by the dry run in §7.4; no policy can guarantee it a priori.

**Is a global `lifecycleRank` sufficient?** No, for three reasons.
- *Empirically false on our own data* (Appendix B): 42 event-type pairs occur in both orders within simulated ties
  (e.g. `OPERATION_COMPLETED` before `OPERATION_STARTED` 829 times, after it 23 times), so no total order on types
  reproduces the simulation. Rev 2's acceptance criterion that `(occurredAt, lifecycleRank)` reproduces the original
  sequence would fail.
- *Conceptually insufficient*: causality is per interacting entity (same production order, same workstation, same
  inventory key), not per event type.
- *Duplicates the reducer's preconditions* in a second place that can silently drift.
A restricted, per-entity rank looks plausible in-sample (all 12 same-order type multisets in the current log occur in a
single order) but would still miss station and inventory interactions. It is therefore **not part of core ingest**.

**Policy (M3b)**
- **O1 Primary key.** `occurredAt` (ms, UTC). Records without it are not eligible for the event log (retained as observations).
- **O2 Authoritative ordinals.** Sources declare `ordinal` semantics per stream:
  - `causal`: the ordinal is the source's own causal/occurrence order (the simulation's `sequence`). Within a stream it is authoritative, and must agree with time order.
  - `posting`: the ordinal is posting/transaction order. It is authoritative only to break ties between records with *equal* `occurredAt` in the same stream; late posting is normal and is not an error.
  - `adapter_derived`: the adapter computed an ordinal by its own documented rule. Treated like `posting`, but every affected record carries `orderQuality: "adapter_derived"` so reports can qualify it.
  - `none`.
  Ordinals are comparable **only within one `(sourceId, streamId)`**; they are never compared across streams or sources. Global ordering is never assumed.
- **O3 Ties.** A tie group is the set of records with equal `occurredAt`. Pairs ordered by O2 keep that order. For the remaining pairs the relative order is **unknown**:
  - *Independent* (no shared primary entity among `productionOrderId`, `productionOperationId`, `workstationId`, `purchaseOrderId`, `customerOrderId`, `shipmentId`, `inspectionId`, `downtimeId`, taken from `event.entities`): order is fixed by `(sourceId, streamId, sourceEventId)`. This is arbitrary but deterministic and is labelled `arbitrary_independent`; it makes no causal claim.
  - *Interacting* (share at least one primary entity): **ambiguous**. All members of the interacting component that lack an authoritative relative order are quarantined as `AMBIGUOUS_ORDER`, listing the members. Recovery: a source ordinal, adapter-derived ordinals, or a persisted `OrderHint` (explicit total order of the listed members, with reason and author).
  - Inventory competition (two independent-looking events drawing on the same material and location) is *not* treated as interaction; the dry run decides. If it rejects one member, the rejection is reported with `orderQuality: arbitrary_independent` in the issue so the arbitrariness is visible.
- **O4 Contradictions.** For a `causal` stream, a record whose `occurredAt` is earlier than that of a lower-ordinal record in the same stream is an inversion: quarantined `SOURCE_ORDER_CONTRADICTION` (with the pair), cascade applies. `posting` streams never raise this; their out-of-time-order records are late data (§7.4).
- **O5 Causal validity by dry run only.** Each event is applied to the shadow state in order with the atomic reducer. Failure -> quarantine (`INVARIANT_VIOLATION`; typed in M7). There is no permutation search and no dependency graph.
- **O6 Reference to an entity created later.** A narrow, table-driven diagnostic (creation event type per entity ref: production order, purchase order, customer order, shipment, inspection, downtime, and operations via order creation or rework request) distinguishes an event whose referenced entity is created at a *later* `occurredAt` (`REFERENCES_FUTURE_ENTITY`, likely clock skew or a wrong timestamp) from one whose entity is simply absent (`INVARIANT_VIOLATION`/missing dependency, recoverable when it arrives).
- **O7 Reducer unchanged.** The accepted log is contiguous (`sequence`) and timestamp-monotone by construction; the reducer's checks remain as the last line of defense.

**Limitations (stated, not hidden).**
- Sources with coarse timestamps and no ordinals will see many `AMBIGUOUS_ORDER` quarantines; in the current simulation
  96% of events are in ties, and about three quarters share a primary entity with a tied peer. That is the correct
  fail-closed behavior, and the practical consequence is that **adapters for such sources must supply ordinals**.
- Arbitrary order for independent records is a convention, not knowledge.
- A shared-entity test can over-flag (two events touching the same workstation that happen to commute). That costs a
  hint, not correctness.
- An optional adapter-side helper that derives ordinals from per-entity lifecycle rules is **deferred**; build it
  only if a real adapter needs it, and only after an experiment shows it reproduces the ordinal-stripped simulation log
  for every tie group (otherwise do not ship it).

**Acceptance tests (M3b).** (a) Simulation: every record has a `causal` ordinal, the candidate equals the original
events, ids and hash, for original and shuffled arrival. (b) Same-timestamp dependent events in one stream with causal
ordinals keep order (consume -> start -> operation start; complete -> next start; inspection -> complete -> receipt).
(c) Multiple operations on one work order sharing a timestamp, with ordinals -> order kept; without ordinals ->
`AMBIGUOUS_ORDER`. (d) Cross-source tie, independent -> fixed `arbitrary_independent` order, invariant under arrival
order and under renaming of unrelated records. (e) Cross-source tie, interacting (an ERP-like release and an MES-like
consume at the same instant) -> both quarantined `AMBIGUOUS_ORDER`, nothing accepted for them; adding an `OrderHint`
accepts both in the hinted order. (f) Two streams each with ordinals, interleaving unknown -> ordinals never compared
across streams. (g) `causal` inversion -> `SOURCE_ORDER_CONTRADICTION`; `posting` inversion -> late (pending), not a
contradiction. (h) Event referencing an entity created later -> `REFERENCES_FUTURE_ENTITY`. (i) A characterization test
(M0) fails if a global type rank would reproduce the simulation's tie order (it must not).

### 7.6 Reducer atomicity as a structural property

**Finding (by code reading; M0 proves it).** `applyEventInPlace` validates and mutates interleaved. `lastSequence`/`asOf`
advance only at the end (`:785-786`), so after a throw the state looks consistent with its sequence marker while records
are half-changed. `FactoryReplay.step` (`replay.ts:72`) leaves the cursor unchanged but the state mutated, and
`replayWithGuard` returns that state.

Cases that can mutate, then throw:
| Event type | Mutation before a possible throw |
| --- | --- |
| `MATERIAL_RECEIVED` (297-321) | per-line PO `receivedQuantity` and inventory moves, then a later line's check fails |
| `PRODUCTION_ORDER_RELEASED` (408-415) | earlier reservations applied, a later material is short (realistic: shortage) |
| `MATERIAL_CONSUMED` (502-512) | earlier materials consumed, a later one fails |
| `PRODUCTION_ORDER_CANCELLED` (429-434), `CUSTOMER_ORDER_CANCELLED` (360-369) | loops of inventory moves |
| `OPERATION_STARTED` (573-576) | first equipment unit marked held, next unit not free |
| `OPERATION_COMPLETED` (603-613) | operation completed, station idled, equipment released, **then** `reworkPendingQuantity >= 0` checked |
| `REWORK_REQUESTED` (666-671) | first operation inserted, second fails validation |
| `FINISHED_GOODS_RECEIVED` (686-694) | inventory moved and counters changed, **then** `wipQuantity === 0` checked |
| `SHIPMENT_DISPATCHED` (728-739) | earlier lines shipped, later line fails |
| `MACHINE_FAILED` (751-757) | downtime inserted before the operation lookup can fail |

Malformed payloads can additionally raise `TypeError` mid-loop, bypassing `req`.

**Options considered**
| Option | Cost | Verdict |
| --- | --- | --- |
| Clone-and-apply per event (`applyEvent`) | ≈ 26 ms per clone at final size; ≈ 60 s per full replay vs ≈ 30 ms today | Rejected for replay/ingest; kept as test oracle |
| Hoist `req`s by convention (rev 2) | O(1) | Works but relies on reviewer discipline for all future handlers |
| Undo journal / proxy | Intercepts every write; hot-path overhead | Rejected |
| Snapshot-restore of touched entities | Duplicates reducer knowledge; omissions are silent | Rejected |
| **Prepare/commit split inside the existing `switch`, with a read-only prepare** | O(1); one closure per event | **Recommended** |

**Design (smallest structure that makes violations hard)**
```ts
type Commit = (state: FactoryState) => void;                      // the only place state is written
type DeepReadonly<T> = /* type-only helper, zero runtime cost */;
function prepareEvent(state: DeepReadonly<FactoryState>, event: FactoryEvent, master: MasterData): Commit;  // validates, never writes
export function applyEventInPlace(state: FactoryState, event: FactoryEvent, master: MasterData): void {
  const commit = prepareEvent(state, event, master);              // may throw: state untouched
  try { commit(state); } catch (e) { throw new CommitFailure(e); } // must not throw: if it does, state is tainted
  state.lastSequence = event.sequence; state.asOf = event.timestamp;   // advanced in one place, never forgotten
}
```
- **One switch, not 22 files.** Each existing `case` keeps its `req` lines (inside `prepareEvent`) and wraps its mutation
  lines in a returned closure. Long cases (e.g. `OPERATION_STARTED`) may extract a named `prepareX`. The mapped
  `never` default is kept, so adding an event type without a branch is still a compile error.
- **No write in prepare.** `state` is `DeepReadonly<FactoryState>` in `prepareEvent`; assigning, `push`ing or calling
  `move()` (which takes mutable state) is a type error under the strict config that already covers `src/manufacturing`.
- **Commit re-looks-up by id** from the mutable state; closures capture only ids and plain values computed in prepare
  (never payload objects: `structuredClone` them in prepare, as the code already does, to avoid aliasing the event log).
- **Inventory.** `move()` stays the only inventory writer, split into a pure `planMoves(state: DeepReadonly, Movement[])`
  and a non-failing `commitMoves(state, plan, event)`. `planMoves` simulates the movements **sequentially** over a local
  overlay map keyed by `inventoryKey` and enforces `0 <= reserved <= onHand`, integer deltas, after each movement exactly
  as today, so accumulated effects on the same key (two lines drawing the same stock, a transfer out then in) behave
  identically. Transaction ids (`TXN-n`) are assigned at commit.
- **Intra-event cumulative effects must be modelled in prepare, not through state.** Today several handlers rely on
  earlier loop iterations having mutated state: shipment lines on the same order line (`:731-738`), duplicate operation
  ids within one event (`:390`, `:668`), receipt lines against one PO (unique-line `seen` set already protects this),
  duplicate material entries in a consumption. Each is converted to a local `Map`/`Set` in prepare so accept/reject
  decisions stay identical. These are the highest-risk spots of the refactor and each gets a dedicated corpus case.
- **Cross-entity invariants** (order status + station state + equipment + changeover history in `OPERATION_STARTED`;
  inspection arithmetic; FG receipt closing WIP) are all computed from read-only state before the closure is returned.
  Derived post-state checks (`wipQuantity - quantity === 0`) are computed arithmetically in prepare.

**Unexpected runtime errors**
- *In prepare* (including `TypeError` from malformed payloads): state is untouched by construction, so the failure is
  clean. Ingest classifies non-`InvariantViolation` prepare failures as `INTERNAL_ERROR` quarantine.
- *In commit* (a bug): `CommitFailure`. The state is **tainted**. `FactoryReplay` enters a `faulted` state and refuses
  to advance until `reset()`; `SimulationController` catches it, pauses and exposes the fault instead of crashing the
  render loop; ingest's shadow state is rebuilt from the accepted log (affordable: full replay ≈ 30 ms).

**What is guaranteed by what**
| Guarantee | Mechanism | Strength |
| --- | --- | --- |
| Prepare cannot write state via typed paths | `DeepReadonly` + strict TS | Compile-time; defeated by `any`/casts |
| Prepare did not write on the exercised inputs | Deep-freeze test: run `prepareEvent` against a recursively frozen state clone; any write throws `TypeError` | Runtime, only for inputs exercised |
| Rejected events leave state deep-equal (I1) | Corpus oracle over every event type | Tested, not proven |
| Refactor preserved behavior | Differential test against a frozen copy of the pre-refactor reducer: same accept/reject decision, same message, same resulting state | Tested on dataset + corpus |
| Commit is total | Review checklist; replay of all accepted events; fault-injection test of `CommitFailure` handling | Convention + tests |
| Sequence/asOf advance exactly once | Dispatcher | Structural |
| **Not guaranteed**: casts that bypass the types; a commit bug; nondeterministic handlers; code mutating `FactoryState` outside the reducer; aliasing of payload objects; unexercised branches | | Documented residual risk |

**Review convention for new event types** (checklist in `src/manufacturing/README.md`, added in M3a): all `req`s in
prepare; commit has no `req`, throw or lookup that can fail; payload objects cloned; cumulative intra-event effects
modelled locally; corpus entries (accepting and at least one rejecting) added; `Record<EventType, ...>` coverage test passes.

**Cost.** One closure allocation per event (microseconds); `DeepReadonly` has no runtime cost. Mechanical diff of the
reducer, gated by byte-identical fixture and generator hashes (4,651 events over all 22 types) and the differential test.

### 7.7 Observations versus domain events

**Should adapters always produce `FactoryEvent`?** No. Take the ERP record
`{job_number:"WO-1042", status:"COMPLETE", quantity:12, last_modified:"2026-10-16T14:00:00Z"}`. To produce
reducer-acceptable events an adapter would have to invent `PRODUCTION_ORDER_CREATED` with routing-matching operations
(`state.ts:383-391`), exact-BOM reservations (`:407-410`), `MATERIAL_CONSUMED`, `OPERATION_STARTED/COMPLETED` with
changeover and equipment, `QUALITY_INSPECTION_COMPLETED` and `FINISHED_GOODS_RECEIVED` with an exact approved quantity.
None is known, and `last_modified` is a capture time, not a completion time.

- **Source business event** (a source states "X happened at T") -> `business_event` input carrying a canonical
  `EventDraft` (`type`, `timestamp`, `payload`: `buildEvent`'s arguments). Eligible for ingest and the reducer.
- **Snapshot observation** ("entity E looked like this at `observedAt`") -> `snapshot_observation` with per-field `Known<T>`.
- **CDC change** (row changed at commit time, with ordinal) -> `cdc_change`. Evidence of a data change, not a business event.
- **Canonical domain event** -> the *accepted, sequenced* `FactoryEvent` in the log; an output of ingest, not an input kind.
- **Derived/inferred** -> a separate, named, versioned tier produced downstream with a stated basis. **Deferred.**

**Rules**
- R1 Adapters translate vocabulary, identity, units and time. They never assert business meaning the source did not state.
- R2 Only `business_event` inputs reach the reducer. Snapshot and CDC inputs are retained in the ledger and returned as `unprojected` with info `OBSERVATION_NOT_PROJECTED`.
- R3 A future **interpretation policy** (application layer, not adapter, not reducer) may derive events from observations only per explicit, opt-in rule for a source/entity/transition, emitting events with `origin` and `basis` and `occurredAt` as a bounded interval `(prev.observedAt, this.observedAt]`, never a point.
- R4 Incomplete records feed an **ObservedState** read model (latest known per entity, `Known<T> = known | unknown | unsupported`, staleness from `observedAt`), a second projection beside `FactoryState`. Views declare required capabilities and show "unavailable" instead of zero. `FactoryState` cannot hold unknowns (required numeric fields such as `approvedQuantity`), which is why observations are not forced into it.
- R5 The strict event-sourced core and its fixtures are unchanged.

**Smallest provision now (M1):** the `CanonicalInput` union, `InputProvenance.origin`, `SourceCapabilities.inputKinds`,
ingest routing of non-business inputs to `unprojected`, a boot-time capability gate (M4/M6b), and tests that observation inputs never change the
accepted log or state. **Deferred:** `ObservedState`, interpretation policies, capability-gated KPIs.

Worked example: the ERP record above becomes one `snapshot_observation` (`status: known COMPLETE`, `quantity: known 12`,
everything else absent), retained, no event, no state change. Until `ObservedState` exists, no dashboard shows that
order. That is the correct outcome.

### 7.8 Capabilities and provenance (illustrative)
```ts
type InputKind = "business_event" | "snapshot_observation" | "cdc_change";
type Origin = "simulated_event" | "source_business_event" | "cdc_change" | "snapshot_observation" | "manual_correction"; // design §7.1
interface InputProvenance {
  sourceId: string; streamId: string; sourceEventId: string;          // idempotency key = (sourceId, sourceEventId)
  sourceOrdinal?: number | string; sourceVersion?: number | string;
  occurredAt: IsoTimestamp | null; occurredAtQuality: "reported" | "observed_proxy" | "unknown";
  observedAt: IsoTimestamp | null; ingestedAt: IsoTimestamp; origin: Origin;
  schemaVersion: string; adapterVersion: string; identityMapVersion: string;
  contentKey: string;   // digest of canonical normalized content (audit only; equality uses the canonical JSON itself)
  rawRef: string;       // pointer/hash to the raw source record
}
interface SourceCapabilities {
  inputKinds: InputKind[]; entities: Partial<Record<EntityType, "full" | "partial" | "none">>;
  ordinal: "none" | "posting" | "causal" | "adapter_derived"; versioning: "none" | "monotonic"; timePrecision: "ms" | "second" | "minute" | "day";
  liveUpdates: boolean; historyQuery: boolean;
}
interface MappingIssue { severity: "error" | "warning" | "info"; code: string; sourceRef?: SourceKey | { sourceId: string; sourceEventId: string }; path?: string; message: string }
interface QuarantineRecord { ref: { sourceId: string; sourceEventId: string }; reason: { code: QuarantineCode; message: string; class?: RuleClass; members?: EventRef[] }; recoverable: boolean; firstSeenAt: IsoTimestamp }
type QuarantineCode = "DUPLICATE_CONFLICT" | "AMBIGUOUS_ORDER" | "SOURCE_ORDER_CONTRADICTION" | "REFERENCES_FUTURE_ENTITY" | "UNPLACEABLE_TIME"
  | "UNRESOLVED_IDENTITY" | "IDENTITY_CONFLICT" | "INVARIANT_VIOLATION" /* split into typed codes in M7 */ | "INTERNAL_ERROR";
```
Quarantine is a *status*, not a verdict: records stay in the ledger and are re-evaluated on every ingest. `CLAUDE.md`
requires the demo to stay labelled synthetic; the label should derive from `origin`, not be hard-coded (M5).
`ConflictResolution` and `OrderHint` (§7.4, §7.5) are persisted artifacts with `reason` and `decidedBy`; their timestamps are metadata only.

### 7.9 Integrity versus plan conformance

**Assessment of rev 2's two classes.** Not sufficient. Reading every `req` in `state.ts` (Appendix A) shows at least
five kinds of rule:
- **`LOG`**: contiguous `sequence` and non-decreasing timestamps (`:248-249`). Owned by ingest; always true after ingest.
- **`REFERENCE`**: unknown or duplicate ids, missing dependencies. Recoverable by supplying data; not a statement that the fact is wrong.
- **`INTEGRITY`**: facts that cannot be accepted without violating fundamental consistency: arithmetic identities inside one record, state-machine legality (cannot complete what never started), non-negative physical quantities within a record, no double posting.
- **`PLAN_CONFORMANCE`**: equality to the plan or policy: routing shape, BOM/reservation equality, planned quantities, changeover table, one-time rework, station eligibility, FG balance equalities. Real systems legitimately report variance.
- **`AMBIGUOUS`**: classification depends on process or source semantics: backflush vs explicit consumption, concurrent stations, over-receipt tolerances, negative stock from late postings, allocation-before-shipment.

**Simulation-specific rules** (clear examples): actual setup must equal the changeover table or standard (`:559-566`);
planned equals produced quantity (`:625`); consumption equals reservation and BOM (`:505`); reservations equal BOM
exactly (`:407-410`); operations must match the routing step for step (`:383-391`); rework only once (`:644`);
FG receipt equals approved minus received and WIP must close to exactly zero (`:684`, `:694`); a shipment cannot exceed
allocated stock (`:731`); production completes on the station of the last assembly operation (`:622`); one workstation
per operation; the QC station is the first `INSPECTION` workstation (`:229`); exactly one free equipment unit of each required kind (`:570-572`).

**Questions answered**
- *Is the distinction sufficient?* No (five classes above). `AMBIGUOUS` is an honest bucket, not a failure: it is
  where the pilot must decide.
- *Document earlier than M7?* Yes. M1 commits the classification table as documentation (`docs/REDUCER_RULES.md`,
  derived from Appendix A). M3a adds nothing to messages or behavior. M7 introduces typed codes with a `class`
  (exhaustive map; a test fails for an unclassified code).
- *Can the strict reducer remain unchanged while a recording path is added later?* Yes, in two steps. (1) Quarantine
  keeps `PLAN_CONFORMANCE` business events with class and provenance, so no fact is lost. (2) A future **recording
  projection** (an actuals/variance fold over accepted plus plan-conformance-quarantined events, subject only to
  `LOG`, `REFERENCE` and `INTEGRITY`) can read them without touching `FactoryState`.
- *The honest caveat:* in the strict profile a plan-conformance quarantine **cascades** (a rejected `OPERATION_STARTED`
  blocks that operation's completion and everything after it), so the strict dashboard will omit or truncate such
  orders. The prepare/commit structure makes it technically possible to skip a class of `req`s without losing
  atomicity, but many state transitions assume the equalities (`order.wipQuantity = order.quantity`,
  `approvedQuantity - finishedGoodsReceivedQuantity`), so a profile switch alone may not be enough; a different quantity
  model may be needed. **This is unknown and is the central question for the pilot.**
- *Evidence the first real-data pilot must provide before a different ruleset profile is introduced:*
  1. A replay report of the pilot's business events through the strict reducer: quarantine counts by rule and class, and the
     share of work orders whose history is truncated by a plan-conformance cascade.
  2. Whether the source supplies *plan and actual separately* (planned vs actual setup, planned vs consumed quantity), or only actuals.
  3. The source's posting semantics (backflush at completion vs explicit consumption; partial completions; partial receipts; over-receipt tolerances).
  4. Whether events carry reducer-derived fields (`changeoverFromProductId`, `equipmentIds`, shortage figures) or only raw actuals the adapter would have to derive using state it does not have.
  5. How often inventory goes negative or reservations exceed stock, and why (late posting vs bad data).
  6. The customer's KPI definitions under variance (how scrap, over-receipt and partial completion count toward good units and yield).
  Decide a profile only if plan-conformance quarantines materially truncate histories; otherwise a variance report over the
  quarantine may be enough. Thresholds are set with the pilot, not now.

**Outside current scope:** a relaxed reducer or profile, variance and exception reporting, a plan-versus-actual data model,
backflush and partial-completion semantics, over-receipt and negative-stock semantics. Risk register entry R3 (§14).

### 7.10 OperationalView: a transitional compatibility port

```ts
interface OperationalView {                      // TRANSITIONAL — see sunset criteria
  readonly state: Readonly<FactoryState>; readonly master: MasterData;
  readonly now: Date;                            // single "now" (resolves controller-vs-asOf split)
  readonly range: { start: Date; end: Date | null };
  readonly epoch: number;                        // history-discarded / log-revision counter
  readonly dataOrigin: "synthetic" | "observed" | "mixed";
  readonly ingest: { quarantined: number; pending: number; unprojected: number };   // data for a future data-health view
  readonly fault: Error | null;                  // set when the replay is faulted (§7.6)
  onEvent(l: (e: FactoryEvent, s: Readonly<FactoryState>) => void): () => void;
  reportingSnapshot(): ReportingSnapshot;
}
```
**Assessment.** It is the right *first* abstraction: it removes `engine.*` reach-through, lets tests inject a stub, and is
cheap. It is not the right *last* one:
- `Readonly<FactoryState>` is shallow (nested records stay mutable at type level), compile-time only, and the object is the
  live state mutated in place. `reportingSnapshot().state` is the same live object, so a "snapshot" is not one. This is convention, not immutability.
- A deployed backend cannot ship the full state or the applied-event log (`events.slice(0, cursor)`) to the browser.

**Direction (documented, not built).** Each existing analytics function already has the shape of a query:
`(snapshot, args) -> result`. The future contract is those *result types*, asynchronous, purpose-specific, serializable and immutable:

| Existing function | Future query |
| --- | --- |
| `computeKpis`, `stationMetrics` | `getKpis(window)`, `getStationMetrics(window)` |
| `workOrderSummaries`, `workOrderDetail`, `workOrderTimeline` | `listWorkOrders(filter)`, `getWorkOrder(id)` |
| `workCenterLoad`, `workCenterQueues`, `equipmentLoad` | `getWorkCenterLoad(window)`, `getQueues(asOf)` |
| `goodUnitsThroughput` | `getThroughput(window)` |
| `billsOfMaterials` | `getBoms()` |
| `workstationViews`, `inventoryByLocation` | `getSceneProjection(asOf)` |

Local implementation = the same function over a snapshot wrapped in a promise; remote = HTTP. This matches design §6.4.
`HistoryQuery.stateAt` from rev 1 is dropped.

**Sunset criteria and guardrails.** The port is removed when UI/graphics consume per-view result types. A ratchet test
holds an allowlist of files allowed to read `view.state`/`view.master`; it may only shrink.

### 7.11 Simulation wire schema
`src/sources/simulation/wire.ts`: deliberately different from domain types (snake_case keys, `occurred_at` ISO with
explicit `Z`, `qty`, durations in **seconds** converted to integer minutes, status codes such as `RUN/IDLE/DOWN`, source-native
event ids, `event_kind` strings). Each wire event also carries the generator's emission position as `seq` and a `stream`
(`"sim"`), which the adapter maps to `sourceOrdinal` with `ordinal: "causal"` and `versioning: "none"`. A thin **emitter**
converts generator output (`FactoryEvent`) to wire records at the generator's output edge; the generator is not rewritten.
All 22 event types and the initial state/master data are covered, because M4 requires exact parity.

## 8. Incremental plan with acceptance criteria

Each milestone is a separate, reviewable commit/PR. The existing suite stays green at every step. M3a is independent of
the wire work and may land immediately after M0. Dependencies: M1 <- M0; M2 <- M1; M3a <- M0; M3b <- M1, M3a; M4 <- M2, M3b;
M5 <- M4; M6 <- M4 (M6a also <- M5); M7 <- M6.

**M0. Characterization, atomicity harness and performance baseline (tests/docs only)**
- Shared `tests/helpers/snapshot.ts` replacing the 5 hand-built `ReportingSnapshot` literals; pin the final-state hash of the canonical fixture replay.
- **Atomicity harness.** Oracle `assertAtomicReject(state, event)` on the **in-place** path (deep-equal of the whole state before and after, including `lastSequence`/`asOf`). A **corpus** `Record<EventType, CorpusEntry[]>` (exhaustive over the `EventType` union, following the pattern at `tests/contract.test.ts:31-54`; a missing type needs an explicit waiver with a reason) with at least one rejecting entry per type, including the intra-event cumulative cases of §7.6 (same-line shipments, duplicate operation ids, duplicate consumption entries, shorted second reservation, second equipment unit busy, rework quantity underflow, WIP not closing). Cases known to be non-atomic are committed as `it.fails` so they go red when fixed.
- **Behavior pinning.** Record, for every corpus entry and every event of the canonical fixture, the accept/reject decision and the exact error message. A **frozen copy of the current reducer** is committed under `tests/legacy/` for differential testing in M3a; it is deleted once M3a has merged and M7 closes.
- **Ordering characterization.** A test records the tie census of the default dataset and asserts that a global event-type rank cannot reproduce the simulation order (at least one event-type pair occurs in both orders within ties); it exists so nobody later "simplifies" ordering to a global rank.
- Record the load-pipeline baseline in `docs/PERFORMANCE.md`: parse time of `events.json` (2.5 MB), `FactoryReplay` construction, full replay, plus the measured clone cost.
- *Accept:* `npm test` green; no `src/` change; the harness enumerates which event types actually partially mutate (confirming or correcting §7.6); corpus covers all 22 types.

**M1. Contracts, runtime-validation primitives, observation semantics, identity policy, rule classification**
- `src/sources/types.ts`: `CanonicalInput` union, `InputProvenance` (with `streamId`, `sourceOrdinal`, `sourceVersion`, `contentKey`), `MappingIssue`, `QuarantineRecord`, `SourceCapabilities` (with `ordinal`, `versioning`, `timePrecision`), `ConflictResolution`, `OrderHint`, `SourceKey`, `IdentityResolver`, `IdentityMap`, `Known<T>`.
- Canonical JSON serialization (sorted keys, normalized numbers/timestamps) used for content equality; digest for audit only.
- Identity: passthrough and derived-composite resolvers with reversible escaping; conflict detection. No crosswalk file format yet.
- Validation primitives (decision D1) with `MappingIssue` output; validators never throw.
- `docs/REDUCER_RULES.md` (documentation only): the five-class classification of every reducer rule from Appendix A, with line references and a "real-world counter-example" column.
- Place `src/sources` under the **strict** tsconfig.
- *Accept:* compiles under `typecheck`; negative tests (missing field, wrong unit, unknown status, bad timestamp) return issues, never throw; derived ids stable, collision-free for adversarial keys, never containing `::`; canonical JSON is invariant under key order and timestamp spelling; type-level test that `ingest` accepts all three input kinds; bundle-size impact of the chosen validator measured and recorded (budget in §14).

**M2. Simulation wire format, emitter, adapter** (split: 2a initial state/master, 2b events)
- *Accept:* `adapter(emit(x))` deep-equals `x` for the initial state and every event; **conversions actually occur** (a test asserts the wire form differs: seconds vs minutes, status codes, key names, timestamp form); every wire record carries a `causal` ordinal and `stream`; generator `eventLogHash` and fixture hash `6ed76381` unchanged; `validate:data` green; provenance `origin: "simulated_event"`.

**M3a. Atomic reducer (own PR; pinned contract)**
- Implement §7.6: `prepareEvent` with `DeepReadonly`, `Commit`, `planMoves`/`commitMoves`, `CommitFailure`, dispatcher advancing `lastSequence`/`asOf`; `FactoryReplay` fault state; contributor checklist in `src/manufacturing/README.md`.
- *Accept:*
  1. All M0 `it.fails` flipped to passing tests; corpus oracle passes for every `EventType`.
  2. **Differential test**: for every event of the canonical fixture, the default dataset and the corpus, the new reducer and the frozen legacy reducer agree on accept/reject, on the error message, and on the resulting state when accepted.
  3. **Freeze test**: `prepareEvent` run against a recursively frozen clone of the state never throws a write `TypeError` for any event in the fixture, the default dataset (all 4,651 events) and the corpus.
  4. **Type test**: a `// @ts-expect-error` case proves assignment to the read-only state in prepare does not compile; `typecheck` strict green.
  5. Fault test: an injected throwing `Commit` yields `CommitFailure`, `FactoryReplay` becomes faulted and refuses to advance until `reset()`; prepare-phase `TypeError` leaves the state deep-equal.
  6. Fixture hash `6ed76381`, generator `eventLogHash` and `validate:data` byte-identical (no accepted-path change).
  7. Full replay and seek times within the `PERFORMANCE.md` 2x rule (target: unchanged); closure overhead recorded.
  8. `move` remains the only function that writes inventory (via `commitMoves`).

**M3b. Ingest: ledger, conflicts, ordering, quarantine, candidate/published/pending, reprojection**
- Depends on M1, M3a. Implements §7.4 and §7.5.
- *Accept:*
  1. The eight property tests of §7.4 pass (arrival order, batching, conflicts, versions, `ingestedAt`, publish/reproject, cascade, idempotence).
  2. The ordering acceptance tests (a) to (i) of §7.5 pass.
  3. **Simulation parity**: ingest of emitted simulation records yields the original events with identical ids, sequences and hash, in original and shuffled arrival; zero quarantined, zero pending.
  4. A late valid record is accepted by the candidate and appears as a `late` pending change; the published log is unchanged until `reproject`, which yields `revision + 1` with the documented `rewrite.fromSequence`; the late event is then in order and dependents were re-evaluated.
  5. A conflict arriving after one member is published yields a `retraction` pending change and leaves the published log unchanged (or retracts automatically if D9 is decided otherwise).
  6. An invariant-violating event leaves the shadow state equal to the same run without it, with the cascade recorded.
  7. Observation inputs land in `unprojected`; the candidate log and state are untouched.
  8. A tainted shadow state (non-invariant prepare error or `CommitFailure`) is rebuilt from the accepted log and ingest continues.

**M4. Route the app through the boundary (the stated milestone)**
- `loadSimulationData` -> `loadSource(adapter)` -> ingest -> publish -> existing `SimulationController`. The controller catches replay faults, pauses and exposes `fault`; `epoch` doubles as the log-revision counter. A **capability gate** in `loadSource` refuses a source whose capabilities lack `business_event` (or that yields no placeable events and no master data) with an explanatory message instead of booting an empty dashboard.
- *Accept:* identical dashboard, explorer and 3D numbers at 3 fixed seek points before and after (KPI parity); the simulation produces **zero quarantine, zero pending and zero error issues** (otherwise the app fails loudly); all CI commands green; import-boundary test: nothing outside `src/sources/simulation` and `scripts` imports the sim wire schema; the capability gate is covered by a unit test (no DOM); **load budget** met (§14).

**M5. OperationalView (transitional) and leak fixes**
- Controller implements the port; `Dashboard`, `PlaybackToolbar`, `OperationsExplorer`, `SceneManager` take it; `engine.*` access removed; single `now` passed to `workstationViews`/`WipBuffers`; `dataOrigin` drives the "Synthetic" label.
- Fix `WORK_CENTER_NAMES` import: use `master.workCenters` (behavior-preserving), so the module graph from the app entry excludes generator-side `masterData.ts`.
- Document transitional status, sunset criteria and the query table (§7.10).
- *Accept:* import-boundary test (`src/ui`, `src/graphics` do not import `src/simulation/*` or reach `engine`); ratchet allowlist test; a stub `OperationalView` drives a UI/analytics test; module-graph test: starting from the app entry, the transitive imports exclude `src/manufacturing/generator.ts`, `rng.ts`, `masterData.ts` and `src/sources/simulation/**`; behavior identical to M4.

**M6. Second adapter, with separate event-capable and observation-only scenarios**
Two fixtures, two test files, one shared harness. Details and the proof boundary are in §10.
- **M6a. Event-capable MES-like source.**
  - Hand-authored in a source shape different from the sim wire, under `tests/fixtures/sources/mes-like/`: a small master (1 to 2 products, legacy profile without work centers, equipment or changeovers, so it exercises the schema-compatibility gates), about 25 to 40 events forming valid histories (including one inspection failure with rework), per-source `causal` or `posting` ordinals, a crosswalk entry.
  - **Independently authored expected results**: `expected.json` written by hand from the fixture events before any FactoryFlow code runs on them (times placed inside one Mon-Fri 06:00-18:00 UTC shift to keep utilization arithmetic checkable), covering good units, WIP at three timestamps, active orders, first-pass yield, utilization numerator and denominator, work-order timeline length, and throughput buckets.
  - *Accept:* adapter normalizes; ingest yields the expected candidate with zero quarantine; the reducer accepts the whole history; existing analytics run **without any edit to `analytics/`, `ui/` or `graphics/`**; KPIs and detail views equal `expected.json`; the app boots from this source with the simulation module absent from the module graph (test from M5); `validateDataset` replay checks hold on the accepted log. A separate messy variant (`mes-like-messy`) pins the §9 rows that apply to event sources.
- **M6b. Snapshot-only ERP-like source.**
  - Hand-authored under `tests/fixtures/sources/erp-like/`: work-order status rows (`job_number`, `status`, `quantity`, `last_modified`), item and BOM-like exports, an unknown-status row, a missing-optional-field row, a row with unknown unit of measure.
  - *Accept:* adapter validates and normalizes observations (`Known`/`unknown`/`unsupported` preserved; no field defaulted to zero); ingest retains them with provenance in the ledger; `unprojected` lists them with `OBSERVATION_NOT_PROJECTED`; the candidate log is empty and unchanged by any number of re-ingests; `FactoryState` stays equal to the initial state; no analytics function is asked to produce a value from this source, and the boot gate refuses it with an explanatory message. **No dashboard or KPI claim is made.**
- **Shared identity test.** The crosswalk maps ERP `1042` and MES `WO-001042` to one canonical id; same local key in different sources yields different ids; a conflicting crosswalk fails closed and quarantines both sources' records for that key.
- *Overall accept:* every row of §9 has a pinned expected outcome; **if any edit to `analytics/`, `ui/` or `graphics/` is needed for M6a, the boundary is cosmetic and the milestone fails.**

**M7. Hardening, reconciliation strategy, rule classification in code**
- Typed rejection codes with a `class` from the five-way taxonomy replacing `INVARIANT_VIOLATION`; a test fails for any unclassified code and for any `req` without a code. `docs/REDUCER_RULES.md` becomes generated or checked against the code table.
- Reconciliation/reprojection strategy document: diff report of status changes after a revision; guidance for `pending` handling.
- Recorded performance results against budgets; checkpoint design note; decision record on a ruleset profile **conditional on pilot evidence** (§7.9); `STATUS.md` update; `SCHEMA_VERSION` bump + migration note only if canonical shapes changed; delete `tests/legacy/`.
- *Accept:* codes exhaustively mapped; results recorded in `PERFORMANCE.md`; docs consistent with code; no relaxed reducer exists.

## 9. Messy-data outcome matrix

Outcomes: **A** accepted/normalized, **Q** accepted with qualification, **QR** quarantined (recoverable), **R** rejected with
typed issue, **O** retained as observation, **H** held as a pending change (accepted by the candidate, not yet published). The criterion
is predictable, transparent handling without corrupting state, not that messy data becomes valid.

| # | Case | Layer | Outcome | Code | Assertion |
| --- | --- | --- | --- | --- | --- |
| 1 | Duplicate event, identical content | ingest | A (once) | `DUPLICATE_IGNORED` (info) | candidate unchanged |
| 2 | Same id, different content, unversioned | ingest | QR: **no member accepted** | `DUPLICATE_CONFLICT` | identical outcome in every arrival order; resolution accepts exactly the chosen one |
| 2b | Same id, source-declared higher `sourceVersion` | ingest | A (higher), lower superseded; H `correction` if the lower was published | `SUPERSEDED` (info) | winner independent of arrival order |
| 2c | Same id, equal top versions, different content | ingest | QR | `DUPLICATE_CONFLICT` | fail closed |
| 3 | Unknown status code | adapter | R | `UNKNOWN_STATUS` | no default status; record not mapped |
| 4 | Missing optional `observedAt` | adapter | A | none | `observedAt: null`, not zero or `now` |
| 5 | Missing `occurredAt` + declared proxy rule | adapter | Q | `OCCURRED_AT_PROXY` (warning) | `occurredAtQuality: observed_proxy` |
| 6 | Missing `occurredAt`, no rule | adapter | O | `UNPLACEABLE_TIME` | no event created |
| 7 | Late valid record (the 07:55 case) | ingest | H `late` | none | published unchanged until `reproject`; candidate already contains it in order |
| 8 | Conflicting external ids | identity | QR | `IDENTITY_CONFLICT` | no event for either key |
| 9 | Unknown unit of measure | adapter | R | `UNKNOWN_UOM` | no guessed conversion |
| 10 | Incomplete WO history (start without create) | reducer via ingest | QR + cascade | `INVARIANT_VIOLATION` (typed in M7) | order absent from state; chain recorded |
| 11 | Malformed record mixed with valid | adapter | R for the bad record, rest A | `SCHEMA_INVALID` with `path` | batch not aborted |
| 12 | Unsupported schema major / non-JSON envelope | adapter | R whole source | `SOURCE_UNSUPPORTED_VERSION` | nothing ingested |
| 13 | Reference to not-yet-known entity | reducer via ingest | QR (`REFERENCE` class in M7) | `INVARIANT_VIOLATION` / `UNRESOLVED_IDENTITY` | accepted when a later batch supplies the entity |
| 13b | Reference to an entity created at a later `occurredAt` | ingest | QR | `REFERENCES_FUTURE_ENTITY` | message names both timestamps |
| 14 | Source lacks inventory (partial capability) | adapter | A, plus capability | capabilities say `inventory: none` | no balances fabricated; no zero rows |
| 15 | ERP-style `COMPLETE` snapshot row | ingest | O | `OBSERVATION_NOT_PROJECTED` (info) | candidate and state unchanged |
| 16 | Unknown event kind | adapter | R, counted | `UNSUPPORTED_EVENT_KIND` | surfaced, not silently dropped |
| 17 | Negative quantity / non-integer cents | adapter | R | `SCHEMA_INVALID` | domain conventions enforced at the edge |
| 18 | MES variance: planned setup 30 min, reported 47 min | reducer via ingest | QR + cascade | `PLAN_CONFORMANCE` (class in M7) | **not** a data defect; retained with class; shows the §7.9 question |
| 19 | Cross-source tie, independent records | ingest | A | `arbitrary_independent` order quality | same order under any arrival order |
| 20 | Cross-source tie, interacting records, no ordinals | ingest | QR | `AMBIGUOUS_ORDER` | recovered by `OrderHint` |
| 21 | `causal` stream whose ordinal contradicts time order | ingest | QR | `SOURCE_ORDER_CONTRADICTION` | pair named |
| 22 | `posting` stream with late posting | ingest | H `late` | none | not a contradiction |
| 23 | Unexpected `TypeError` while preparing an event | reducer via ingest | QR | `INTERNAL_ERROR` | state deep-equal before and after |
| 24 | Conflict arrives after one member was published | ingest | H `retraction` | `DUPLICATE_CONFLICT` on the candidate | published unchanged until `reproject` (D9) |

**Acceptance invariant for every row:** the accepted log replays without error; the atomicity oracle holds; no entity in
`FactoryState` lacks a source provenance record.

## 10. What M6 proves and what it does not

| | M6a event-capable MES-like | M6b snapshot-only ERP-like |
| --- | --- | --- |
| Proves | Adapter, identity, ordering, ingest and strict reducer work for a source that is **not** the simulation. Existing analytics, UI and graphics run unchanged on it, and the app boots without the simulation module. KPI behavior matches independently authored expectations | Observation inputs are validated, normalized, retained with provenance, never converted into events or state, and unknowns are never coerced to zero. A source that cannot support event analytics is refused at boot rather than shown as zeros |
| Does **not** prove | Anything about sources with sparser semantics (backflush, partial completion, variance) beyond the pinned quarantine rows; real-system latency, volumes or live updates | That any dashboard, KPI or work-order view can be driven by observations |
| Deferred | Plan-conformance recording (§7.9); live append; calendars as master data | `ObservedState`, capability-aware read models and UX, interpretation policy |
| Test path | `tests/sources/mes-like.*.test.ts` plus `expected.json` | `tests/sources/erp-like.*.test.ts` |

Both scenarios are separate fixtures and separate test files because the success criteria differ in kind; sharing a
single fixture would invite the false inference that observation data feeds event analytics. A thin shared harness
(load fixture, run adapter, run ingest, report) avoids duplication.

## 11. Architectural decisions and deferred capabilities

| Capability | Now (implemented) | Defined now, implemented later | Explicitly deferred |
| --- | --- | --- | --- |
| Atomic reject | Prepare/commit reducer, freeze and differential tests (M3a) | | |
| Runtime validation | Adapter validators (M1/M2/M6) | | Schema registry / evolution tooling |
| Provenance | Side table, time fields, adapter/identity versions, content equality | | Persistent audit store |
| Conflicts and corrections | Fail-closed groups, `sourceVersion`, persisted resolutions (M3b) | Correction events as a first-class input | Resolution UI |
| Ordering | Ordinals with declared semantics, ambiguity quarantine, hints (M3b) | Adapter-side lifecycle ordinal helper | Dependency graph, permutation search |
| Candidate/published/pending | Pure `ingest`, `publish`, explicit `reproject` | Revision hot-swap in a running controller; diff report | Automatic reprojection, persistence, streaming |
| Identity | `SourceKey`, resolvers, crosswalk, conflict rules | `SceneObjectBinding` for 3D | MDM, fuzzy matching, tenant enforcement |
| Observations | Input union, routing to `unprojected`, boot gate (M4/M6b) | `ObservedState`, `Known<T>` projection, interpretation policy, capability-gated KPIs | Derived/inferred tier, forecasts |
| Read-model port | `OperationalView` (transitional) | Result-typed async queries | Backend, API, auth |
| Rule classification | Documented in M1 (`REDUCER_RULES.md`), coded in M7 | Ruleset profile decision conditional on pilot evidence | Relaxed reducer, recording projection, variance reporting |
| Calendars | Hard-coded shift constant stays | Calendar as master data | Per-site calendars |
| Infrastructure | none | | Database, broker, cloud, workers |

## 12. Design rationale

| Decision | Solves | Layer | Alternatives | Complexity | Real, not cosmetic, because |
| --- | --- | --- | --- | --- | --- |
| Domain types stay canonical | No second vocabulary; fixtures intact | `manufacturing` | Separate neutral contracts | Heavy adapters for sparse sources | M6 shapes differ from the sim and still map |
| `CanonicalInput` union | Avoids locking sources into event semantics | `sources` | Always `FactoryEvent` | One routing branch | M6b: log and state unchanged |
| Prepare/commit reducer | I1 for every caller at O(1) cost, structurally | `manufacturing` | Clone (60 s), journal, discipline only | Mechanical refactor of one switch | Type test, freeze test, differential test, corpus |
| Candidate/published/pending | Determinism and prefix stability, with the unavoidable divergence made explicit | `sources` | First-wins; auto-rewrite | Three small functions | Property tests G1 to G3 |
| Fail-closed duplicate groups | No arbitrary winner | `sources` | First wins; last wins | Resolution artifact | Order-independent outcomes |
| Ordinals + ambiguity quarantine | Honest ordering | `sources` | Global lifecycle rank; dependency graph | Per-source capability declaration | Tie census shows rank cannot work |
| Reducer dry run as validity oracle | Reducer-compatible order without a graph | `sources` | Permutation search | Shadow replay (≈ 30 ms per 4.6k events) | Hash parity; quarantine tests |
| Injected `ingestedAt`, content equality | Determinism without hash-collision risk | `sources` | `Date.now()`, 32-bit digests | One context field | Variation tests |
| Passthrough + derived + crosswalk ids | Reproducible identity without MDM | `sources` | Hash ids; DB mapping tables | Small resolver | Collision and conflict tests |
| Independent sim wire + emitter | Adapter performs real translation | `sources/simulation` | Envelope only; ERP tables | Extra schema | Conversion assertions; boundary test |
| Transitional `OperationalView` | Decouples UI from the controller now | `simulation`/app | Query hierarchy now | Refactor of 4 UI files | Stub-driven test; ratchet |
| Five-way rule classes | Preserves actual facts later without relaxing now | docs, then M7 codes | Two classes; relaxed reducer now | Documentation, later a code table | Exhaustive-map test |

## 13. Decisions requiring approval (recommendations first)

Settled by your review of rev 2 (recorded, not reopened): M3 split into M3a/M3b; reducer-level atomicity by
validate-before-mutate; the `CanonicalInput` union; strict reducer retained; independent simulation wire format.

- **D1. Validation library.** Recommend **zod** scoped to `src/sources`, gated on a measured bundle/load budget (§14). Alternative: hand-written validators, no dependency, more code across 22 event types. The need is one definition for types and parsing.
- **D3. Late-data default (redefined by the candidate/published model).** Recommend: late records are accepted by the candidate and held as `pending` until an explicit `reproject`. Alternative: reproject automatically (rewrites ids and sequences under a running UI).
- **D4. Canonical id form for non-sim sources.** Recommend readable composite with reversible escaping plus crosswalk override. Alternative: hashed ids (needs a ≥ 64-bit hash; the repo's `fnv1a` is 32-bit).
- **D6. Reducer rule profile.** Recommend: document the five classes now (M1), code them in M7, and decide on a recording profile only on pilot evidence (§7.9). Do not relax the reducer now.
- **D7. Performance budgets (ratify after the M0 baseline).** Proposed: steady-state rows in `PERFORMANCE.md` within 2x; added one-time load work (wire parse + validate + adapt + ingest) at most about 300 ms on the Node baseline for the default dataset and no new long task above 500 ms in the browser; wire files at most 1.5x `events.json`.
- **D8. Carried over:** default source in the app (simulation, fixtures behind a flag); shift calendar as master data (defer); domain-purity leaks (`masterData.ts` -> layout, `selectors.ts` -> graphics type, generator in the barrel) as a separate small PR after M5.
- **D9. Retroactive conflicts or corrections against already-published events.** Recommend **hold** (published log unchanged, `pending` reports the retraction, explicit `reproject` applies it) because retraction rewrites ids and sequences under a running UI and the contested record was valid when published. This is the one place where the served log favors the earlier arrival; it is visible, not silent. Alternative: **retract** automatically (fully fail closed, but consumers rebuild unprompted).
- **D10. Ordinal semantics.** Recommend four values (`none`, `posting`, `causal`, `adapter_derived`). Alternative: two (`none`, `causal`), treating everything else as unordered; simpler, but forces ambiguity quarantine for ordinary MES posting order.
- **D11. Adapter-side lifecycle ordinal helper.** Recommend **defer** until a real adapter needs it and an ordinal-stripped-simulation experiment shows it reproduces every tie group. Alternative: build it in M3b (adds domain knowledge that can drift from the reducer).
- **D12. Boot gate for observation-only sources.** Recommend refuse with an explanatory message (M4/M6b). Alternative: boot an empty dashboard (rejected: shows false zeros).
- **D13. Where `OrderHint` and `ConflictResolution` live.** Recommend file-based, versioned artifacts next to the identity map, no UI. Alternative: embedded in source config.

## 14. Risks, failure modes, testing strategy, performance

**Risks**
1. **Atomicity by construction depends on types and tests, not proof** (§7.6 table). Mitigation: freeze, differential and corpus tests on every CI run; rebuild on `CommitFailure`.
2. **Refactor of a pinned 600-line reducer.** Mitigation: M0 differential baseline; hash parity; intra-event cumulative cases enumerated and tested individually.
3. **Reducer policy rules reject real variance (R3).** Plan-conformance quarantine cascades and truncates histories in the strict profile (§7.9). Mitigation: classification now, retention of quarantined facts, pilot evidence before any profile change.
4. **Ambiguity floods.** Sources with coarse timestamps and no ordinals will see many `AMBIGUOUS_ORDER` quarantines. This is intended; adapters must supply ordinals (D10, D11).
5. **Cascade quarantine:** one rejected event hides a whole order's later events. Correct (no fabricated history) but must be visible; counts are exposed on the view, a data-health UI is deferred.
6. **Published/candidate divergence** can be forgotten by operators. Mitigation: `pending` counts on the view; M7 reconciliation guidance.
7. **Revision-scoped `EVT-` ids:** persisted references must use source identity.
8. **M2 is the largest milestone** (22 event types plus master data); split 2a/2b and make mapping table-driven.
9. **Cosmetic boundary** if emitter/adapter collapses to identity. Mitigation: conversion assertions; M6a must pass without analytics/UI edits.
10. **Load-time cost:** the worst frames already occur at parse time (280 to 840 ms, `PERFORMANCE.md`); validation, adaptation and shadow replay add to it. Mitigation: D7 budget; lazy or chunked validation is a fallback, not a plan.
11. **State growth:** `inventoryTransactions` is append-only (5,098 entries at 4.6k events); a backend must not ship it. Checkpointing deferred.
12. **Two projections** (event-sourced and observed) could double UI work. Gated: `ObservedState` is not built until a snapshot-only source is real.
13. **Type-safety gap:** `ui`, `graphics`, `simulation`, `analytics` are non-strict; new `src/sources` is strict.
14. **Contract drift:** canonical shape changes need fixture update, `SCHEMA_VERSION` bump and migration note (`CLAUDE.md`).
15. **Temporary duplicate reducer** under `tests/legacy/` could outlive its purpose; M7 deletes it.

**Testing strategy** (each claim has a test): source independence (import-boundary and module-graph tests, M6a on unchanged analytics); runtime
validation (negative tests); normalization (unit/time/status conversion assertions); event replay (determinism, hash parity,
round trip); domain invariants (`validateDataset` over ingest output; atomic-reject oracle; freeze and differential tests);
ordering (tie census, ordinals, ambiguity, hints, contradictions); conflicts and determinism (G1 to G3 property tests);
late data and reprojection; identity (determinism, collision, conflict, cross-source equivalence); observations (never
fabricate events or state; unknowns never coerced); messy-data matrix (§9); independently authored KPI expectations (M6a);
transitional-port ratchet.

**Performance baseline reused** (`docs/PERFORMANCE.md`): full replay about 30 ms, seek 50%/100% about 11/28 ms, KPIs about 4 ms,
4,651 events in the default dataset. Rule: a more than 2x regression in any row is investigated. Measured for this plan:
`structuredClone(final state)` ≈ 26 ms (why clone-per-event is rejected). Ingest cost estimate: sort O(n log n) plus one
shadow replay (≈ 30 ms per 4.6k events); a re-ingest over the whole ledger is therefore cheap at this scale; at about
10^5 events the extrapolation is under a second, beyond which checkpoints are needed (deferred). Benchmarks are
recorded, not asserted in CI (wall-clock flakiness).

## 15. Verification, critical files, reporting

```bash
npm test && npm run typecheck && npm run typecheck:app && npm run validate:data && npm run build
npm run dev   # manual: compare KPI cards at 3 fixed seek points against the pre-change baseline
```

**Critical files:** `src/manufacturing/{state,replay,events,types,rules,selectors,validation}.ts`,
`src/simulation/{loadSimulationData,SimulationController,reportingSnapshot}.ts`, `src/analytics/{types,workOrders}.ts`,
`src/ui/{Dashboard,PlaybackToolbar}.ts`, `src/ui/explorer/OperationsExplorer.ts`, `src/graphics/SceneManager.ts`,
`src/main.ts`, `scripts/{generate,validate}.ts`, `tests/contract.test.ts`, `tests/manufacturing.test.ts`;
new: `src/sources/**`, `tests/helpers/snapshot.ts`, `tests/legacy/**` (temporary), `tests/fixtures/sources/**`, `docs/REDUCER_RULES.md`.

**Report on completion of each milestone (per `CLAUDE.md`):** what changed, contracts changed (none through M6 by design),
migration notes, tests run, what remains hypothetical (`ObservedState`, interpretation policy, result-typed queries, live
append, persistence, recording profile).

## Appendix A. Reducer invariant classification

Initial classification by code reading of `src/manufacturing/state.ts`, to be ratified by tests (M1 doc) and pilot data
(§7.9). Classes: **L** log, **R** reference, **I** integrity, **P** plan conformance, **A** ambiguous.

| Rule (state.ts) | Class | Why | Real-world counter-example |
| --- | --- | --- | --- |
| `sequence === lastSequence+1`; timestamp non-decreasing (248-249) | L | Ingest assigns sequence; ordering is a log property | none after ingest |
| Duplicate id of PO, receipt, transfer, customer order, production order, operation, assignment, inspection, shipment, downtime | R | Same id twice; resolved by idempotency groups upstream | source re-sends the same transaction |
| Unknown supplier, customer, product, material, location, order, operation, workstation | R | Missing dependency; recoverable by supplying it | event arrives before its entity |
| Quantities positive; PO line starts at `ordered > 0, received = 0`; new order OPEN/PLANNED with zero progress (285-290, 348-351, 380) | I | Creation-state identity of a single record | an ERP reports an already-received PO on first sight (then it is an observation) |
| Inspection identities: passed + failed = inspected, rework + scrap = failed, defect counts = failed (640-642) | I | Arithmetic within one record | defect codes missing for failed units (then A) |
| State-machine legality: cannot start/complete/resume/ship in the wrong status (498, 522, 544, 545, 598, 621, 707, 725) | I | Cannot complete what never started | missing "start" event from a source (then a data gap, quarantine) |
| Operation precedence: predecessors completed (546-547) | P | Routing plan; shops overlap operations (design §3.1) | overlapped operations |
| Operations match routing step for step; quantity equals order quantity (383-391) | P | Routing plan | skipped/added steps, split quantities, revisions |
| Reservations equal BOM requirement exactly and cover the BOM (407-410) | P | Plan equality | substitutes, partial reservation, overage |
| Consumption equals reservation and BOM; from the reserved location (500-506) | P | Plan equality | consumption variance, scrap, different bin |
| Setup minutes equal changeover/standard; changeover origin equals station history (559-566) | P | Simulation table | actual 47 min vs planned 30 min |
| Exactly one free unit of each required equipment kind (568-576) | P | Eligibility plan | tooling unrecorded; alternative equipment |
| `quantityProduced === order.quantity` (625) | P | Plan equality | yield variance, partial completion |
| Production completes on the station of the last assembly operation (622); QC station is the first INSPECTION workstation (229) | P | Simulation assumption | multi-station routing; several QC cells |
| Inspected quantity equals units awaiting QC and the operation quantity (639) | P | Plan equality | sampling, partial inspection |
| Rework once only: re-inspection failures are scrapped (644); rework operations are exactly REWORK + FINAL_TEST (661-665) | P | Simulation policy | repeated rework |
| FG receipt equals approved minus received; WIP must close to exactly 0 (684, 694) | P | Balance equalities of the sim | partial receipts, over-receipt, units unaccounted for |
| FG receipt blocked while rework pending or ops outstanding (680-682) | P | Quality-gate policy | receipt of approved units before rework completes |
| Allocation not above open quantity; shipment not above allocated (711, 731) | P | Order-fulfilment policy | ship from stock without an allocation step |
| Shortage block: claimed required/available must match computed inventory; only PLANNED orders (447-457) | A | Verifies a *producer-derived claim* against our (possibly incomplete) inventory | source's own shortage view differs |
| Starting requires materials already consumed (523) | A | Consumption-before-start is a posting convention | backflush at completion |
| Station must be IDLE and not DOWN; capacity 1 (525, 549-550) | A | Resource exclusivity as modelled | missing completion posting; concurrent jobs |
| Station serves the operation's work center (551-554) | A | Eligibility table | mapping gaps |
| Inventory: `onHand >= 0`, `reserved >= 0` (172-173) | A | Physical balance can be negative from late postings | backflush before receipt |
| Inventory: `reserved <= onHand` (174-177) | P | Reservation is a plan construct | allocations above stock (backorders) |
| Receiving location kind, raw storage kind, assembly kind, FG location (284, 302, 410, 507, 685) | A | Canonical location typing; adapter mapping concern | plants without these location kinds |
| Material supplied by the PO's supplier (289) | A | Approved-supplier policy | alternate suppliers |
| Receipt not above ordered; PO not already received (301, 312) | A | Tolerance policy | over-receipt, receiving against a closed PO |
| Cancel only before start/consumption (427-428); customer order cancel only when OPEN (359) | A | Policy | cancel after start with WIP/scrap |
| Machine failure on a DOWN station rejected; restore needs an open downtime (749, 771-772) | I | State-machine legality | duplicate failure feed |

Roughly: the strict reducer is mostly `P` and `A` for anything involving quantities and plan, and `I`/`R`/`L` for structure.
A recording path is therefore not a small relaxation; it needs its own acceptance rules.

## Appendix B. Evidence from the current event log

Measured on `data/generated/events.json` (seed `northstar-2026`, schema 1.3.0, 4,651 events) by reading the file only.
Re-run in M0 to keep these numbers honest.

| Measure | Value |
| --- | --- |
| Distinct timestamps | 1,346 |
| Timestamps holding more than one event (tie groups) | 1,145 |
| Events inside tie groups | 4,450 of 4,651 (95.7%) |
| Largest tie group | 20 events |
| Tie groups sharing a `productionOrderId` | 864 |
| Tie groups sharing a `workstationId` | 853 |
| Tie groups fully independent (no shared primary entity) | 102 |
| Events with an interacting peer (shared primary id) | 3,354 |
| Event-type pairs observed in both orders within ties | 42 (e.g. `OPERATION_COMPLETED`/`OPERATION_STARTED` 829 vs 23; `MATERIAL_CONSUMED`/`PRODUCTION_STARTED` 230 vs 13; `OPERATION_STARTED`/`PRODUCTION_STARTED` 21 vs 279) |
| Same-order tie chains | e.g. 193x `OPERATION_COMPLETED > OPERATION_STARTED`; 191x `QUALITY_INSPECTION_COMPLETED > OPERATION_COMPLETED > FINISHED_GOODS_RECEIVED`; 89x `CREATED > RELEASED > CONSUMED > PRODUCTION_STARTED > OPERATION_STARTED` |
| Same-order type multisets observed in more than one order | 0 of 12 (a per-order rank is plausible in-sample but not sufficient for stations and inventory) |
| Zero-duration operations | 0 |
| `structuredClone(final state)` | about 26 ms (min 24.2, median 26.2, max 30.7 over 7 runs) |
| Final state | 5,098 inventory transactions, 223 production orders, 1,088 operations; `final_state.json` 3.6 MB; `events.json` 2.5 MB |
