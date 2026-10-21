/**
 * Atomicity harness for the in-place reducer (M0 of docs/SOURCE_INTEGRATION_PLAN_REV3.md, section 7.6).
 *
 * `assertAtomicReject` is the oracle: apply an event with `applyEventInPlace`, expect it to throw, then require the
 * whole state (including `lastSequence`/`asOf`) to be deep-equal to a copy taken beforehand. The corpus holds, per
 * `EventType`, scenarios built from real events of the default dataset by editing the state and/or the event.
 * An entry flagged `knownPartial` is one where the legacy reducer is known to mutate before throwing; the test
 * suite runs those under `it.fails`, so they go red (and must be flipped) when M3a fixes them.
 */
import { expect } from "vitest";
import { eventIdFor } from "../../src/manufacturing/events.ts";
import { generateDataset } from "../../src/manufacturing/generator.ts";
import { applyEventInPlace, inventoryKey } from "../../src/manufacturing/state.ts";
import type {
  EventType,
  FactoryEvent,
  FactoryState,
  ManufacturingDataset,
} from "../../src/manufacturing/types.ts";

type Reducer = (state: FactoryState, event: FactoryEvent, master: ManufacturingDataset["master"]) => void;

export interface Scenario {
  state: FactoryState;
  event: FactoryEvent;
}

export interface CorpusEntry {
  name: string;
  /** Builds a fresh scenario each call (states are mutated by the reducer). */
  build: () => Scenario;
  /** "reject" unless the legacy reducer is known to accept this (pinned as a characterization). */
  expected?: "reject" | "accept";
  /** The legacy reducer mutates the state before throwing on this entry. */
  knownPartial?: boolean;
  /** Which section 7.6 intra-event cumulative case this covers, if any. */
  cumulative?: string;
}

export type Corpus = Record<EventType, CorpusEntry[]>;

let cached: ManufacturingDataset | undefined;
/** The default dataset (seed larkhaven-2026), generated once per test file. */
export function dataset(): ManufacturingDataset {
  return (cached ??= generateDataset());
}

/** State immediately before `events[index]`. */
export function stateBefore(index: number): FactoryState {
  const d = dataset();
  const state = structuredClone(d.initialState);
  for (let i = 0; i < index; i++) applyEventInPlace(state, d.events[i], d.master);
  return state;
}

type Of<T extends EventType> = Extract<FactoryEvent, { type: T }>;

/** The `nth` dataset event of `type` that satisfies `pick`, as a scenario: state before it plus a private copy. */
export function pickEvent<T extends EventType>(type: T, pick: (e: Of<T>, state: FactoryState) => boolean = () => true, nth = 0) {
  const d = dataset();
  const state = structuredClone(d.initialState);
  let seen = 0;
  for (const e of d.events) {
    if (e.type === type && pick(e as Of<T>, state)) {
      if (seen++ === nth) return { state, event: structuredClone(e) as Of<T> };
    }
    applyEventInPlace(state, e, d.master);
  }
  throw new Error(`corpus: no ${type} event matches (nth=${nth})`);
}

/** The same event delivered again right after it was applied (new sequence, same timestamp). */
export function redelivered<T extends EventType>(type: T, pick?: (e: Of<T>, state: FactoryState) => boolean): { state: FactoryState; event: Of<T> } {
  const { state, event } = pickEvent(type, pick);
  applyEventInPlace(state, event, dataset().master);
  const again = structuredClone(event);
  again.sequence = state.lastSequence + 1;
  again.id = eventIdFor(again.sequence);
  return { state, event: again };
}

/** Make sure a balance exists with exact quantities. */
export function setBalance(state: FactoryState, locationId: string, itemId: string, kind: "RAW_MATERIAL" | "FINISHED_GOOD", onHand: number, reserved: number) {
  state.inventory[inventoryKey(locationId, itemId)] = { locationId, itemId, itemKind: kind, onHand, reserved };
}

export function expectDeepEqualState(before: FactoryState, after: FactoryState): void {
  expect(after).toEqual(before);
}

export type Outcome = { decision: "accept" } | { decision: "reject"; message: string; mutated: boolean };

/** Run the reducer in place and report the decision, the exact error message and whether state changed. */
export function observe(scenario: Scenario, reducer: Reducer = applyEventInPlace): Outcome {
  const before = structuredClone(scenario.state);
  try {
    reducer(scenario.state, scenario.event, dataset().master);
  } catch (err) {
    // Compare by name: the frozen legacy reducer defines its own InvariantViolation class.
    const message = (err as Error).name === "InvariantViolation" ? (err as Error).message : `${(err as Error).name}: ${(err as Error).message}`;
    return { decision: "reject", message, mutated: !sameShape(before, scenario.state) };
  }
  return { decision: "accept" };
}

/** Oracle: the in-place path must throw and leave the state untouched. */
export function assertAtomicReject(scenario: Scenario, reducer: Reducer = applyEventInPlace): void {
  const before = structuredClone(scenario.state);
  expect(() => reducer(scenario.state, scenario.event, dataset().master)).toThrow();
  expectDeepEqualState(before, scenario.state);
}

// Structural equality without vitest's matcher machinery (used where we only need a boolean).
function sameShape(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b as object, k)) return false;
    if (!sameShape((a as never)[k], (b as never)[k])) return false;
  }
  return true;
}
