# Source independence for FactoryFlow: integration boundary plan (revision 2)

Status: **proposal for approval. No application code, tests, fixtures or dependencies have been changed.**
Revision 2 supersedes revision 1 after the architecture review described in §3.

## 1. Context and decisions already made

FactoryFlow's generator, reducer, loader, analytics and UI share one set of types (`src/manufacturing/types.ts`). The
app loads JSON with an `as` cast (`src/simulation/loadSimulationData.ts:13-15`), so nothing marks where "a source" ends
and "the product" begins. The goal: replace the simulation with another source (JSON fixtures first, later ERP/MES/DB/API)
without changing domain logic, analytics or presentation. Source independence must mean more than swapping one JSON
format for another: real systems are incomplete, late, inconsistent and sometimes contradictory, and FactoryFlow must
not fabricate manufacturing history to hide that.

Decisions agreed earlier (unchanged in rev 2):
1. Existing domain types stay the canonical vocabulary. Provenance sits beside events, not inside the pinned envelope.
2. An ingestion stage, not the source, assigns the canonical `sequence`. The reducer stays strict.
3. The simulation emits a modest, independent wire schema (own names, units, status codes) that an adapter maps back.
4. Milestone 1 builds only a narrow read-model port; richer query interfaces are documented, not built.

## 2. What changed from revision 1

| Area | Rev 1 | Rev 2 | Why |
| --- | --- | --- | --- |
| Reducer atomicity | Deferred to M7 | **M3a**, reducer-level validate-before-mutate, own PR | §7.5: 11 of 22 event types can mutate then throw; no test covers it |
| `ingest()` | Batch function that stamps permanent sequences | Ledger-based **set function** with deterministic order, recoverable quarantine and explicit late-data policy | §7.4: late data cannot be handled by permanent stamping |
| Adapter output | Always `FactoryEvent` | `CanonicalInput` union: business event, snapshot observation, CDC change. Only business events reach the reducer | §7.6: an ERP status row proves none of the events the reducer requires |
| "Inferred" events | Rev-1 risk 2 proposed synthesising operations/reservations and tagging them `origin:"inferred"` | **Retracted.** Observed state is never turned into events by an adapter | Violates design §6.2, §17 and "missing is not zero" |
| Identity | One line ("normalize ids") | Explicit policy, `SourceKey`, resolver contract, crosswalk, conflict rules (§7.3) | Cross-system identity is a correctness issue, not a formatting step |
| Time | `occurredAt` / `ingestedAt` | Five distinct concepts, `ingestedAt` injected (§7.2) | Determinism; late data |
| `HistoryQuery.stateAt` | Types-only, returned full state | **Removed.** Replaced by result-typed queries that mirror existing analytics functions (§7.8) | `stateAt` would force a backend to ship the whole factory state |
| `OperationalView` | Permanent port | Explicitly **transitional**; adds `dataOrigin`; ratchet test (§7.8) | `Readonly<FactoryState>` is shallow, compile-time only, and the object is live |
| M6 | Second adapter + analytics run | Plus **messy-data fixtures** with explicit expected outcomes (§9) | Round-trip equality does not prove the boundary handles bad data |
| Provenance `origin` | `observed / synthetic / inferred` | Design §7.1 vocabulary: `simulated_event`, `source_business_event`, `cdc_change`, `snapshot_observation`, `manual_correction` | Consistency with `FACTORYFLOW_DESIGN.md` |
| Zod | Recommended | Still recommended, now gated on a measured bundle/load budget (D1) | `docs/PERFORMANCE.md` baseline |

## 3. Review of the concerns raised against the repository

| Concern | Verdict | Notes |
| --- | --- | --- |
| 2. Atomicity earlier | **Valid, and worse than rev 1 stated.** | Catalogue in §7.5. Existing "rejection" tests call the cloning wrapper `applyEvent` and assert the *input* is untouched (`tests/manufacturing.test.ts:213-215`), which is trivially true; nothing tests the in-place path. Pushback: the fix belongs in the reducer, not the ingestion layer. |
| 3. Ordering and late data | **Valid.** Rev-1 `ingest()` cannot support it. | The reducer's contiguous sequence and monotonic timestamps are *not* in conflict with late data if ingest produces a correct order. The real conflict is **sequence/id stability** (`EVT-` ids are derived from sequence). Reducer invariants stay untouched. |
| 4. Observations vs events | **Valid; the most important.** | `ProductionOrder` has required numeric fields (`approvedQuantity`, `wipQuantity`), so unknown cannot be represented in `FactoryState` today. Pushback on scope: provide the boundary now, build no observation framework. |
| 5. Identity | **Valid, proportionate.** | Code shows extra risks: generator ids are positional counters; location/workstation ids double as 3D object ids; `inventoryKey` joins ids with `::`. Tenant/site/versioning stay as fields, not machinery. |
| 6. `OperationalView` transitional | **Valid.** | `Readonly<T>` is shallow even at compile time, and `reportingSnapshot().state` is the live mutable object, so the "snapshot" is not a snapshot. |
| 7. Messy-data fixtures | **Valid.** | Limit: capability-aware UX is Proposed (`STATUS.md`), so partial capability is asserted at adapter/read-model level, not in the UI. |
| Move all of it into M3 | **Partly overstated.** | Splitting M3 into M3a (reducer) and M3b (ingest) keeps the pinned reducer's change reviewable on its own. |

**Additional risks the code review surfaced** (not in the raised concerns):
- **R-policy.** The reducer encodes *simulation plan rules*, not just integrity: `setupMinutes` must equal the changeover table (`state.ts:565`), `quantityProduced === order.quantity` (`:625`), consumption must equal reservation and BOM (`:505`), FG receipt must equal approved minus received (`:684`), rework only once (`:644`). A real MES reporting actual variance would be *rejected for telling the truth*. See D6.
- **Analytics is not fully source-agnostic.** `src/analytics/workOrders.ts:7` imports `WORK_CENTER_NAMES` from `masterData.ts` (the generator's constant, which also imports the 3D layout), although `MasterData.workCenters` already carries names. Fixed in M5.
- **Reducer rejections are untyped strings;** non-`InvariantViolation` errors (e.g. `TypeError` on a malformed payload) can occur mid-mutation.
- **Doc drift:** `docs/STATUS.md` still says schema `1.0.0` in the "Typed master data" row (code is `1.3.0`). Out of scope here; noted for a docs pass.
- **`fnv1a` in `generator.ts` is 32-bit** (event-log checksum). It must not be used to mint ids.

## 4. Principles

- **P1** Missing information is not zero. Unknown, unsupported and known-zero are distinct.
- **P2** An observed state is not proof of the business events that produced it.
- **P3** The strict event-sourced core is preserved. Weaker sources get a different path, not a weaker reducer.
- **P4** A rejected external event must never partially mutate accepted operational state.
- **P5** The simulation passes through the same boundary as any source; no bypass.
- **P6** Ingestion output is a deterministic function of the *set* of source records and the identity map; arrival order and wall clock do not matter.
- **P7** Every accepted, quarantined or rejected record is attributable to a source record and an adapter/identity-map version.
- **P8** No database, broker, transport or framework is introduced for hypothetical integrations.

## 5. Current architecture assessment (what to preserve, where the gaps are)

**Preserve**
- `FactoryReplay` (`src/manufacturing/replay.ts`): pure, no timers, header already calls it an integration point.
- Strict reducer and `rules.ts` (shared by generator and reducer); contract fixture and hashes (`tests/fixtures/canonical`, `6ed76381`).
- Analytics input `ReportingSnapshot {asOfMs, startMs, master, state, events}` (`src/analytics/types.ts`).
- `validateDataset` (`validation.ts`) as an oracle for any event stream; `replayWithGuard`, `buildEvent`, `entityRefsFor`, `eventIdFor`.
- The single clock `SimulationController`; deterministic seeded generator.

**Gaps**
| Finding | Where |
| --- | --- |
| Loader casts JSON; no shape or version check; `SCHEMA_VERSION` never read at runtime | `loadSimulationData.ts:13-15` |
| Generator output *is* the internal type; no wire format | `generator.ts` `emit()` -> `buildEvent` |
| UI/graphics hold the live controller and reach into `engine.master` / `engine.onEvent` | `Dashboard.ts`, `OperationsExplorer.ts`, `SceneManager.ts:5` |
| Only seam into analytics is `reportingSnapshot(sim)`; its `state` is the live object | `src/simulation/reportingSnapshot.ts` |
| Two "now"s: `controller.currentTime` vs `state.asOf` | `selectors.ts:89`, `WipBuffers.ts` |
| Reducer can mutate then throw (§7.5); rejections untyped | `state.ts`, `replay.ts:72` |
| No dedupe, reorder, quarantine or late handling; strict `sequence === lastSequence+1` | `state.ts:248-249` |
| No provenance on events | `EventEnvelope`, `types.ts:646` |
| History exists only by replay in the browser (backward seek is O(n)) | `replay.ts:96` |
| Source-specific leaks: `WORK_CENTER_NAMES`; hard-coded shift calendar; `masterData.ts` imports 3D layout; `selectors.ts:5` imports a graphics type | `analytics/workOrders.ts:7`, `calendar.ts`, `masterData.ts:1`, `selectors.ts:5` |
| `ReportingSnapshot` hand-built in 5 test files | `tests/*` |

## 6. Dependency and data-flow diagram

```
 sources                         integration boundary                                core                              presentation
 ┌──────────────────┐  raw    ┌────────────────────────────┐ CanonicalInput  ┌────────────────────────────┐
 │ simulation emitter│ ─────▶ │ SourceAdapter<TWire>        │ ─────────────▶ │ Ingest (ledger, set function)│
 │ (sim wire schema) │        │  validate → normalize →     │ business_event │  dedupe · order · late policy│
 ├──────────────────┤        │  resolve identity → map     │ snapshot_obs.  │  dry-run on shadow state     │   FactoryEvent
 │ JSON fixture src  │ ─────▶ │  provenance · MappingIssue[]│ cdc_change     │  quarantine · stamp sequence │ ─────────────┐
 ├──────────────────┤        └──────────────┬─────────────┘                └──────┬──────────┬─────────────┘              ▼
 │ future ERP/MES/DB │                       │ IdentityResolver                    │          │ snapshot/CDC       ┌─────────────────┐
 └──────────────────┘                       ▼ (identity map, versioned)           │          ▼ (retained, not    │ FactoryReplay    │
                                                                                   │            projected today)  │ + strict reducer │
                                              QuarantineRecord[] / MappingIssue[] ◀┘            ┌──────────────┐│ (state.ts)       │
                                                                                                │ ObservedState │└────────┬─────────┘
                                                                                                │ (DEFERRED)    │         │ FactoryState
                                                                                                └──────────────┘         ▼
   SimulationController (clock; replay-capable sources only) ──────────────▶ OperationalView (transitional port) ──▶ analytics ──▶ ui / graphics
```

**Dependency direction** (arrow = "may import"):
`ui, graphics -> OperationalView -> analytics -> manufacturing (contracts + reducer)`;
`sources/* (adapters, identity, ingest) -> manufacturing types`; `sources/simulation/* -> sources/*`;
`scripts -> sources/simulation`. Nothing in `manufacturing`, `analytics`, `ui` or `graphics` imports an adapter, a wire
schema, or the simulation emitter. The clock lives behind the port and only for replay-capable sources.

## 7. Responsibilities, contracts and policies

### 7.1 Responsibilities

| Component | Does | Does **not** |
| --- | --- | --- |
| **Source adapter** (`src/sources/**`) | Parse and runtime-validate wire data; normalize timestamps, units, statuses; resolve identity; map to `CanonicalInput`; attach provenance; report `MappingIssue`s | Apply business rules; call the reducer; infer events from state; invent defaults for missing fields |
| **Identity resolver** | Map `SourceKey` -> canonical id; report unresolved/conflicting keys | Fuzzy-match; merge entities on its own |
| **Ingest** (pure) | Dedupe, deterministic ordering, late-data policy, dry-run on a shadow state, quarantine, stamp `sequence`/`id` via `buildEvent` | Hold a clock; touch the UI; run the live replay |
| **Interpretation policy** (DEFERRED) | Decide whether observations *directly* support a domain event; emit events with `origin` and `basis` | Exist by default; default is "none" |
| **Reducer / `FactoryReplay`** | Enforce domain invariants; atomic on reject (§7.5); replay | Know about sources, provenance or quarantine |
| **OperationalView** | Give UI/graphics state, master, `now`, subscription, `reportingSnapshot()`, `dataOrigin` | Be the long-term contract (§7.8) |

### 7.2 Time semantics

| # | Concept | Field | Notes |
| --- | --- | --- | --- |
| 1 | Source ordering/versioning | `sourceOrdinal?` | Source-declared total order within a stream (sim sequence, MES transaction id, DB LSN). Compared only within one `sourceId` |
| 2 | Business occurrence time | `occurredAt` (`FactoryEvent.timestamp`) | UTC instant, normalized to ms. `null` if the source cannot say |
| 3 | Observation/capture time | `observedAt` | When the source recorded/extracted it. Never substituted silently for `occurredAt` |
| 4 | Ingestion/acceptance time | `ingestedAt` | **Injected** via `IngestContext` (no `Date.now()` in the core). Never part of ordering or hashes |
| 5 | Canonical replay order | `sequence` / `EVT-` id | Position in a *log revision*; revision-scoped, not a permanent identity |

`occurredAtQuality`: `reported` | `observed_proxy` | `unknown`. An adapter may use `observedAt` as `occurredAt` only if it is
explicitly declared for that event type, and records `observed_proxy`. Otherwise a record without `occurredAt` cannot
be placed in the event log and is retained as an observation.

### 7.3 Identity policy

- **Key.** `SourceKey = { sourceId, entityType, key, scope?: { tenantId?, siteId? } }`. Two keys are equal only if all fields are equal, so "1042" in two systems never collides. `entityType` uses the domain's own names (production order, customer order, purchase order, product, material, supplier, customer, location, workstation, work center, equipment).
- **Canonical id.** Opaque string, charset `[A-Za-z0-9._-]` and **never containing `::`** (`inventoryKey` joins `locationId::itemId`, `state.ts:97`).
  - Simulation namespace: **passthrough** (`canonicalId = key`). Existing ids are preserved, which keeps hashes and the 3D coupling (location/workstation ids are scene object ids).
  - Other sources: default **derived composite** `PREFIX-<sourceId>-<escaped key>`, reversible escaping so distinct keys cannot collide (readable, auditable, no hash width problem).
  - Cross-system equivalence only by explicit **crosswalk** entry (`canonicalId` with aliases, e.g. ERP `1042` and MES `WO-001042`). Crosswalk resolution wins over derivation.
- **Resolution result:** `resolved | unresolved | conflict(candidates)`.
- **Failures.** `unresolved` -> record quarantined `UNRESOLVED_IDENTITY` (recoverable when the map gains the entry). `conflict` (one key -> several canonical ids, or two distinct keys of the same source/type -> one canonical id without declared aliasing) -> `IDENTITY_CONFLICT`, all affected records fail closed. No fuzzy matching, no auto-merge.
- **Reproducibility.** The identity map is a versioned input artifact (`IdentityMap { version, entries[] }`, content-hashed). Adapters are pure functions of `(raw, identityMap, context)`. Provenance records `identityMapVersion`, `adapterVersion`, `schemaVersion` and `rawHash`. Newly derived ids are returned as `derivedMappings` for audit. Same inputs yield byte-identical output.
- **Deliberately not built:** survivorship rules, MDM UI, probabilistic matching, tenant enforcement (the `scope` fields exist so key shape never changes later).
- **Known coupling (deferred):** location/workstation canonical ids are 3D scene ids today. A real source needs a `SceneObjectBinding` (design §5, §6.5); unbound objects must simply not be drawn.

### 7.4 Ingest ledger, ordering and late data

**Contract (illustrative, finalized in M1/M3b)**
```ts
interface IngestLedger { revision: number; entries: LedgerEntry[] }   // every input ever received + its status
interface IngestContext { master: MasterData; initial: FactoryState; ingestedAt: IsoTimestamp; latePolicy: "quarantine" | "reproject" }
function ingest(ledger: IngestLedger, inputs: CanonicalInput[], ctx: IngestContext):
  { ledger: IngestLedger; accepted: AcceptedEvent[]; quarantined: QuarantineRecord[]; unprojected: UnprojectedRecord[]; issues: MappingIssue[]; rewrite?: { fromSequence: number } }
```
- **Set function.** The result depends only on the *set* of ledger entries, `initial`, `master` and the identity map; not on arrival order or `ingestedAt`. Hence re-running ingest over the union of old and new inputs is the **reprojection** operation, and a quarantined record is "recovered" simply by re-evaluation.
- **Idempotency key** `(sourceId, sourceEventId)`. Identical content -> ignored (info `DUPLICATE_IGNORED`). Same key, different `rawHash` -> `DUPLICATE_CONFLICT`: first accepted wins, the other is quarantined (non-recoverable until a correction input exists; corrections are deferred).
- **Deterministic total order** `(occurredAt, sourceId, sourceOrdinal ?? lifecycleRank(type), sourceEventId)`. `lifecycleRank` is a static table derived from the reducer's preconditions (create < release < consume < start < complete ...) so that same-timestamp events from a source without ordinals still order causally. **Acceptance:** for the simulation, this order reproduces the original sequence exactly.
- **Dry run.** Each candidate is applied in order to a shadow state with the atomic reducer. An `InvariantViolation` quarantines the record (`INVARIANT_VIOLATION`, typed codes come in M7) without changing the shadow state; later dependent events then fail too (**cascade**), each recorded. A non-`InvariantViolation` throw marks the shadow state tainted and it is rebuilt from the accepted log (affordable: full replay ≈ 30 ms, `PERFORMANCE.md`).
- **Late data (your 07:55 example).** The ledger tracks a watermark (order key of the last accepted event). An input that sorts before it:
  - `latePolicy: "quarantine"` (default): quarantined `LATE`, **recoverable**, retained; accepted history is not rewritten; revisions are append-only.
  - `latePolicy: "reproject"` (explicit operation): re-ingest the union; the late event is placed in order, later dependents are re-evaluated, `revision` increments and `rewrite.fromSequence` reports the first changed position. Sequence numbers and `EVT-` ids after that point change.
- **Identity across revisions.** `(sourceId, sourceEventId)` is the stable identity; `EVT-` ids are revision-scoped. Any persisted reference must use source identity. Consumers treat a revision change like the existing `epoch` bump (reset/seek) and rebuild caches.
- **Provenance** is a side table parallel to the accepted log, keyed by position within a revision, so the pinned event shape and fixture are untouched.
- **Documented, not built:** live append into a running `SimulationController`; reconciliation/correction events; persisted ledgers; checkpoints.

**Does rev-1 `ingest()` suffice?** No: it stamped permanent sequences, had no ledger to re-evaluate, no tie rule, and treated late events as plain rejection. This contract replaces it.

### 7.5 Reducer atomicity (smallest safe change)

**Finding (by code reading; M0 proves it).** `applyEventInPlace` validates and mutates interleaved. `lastSequence`/`asOf` advance only at the end (`state.ts:785-786`), so after a throw the state looks consistent with its sequence marker while records are half-changed. `FactoryReplay.step` (`replay.ts:72`) leaves the cursor unchanged but the state mutated; `replayWithGuard` returns that state.

Cases that can mutate, then throw (line references into `state.ts`):
| Event type | Mutation before a possible throw |
| --- | --- |
| `MATERIAL_RECEIVED` (297-321) | per-line PO `receivedQuantity` and inventory moves, then a later line's check fails |
| `PRODUCTION_ORDER_RELEASED` (408-415) | earlier reservations applied, a later material is short (realistic: shortage) |
| `MATERIAL_CONSUMED` (502-512) | earlier materials consumed, a later one fails |
| `PRODUCTION_ORDER_CANCELLED` (429-434), `CUSTOMER_ORDER_CANCELLED` (360-369) | loops of inventory moves |
| `OPERATION_STARTED` (573-576) | first equipment unit marked held, next unit not free |
| `OPERATION_COMPLETED` (603-613) | op completed, station idled, equipment released, **then** `reworkPendingQuantity >= 0` checked |
| `REWORK_REQUESTED` (666-671) | first operation inserted, second fails validation |
| `FINISHED_GOODS_RECEIVED` (686-694) | inventory moved and counters changed, **then** `wipQuantity === 0` checked |
| `SHIPMENT_DISPATCHED` (728-739) | earlier lines shipped, later line fails |
| `MACHINE_FAILED` (751-757) | downtime inserted before the operation lookup can fail |

Malformed payloads can additionally raise `TypeError` mid-loop, bypassing `req`.

**Options**
| Option | Cost | Verdict |
| --- | --- | --- |
| Clone-and-apply per event (what `applyEvent` does) | Measured: `structuredClone` of the final state (5,098 transactions, 223 orders, 1,088 operations) ≈ **26 ms**; per-event cloning over a 4,651-event replay ≈ **~60 s** vs ~30 ms today (~2000x) | Rejected for replay/ingest. Keep as test oracle and convenience wrapper |
| **Validate-before-mutate in the reducer** | O(1) per event; no change to accepted-path behavior | **Recommended** |
| Undo journal / proxy | Intercept every write; hot-path overhead; invasive | Rejected |
| Snapshot-restore touched entities | O(touched) but duplicates the reducer's knowledge in a second place; omissions are silent | Rejected |

**Design**
1. Inventory: replace per-loop `move()` calls with collecting `Movement[]` and a single `applyMoves(state, event, movements)` that validates *all* movements against cumulative deltas per `inventoryKey` before applying any. `move` semantics (0 <= reserved <= onHand, integer deltas, one transaction per movement) are preserved, so "inventory is mutated in one place" still holds.
2. Other cases: hoist every `req` ahead of the first write (compute, check, then apply).
3. Replay/ingest defense in depth: a non-`InvariantViolation` throw means atomicity cannot be trusted -> rebuild from the accepted log. `FactoryReplay` surfaces a fault; `SimulationController` pauses and reports instead of crashing the render loop (M4).
4. **Required invariant I1:** if `applyEventInPlace(S, e)` throws, `S` is deep-equal to its state before the call.

**Where it belongs.** The reducer is the only code that knows its own write set; ingest and replay cannot reproduce that knowledge cheaply or reliably. The guarantee therefore lives in the reducer, is consumed by ingest/replay, and is enforced by tests. The reducer's rules and error messages do not change.

**Rejected events** are represented as `QuarantineRecord { ref, reason: { code, message, class? }, recoverable, firstSeenAt, lastEvaluatedRevision }`. Quarantine is a *status*, not a verdict: records stay in the ledger and are re-evaluated on every re-ingest.

### 7.6 Observations versus domain events

**Question: should adapters always produce `FactoryEvent`?** No. Take the ERP record `{job_number:"WO-1042", status:"COMPLETE", quantity:12, last_modified:"2026-10-16T14:00:00Z"}`. To turn it into reducer-acceptable events an adapter would have to invent `PRODUCTION_ORDER_CREATED` with routing-matching operations (`state.ts:383-391`), exact-BOM reservations (`:407-410`), `MATERIAL_CONSUMED`, `OPERATION_STARTED/COMPLETED` with changeover and equipment, `QUALITY_INSPECTION_COMPLETED` and `FINISHED_GOODS_RECEIVED` with an exact approved quantity. None is known. `last_modified` is a capture time, not a completion time. Therefore:

- **Source business event** (a source states "X happened at T") -> `business_event` input carrying a canonical `EventDraft` (`type`, `timestamp`, `payload`, i.e. `buildEvent`'s arguments). Eligible for ingest and the reducer.
- **Snapshot observation** ("entity E looked like this at `observedAt`") -> `snapshot_observation` with per-field `Known<T>`.
- **CDC change** (row changed at commit time, with ordinal) -> `cdc_change`. Evidence of a data change, not a business event.
- **Canonical domain event** -> the *accepted, sequenced* `FactoryEvent` in the log; an output of ingest, not an input kind.
- **Derived/inferred** -> a separate, named, versioned tier produced downstream with a stated basis. **Deferred.**

**Rules**
- R1 Adapters translate vocabulary, identity, units and time. They never assert business meaning the source did not state.
- R2 Only `business_event` inputs reach the reducer. Snapshot and CDC inputs are retained in the ledger and returned as `unprojected` with info `OBSERVATION_NOT_PROJECTED`.
- R3 A future **interpretation policy** (application layer, not adapter, not reducer) may derive events from observations only per explicit, opt-in rule for a source/entity/transition, emitting events with `origin` and `basis`, and `occurredAt` as a *bounded interval* `(prev.observedAt, this.observedAt]`, never a point.
- R4 Incomplete records contribute to an **ObservedState** read model (latest known per entity, `Known<T> = known | unknown | unsupported`, staleness from `observedAt`), a second projection beside the event-sourced `FactoryState`. Views declare the capabilities they require and show "unavailable" instead of zero.
- R5 The strict event-sourced core and its fixtures are unchanged.

**Smallest provision now (M1):** the `CanonicalInput` union, `InputProvenance.origin`, `SourceCapabilities.inputKinds`, ingest routing of non-business inputs to `unprojected`, and a test that observation inputs never change the accepted log or state. **Deferred:** `ObservedState`, interpretation policies, capability-gated KPIs. Cost of deferring: none, because adapters already emit the union. Cost of not providing it now: a breaking change to every adapter.

Worked example: the ERP record above becomes one `snapshot_observation` (`status: known COMPLETE`, `quantity: known 12`, everything else absent), retained, no event, no state change. Until `ObservedState` exists the dashboard shows nothing for that order. That is the correct outcome.

### 7.7 Source capabilities and provenance (illustrative)
```ts
type InputKind = "business_event" | "snapshot_observation" | "cdc_change";
type Origin = "simulated_event" | "source_business_event" | "cdc_change" | "snapshot_observation" | "manual_correction"; // design §7.1
interface InputProvenance {
  sourceId: string; sourceEventId: string; sourceOrdinal?: number | string;
  occurredAt: IsoTimestamp | null; occurredAtQuality: "reported" | "observed_proxy" | "unknown";
  observedAt: IsoTimestamp | null; ingestedAt: IsoTimestamp; origin: Origin;
  schemaVersion: string; adapterVersion: string; identityMapVersion: string; rawHash: string;
}
interface SourceCapabilities {
  inputKinds: InputKind[]; entities: Partial<Record<EntityType, "full" | "partial" | "none">>;
  ordering: "none" | "per-source-total"; liveUpdates: boolean; historyQuery: boolean;
}
interface MappingIssue { severity: "error" | "warning" | "info"; code: string; sourceRef?: SourceKey | { sourceId: string; sourceEventId: string }; path?: string; message: string }
```
`CLAUDE.md` requires the demo to stay labelled synthetic; the label should derive from `origin`, not be hard-coded (M5).

### 7.8 OperationalView: a transitional compatibility port

```ts
interface OperationalView {                      // TRANSITIONAL — see sunset criteria
  readonly state: Readonly<FactoryState>; readonly master: MasterData;
  readonly now: Date;                            // single "now" (resolves controller-vs-asOf split)
  readonly range: { start: Date; end: Date | null };
  readonly epoch: number;                        // history-discarded / log-revision counter
  readonly dataOrigin: "synthetic" | "observed" | "mixed";
  onEvent(l: (e: FactoryEvent, s: Readonly<FactoryState>) => void): () => void;
  reportingSnapshot(): ReportingSnapshot;
}
```
**Assessment.** It is the right *first* abstraction: it removes `engine.*` reach-through, lets tests inject a stub, and is cheap. It is not the right *last* one:
- `Readonly<FactoryState>` is shallow (nested records stay mutable at type level), compile-time only, and the object is the live state mutated in place (`replay.ts:72`). `reportingSnapshot().state` is the same live object, so a "snapshot" is not one. This is convention, not immutability.
- A deployed backend cannot ship the full state or the applied-event log (`events.slice(0, cursor)`) to the browser.

**Direction (documented, not built).** Each existing analytics function already has the shape of a query: `(snapshot, args) -> result`. The future contract is those *result types*, async, purpose-specific, serializable, immutable:

| Existing function | Future query |
| --- | --- |
| `computeKpis`, `stationMetrics` | `getKpis(window)`, `getStationMetrics(window)` |
| `workOrderSummaries`, `workOrderDetail`, `workOrderTimeline` | `listWorkOrders(filter)`, `getWorkOrder(id)` |
| `workCenterLoad`, `workCenterQueues`, `equipmentLoad` | `getWorkCenterLoad(window)`, `getQueues(asOf)` |
| `goodUnitsThroughput` | `getThroughput(window)` |
| `billsOfMaterials` | `getBoms()` |
| `workstationViews`, `inventoryByLocation` | `getSceneProjection(asOf)` |

Local implementation = the same function over a snapshot wrapped in a promise; remote = HTTP. This matches design §6.4 (`ManufacturingReadModel`). Rev-1's `HistoryQuery.stateAt` is dropped.

**Sunset criteria and guardrails.** The port is removed when UI/graphics consume per-view result types. A ratchet test holds an allowlist of files allowed to read `view.state`/`view.master`; it may only shrink.

### 7.9 Simulation wire schema
`src/sources/simulation/wire.ts`: deliberately different from domain types (snake_case keys, `occurred_at` ISO with explicit `Z`, `qty`, durations in **seconds** converted to integer minutes, status codes such as `RUN/IDLE/DOWN` mapped to domain statuses, source-native event ids, `event_kind` strings). A thin **emitter** converts generator output (`FactoryEvent`) to wire records at the generator's output edge; the generator is not rewritten. `data/generated/` gains wire files. All 22 event types and the initial state/master data are covered, because M4 requires exact parity.

## 8. Incremental plan with acceptance criteria

Each milestone is a separate, reviewable commit/PR. The existing suite stays green at every step. M3a is independent of the wire work and may land immediately after M0.

**M0. Characterization and safety net (tests/docs only)**
- Shared `tests/helpers/snapshot.ts` replacing the 5 hand-built `ReportingSnapshot` literals.
- Pin final-state hash of the canonical fixture replay.
- **Atomicity harness:** an oracle `assertAtomicReject(state, event)` over the **in-place** path plus concrete repros for the highest-risk cases in §7.5, committed as `it.fails` (they pass now *because* the defect exists, and go red when it is fixed, forcing the flip in M3a). A seeded corruption corpus (quantity +1, unknown id, duplicated line, dropped line, wrong location) over the fixture lists any further offenders.
- Record the load-pipeline baseline in `docs/PERFORMANCE.md`: parse time of `events.json` (2.5 MB), `FactoryReplay` construction, full replay, plus the measured clone cost above.
- *Accept:* `npm test` green; no `src/` change; the harness enumerates which event types actually partially mutate (confirming or correcting §7.5).

**M1. Contracts, runtime-validation primitives, observation semantics, identity policy**
- `src/sources/types.ts`: `CanonicalInput` union, `InputProvenance`, `MappingIssue`, `QuarantineRecord`, `SourceCapabilities`, `SourceKey`, `IdentityResolver`, `IdentityMap`, `Known<T>`; time-semantics docs; id charset rule.
- Identity: passthrough and derived-composite resolvers with reversible escaping; conflict detection. No crosswalk file format yet.
- Validation primitives (decision D1) with `MappingIssue` output; validators never throw.
- Place `src/sources` under the **strict** tsconfig.
- *Accept:* compiles under `typecheck`; negative tests (missing field, wrong unit, unknown status, bad timestamp) return issues, never throw; derived ids are stable, collision-free for adversarial keys and never contain `::`; type-level test that `ingest` input accepts all three kinds; bundle-size impact of the chosen validator measured and recorded (budget in §13).

**M2. Simulation wire format, emitter, adapter** (split: 2a initial state/master, 2b events)
- *Accept:* `adapter(emit(x))` deep-equals `x` for the initial state and every event; **conversions actually occur** (a test asserts the wire form differs: seconds vs minutes, status codes, key names, timestamp form); generator `eventLogHash` and fixture hash `6ed76381` unchanged; `validate:data` green; provenance `origin: "simulated_event"`.

**M3a. Atomic reducer (own PR; pinned contract)**
- Validate-before-mutate as in §7.5; `applyMoves` batch primitive; hoisted `req`s.
- *Accept:* all M0 `it.fails` flipped to passing tests; corruption corpus passes over the fixture and the default dataset; fixture hash `6ed76381`, generator hash and `validate:data` byte-identical (no accepted-path behavior change); full replay within the `PERFORMANCE.md` 2x rule (target: unchanged); `move` remains the only inventory mutator.

**M3b. Ingest: ledger, ordering, late-data policy, quarantine**
- Depends on M1, M3a.
- *Accept:* idempotent (re-ingesting the same set changes nothing); **order-independent** (property test over N shuffled arrival orders yields identical results); **simulation parity** (ingest of emitted sim inputs reproduces the original events with identical ids, sequences and hash); tie rule tests incl. same-millisecond events and a source without ordinals; late event -> `LATE` quarantine and, under `reproject`, `revision+1` with the documented `rewrite.fromSequence`; an invariant-violating event leaves state equal to the same run without it, with cascade recorded; `ingestedAt` variation never changes output; non-business inputs land in `unprojected` and leave the accepted log untouched; tainted-shadow rebuild path tested.

**M4. Route the app through the boundary (the stated milestone)**
- `loadSimulationData` -> `loadSource(adapter)` -> ingest -> existing `SimulationController`. Controller catches replay faults and pauses with a visible message. `epoch` doubles as log-revision counter.
- *Accept:* identical dashboard/explorer/3D numbers at 3 fixed seek points before/after (KPI parity); simulation produces **zero quarantine and zero error issues** (otherwise the app fails loudly); all CI commands green; import-boundary test: nothing outside `src/sources/simulation` and `scripts` imports the sim wire schema; **load budget** met (§13).

**M5. OperationalView (transitional) and leak fixes**
- Controller implements the port; `Dashboard`, `PlaybackToolbar`, `OperationsExplorer`, `SceneManager` take it; `engine.*` access removed; single `now` passed to `workstationViews`/`WipBuffers`; `dataOrigin` drives the "Synthetic" label.
- Fix `WORK_CENTER_NAMES` import: use `master.workCenters` (behavior-preserving).
- Document transitional status, sunset criteria and the query table (§7.8).
- *Accept:* import-boundary test (`src/ui`, `src/graphics` do not import `src/simulation/*` or reach `engine`); ratchet allowlist test; a stub `OperationalView` drives a UI/analytics test; behavior identical to M4.

**M6. Second adapter and imperfect-data fixtures**
- Hand-authored JSON in a *different* shape (small MES-like export plus an ERP-like snapshot export) under `tests/fixtures/sources/`; crosswalk table implemented here; source selection by config.
- *Accept:* every row of the §9 matrix has a pinned expected outcome; app boots from the fixture source with the simulation module absent from the module graph; analytics suite runs on a fixture-sourced snapshot and `validateDataset`'s replay checks hold on the accepted log; cross-source identity equivalence and collision tests pass; **if any edit to `analytics/`, `ui/` or `graphics/` is needed, the boundary is cosmetic and the milestone fails.**

**M7. Hardening and strategy**
- Typed rejection codes with a `class` (`INTEGRITY` vs `PLAN_CONFORMANCE`) replacing `INVARIANT_VIOLATION`; reconciliation/reprojection strategy document (diff report of status changes after a revision); recorded performance results against budgets; decision on a reducer *ruleset profile* (D6); checkpoint design note; `STATUS.md` update; `SCHEMA_VERSION` bump + migration note only if canonical shapes changed.
- *Accept:* codes exhaustively mapped (unknown reducer message fails a test); results recorded in `PERFORMANCE.md`; docs consistent with code.

## 9. Messy-data outcome matrix (M6)

Outcomes: **A** accepted/normalized, **Q** accepted with qualification, **QR** quarantined (recoverable), **R** rejected with typed issue, **O** retained as observation (not fabricated into events). The criterion is predictable, transparent handling without corrupting state, not that messy data becomes valid.

| # | Case | Layer | Outcome | Code | Assertion |
| --- | --- | --- | --- | --- | --- |
| 1 | Duplicate event, identical content | ingest | A (once) | `DUPLICATE_IGNORED` (info) | log unchanged |
| 2 | Same id, different content | ingest | Q: first wins, second quarantined | `DUPLICATE_CONFLICT` | state from first only |
| 3 | Unknown status code | adapter | R | `UNKNOWN_STATUS` | no default status; record not mapped |
| 4 | Missing optional `observedAt` | adapter | A | none | `observedAt: null`, not zero or `now` |
| 5 | Missing `occurredAt` + declared proxy rule | adapter | Q | `OCCURRED_AT_PROXY` (warning) | `occurredAtQuality: observed_proxy` |
| 6 | Missing `occurredAt`, no rule | adapter | O | `UNPLACEABLE_TIME` | no event created |
| 7 | Late valid record (the 07:55 case) | ingest | QR | `LATE` | recovered by `reproject`; history not rewritten under default policy |
| 8 | Conflicting external ids | identity | QR | `IDENTITY_CONFLICT` | no event for either key |
| 9 | Unknown unit of measure | adapter | R | `UNKNOWN_UOM` | no guessed conversion |
| 10 | Incomplete WO history (start without create) | reducer via ingest | QR + cascade | `INVARIANT_VIOLATION` (typed in M7) | order absent from state; chain recorded |
| 11 | Malformed record mixed with valid | adapter | R for the bad record, rest A | `SCHEMA_INVALID` with `path` | batch not aborted |
| 12 | Unsupported schema major / non-JSON envelope | adapter | R whole source | `SOURCE_UNSUPPORTED_VERSION` | nothing ingested |
| 13 | Reference to not-yet-known entity | reducer via ingest | QR | `INVARIANT_VIOLATION` / `UNRESOLVED_IDENTITY` | accepted when a later batch supplies the entity |
| 14 | Source lacks inventory (partial capability) | adapter | A, plus capability | capabilities say `inventory: none` | no balances fabricated; no zero rows |
| 15 | ERP-style `COMPLETE` snapshot row | ingest | O | `OBSERVATION_NOT_PROJECTED` (info) | accepted log and state unchanged |
| 16 | Unknown event kind | adapter | R, counted | `UNSUPPORTED_EVENT_KIND` | surfaced, not silently dropped |
| 17 | Negative quantity / non-integer cents | adapter | R | `SCHEMA_INVALID` | domain conventions enforced at the edge |
| 18 | Real-MES variance (actual setup differs from table) | reducer via ingest | QR | `PLAN_CONFORMANCE` (M7 class) | demonstrates D6, not a data defect |

## 10. Architectural decisions and deferred capabilities

| Capability | Now (implemented) | Defined now, implemented later | Explicitly deferred |
| --- | --- | --- | --- |
| Atomic reject | Reducer validate-before-mutate (M3a) | | |
| Runtime validation | Adapter validators (M1/M2/M6) | | Schema registry / evolution tooling |
| Provenance | Side table, time fields, adapter/identity versions | | Persistent audit store |
| Ordering and ingest | Set-function ledger, tie rule, dedupe, quarantine (M3b) | Live append into a running controller | Streaming/transport |
| Late data | `LATE` quarantine; `reproject` as a function | Revision hot-swap, diff report | Automatic reprojection, persistence |
| Identity | `SourceKey`, resolvers, crosswalk, conflict rules | `SceneObjectBinding` for 3D | MDM, fuzzy matching, tenant enforcement |
| Observations | Input union, routing to `unprojected`, capabilities | `ObservedState`, `Known<T>` projection, interpretation policy, capability-gated KPIs | Derived/inferred tier, forecasts |
| Read-model port | `OperationalView` (transitional) | Result-typed async queries | Backend, API, auth |
| Reducer policy | Strict profile (unchanged) | Rejection `class`; ruleset profile decision | A relaxed "recording" profile |
| Calendars | Hard-coded shift constant stays | Calendar as master data | Per-site calendars |
| Infrastructure | none | | Database, broker, cloud, workers |

## 11. Design rationale

| Decision | Solves | Layer | Alternatives | Complexity | Real, not cosmetic, because |
| --- | --- | --- | --- | --- | --- |
| Domain types stay canonical | No second vocabulary; fixtures intact | `manufacturing` | Separate neutral contracts | Heavy adapters for sparse sources | M6 shapes differ from sim and still map |
| `CanonicalInput` union | Avoids locking sources into event semantics; no fabricated history | `sources` | Always `FactoryEvent` | One routing branch | Observation test: log unchanged |
| Atomicity in the reducer | I1 for every caller at O(1) cost | `manufacturing` | Clone (60 s), journal, restore | Refactor of ~11 cases | Corruption corpus + flipped M0 tests |
| Ledger set-function ingest | Dedupe, late data, recovery, reprojection by one mechanism | `sources` | Stateful stamping | Ledger structure | Shuffle/idempotence property tests |
| Injected `ingestedAt` | Determinism | `sources` | `Date.now()` | One context field | Ordering/hashes invariant under it |
| Passthrough + derived + crosswalk ids | Reproducible identity without MDM | `sources` | Hash ids; DB mapping tables | Small resolver | Collision/conflict tests |
| Independent sim wire + emitter | Adapter performs real translation | `sources/simulation` | Envelope only; ERP tables | Extra schema | Conversion assertions; boundary test |
| Transitional `OperationalView` | Decouples UI from controller now | `simulation`/app | Query hierarchy now | Refactor of 4 UI files | Stub-driven test; ratchet |
| Result-typed query direction | Keeps a backend from shipping state | docs | `stateAt` | None now | Table maps to existing functions |

## 12. Decisions requiring your approval (recommendations first)

- **D1. Validation library.** Recommend **zod** scoped to `src/sources`, gated on a measured bundle/load budget (§13). Alternative: hand-written validators, no dependency, more code to maintain across 22 event types. `CLAUDE.md` says no framework without need; the need is one definition for types and parsing.
- **D2. Split M3 into M3a/M3b and allow M3a right after M0.** Recommend yes: the reducer is the pinned contract and the riskiest change; it is independent of the wire work.
- **D3. Late-data default.** Recommend `quarantine` (append-only revisions); `reproject` is an explicit operation. Alternative: auto-reproject (rewrites ids/sequences under a running UI).
- **D4. Canonical id form for non-sim sources.** Recommend readable composite with reversible escaping and a crosswalk override. Alternative: hashed ids (opaque, needs ≥64-bit hash; the repo's `fnv1a` is 32-bit).
- **D5. Observation provision in M1.** Recommend union + routing + test only. Alternatives: docs only (cheaper, risks an adapter-contract break later) or full `ObservedState` now (premature).
- **D6. Reducer rule profile.** Recommend: define the `INTEGRITY` vs `PLAN_CONFORMANCE` classes in M7 and decide whether a "recording" profile is needed when the first real-MES-shaped fixture exists. Do not relax the reducer now.
- **D7. Performance budgets (to ratify after M0 baseline).** Proposed: steady-state rows in `PERFORMANCE.md` within 2x; added one-time load work (wire parse + validate + adapt + ingest) ≤ ~300 ms on the Node baseline for the default dataset and no additional long task > 500 ms in the browser; wire files ≤ 1.5x `events.json`.
- **D8. Carried over:** default source in the app (simulation, fixtures behind a flag); shift calendar as master data (defer); domain-purity leaks (`masterData.ts` -> layout, `selectors.ts` -> graphics type, generator in the barrel) as a separate small PR after M5.

## 13. Risks, failure modes, testing strategy, performance

**Risks**
1. Atomicity is enforced by discipline in a 600-line `switch`. Mitigation: corruption corpus on every CI run; M0 oracle; rebuild on unexpected throw.
2. Cascade quarantine: one poisoned event hides a whole order's later events. Correct (no fabricated history) but must be visible; a data-health surface is deferred, so counts are reported through `QuarantineRecord`s now.
3. Reducer policy rules reject real variance (R-policy, D6).
4. Revision-scoped `EVT-` ids: persisted references must use source identity.
5. M2 is the largest milestone (22 event types plus master data); split 2a/2b and make mapping table-driven.
6. Cosmetic boundary: emitter/adapter collapsing to identity. Mitigation: conversion assertions; M6 must pass without analytics/UI edits.
7. Load-time cost: the worst frames already occur at parse time (280-840 ms, `PERFORMANCE.md`); validation and shadow replay add to it. Mitigation: D7 budget; lazy or chunked validation is a fallback, not a plan.
8. State growth: `inventoryTransactions` is append-only (5,098 entries / 3.6 MB at 4.6k events); a backend must not ship it. Checkpointing deferred.
9. Two projections (event-sourced + observed) could double UI work. Gated: `ObservedState` is not built until a snapshot-only source is real.
10. Type-safety gap: `ui`, `graphics`, `simulation`, `analytics` are non-strict; new `src/sources` is strict.
11. Contract drift: canonical shape changes need fixture update, `SCHEMA_VERSION` bump and migration note (`CLAUDE.md`).

**Testing strategy** (each claim has a test): source independence (import-boundary tests, second adapter, analytics on a fixture-sourced snapshot); runtime validation (negative tests); normalization (unit/time/status conversion assertions); event replay (determinism, hash parity, round trip); domain invariants (`validateDataset` over ingest output, atomic-reject oracle); ordering (shuffle invariance, ties, lifecycle rank, sim identity); late data and recovery; identity (determinism, collision, conflict, cross-source equivalence); observations (never fabricate events or state); messy-data matrix (§9); transitional-port ratchet.

**Performance baseline reused** (`docs/PERFORMANCE.md`): full replay ~30 ms, seek 50%/100% ~11/28 ms, KPIs ~4 ms, 4,651 events. Rule: a >2x regression in any row is investigated. Measured now: `structuredClone(final state)` ≈ 26 ms (the reason clone-per-event is rejected). Benchmarks are recorded, not asserted in CI (wall-clock flakiness).

## 14. Verification, critical files, reporting

```bash
npm test && npm run typecheck && npm run typecheck:app && npm run validate:data && npm run build
npm run dev   # manual: compare KPI cards at 3 fixed seek points against the pre-change baseline
```

**Critical files:** `src/manufacturing/{state,replay,events,types,rules,selectors,validation}.ts`,
`src/simulation/{loadSimulationData,SimulationController,reportingSnapshot}.ts`, `src/analytics/{types,workOrders}.ts`,
`src/ui/{Dashboard,PlaybackToolbar}.ts`, `src/ui/explorer/OperationsExplorer.ts`, `src/graphics/SceneManager.ts`,
`src/main.ts`, `scripts/{generate,validate}.ts`, `tests/contract.test.ts`, `tests/manufacturing.test.ts`;
new: `src/sources/**`, `tests/helpers/snapshot.ts`, `tests/fixtures/sources/**`.

**Report on completion of each milestone (per `CLAUDE.md`):** what changed, contracts changed (none through M6 by
design), migration notes, tests run, what remains hypothetical (`ObservedState`, interpretation policy, result-typed
queries, live append, persistence).
