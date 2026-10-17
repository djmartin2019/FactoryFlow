/**
 * Simulation wire schema (plan 7.11): deliberately different from the domain types so the adapter does real work.
 *  - keys are snake_case (`ordered_qty`, `setup_s`, `occurred_at`); `quantity` is `qty`;
 *  - durations are whole seconds (the domain uses integer minutes);
 *  - timestamps are UTC with an explicit `Z` and no fractional part when the millisecond is zero;
 *  - statuses are short codes (`RUN`, `IDLE`, `DOWN`, `PLN`, ...);
 *  - events carry a source-native id (`SIM-E000123`), an `event_kind` string, the generator's emission position `seq`
 *    (a `causal` ordinal) and a `stream`; the canonical `EVT-` id, `entities` and `sequence` are not on the wire.
 * Everything is described as data in `wireSpec.ts`; this file only names the record shapes.
 */

export const SIM_SOURCE_ID = "sim";
export const SIM_STREAM_ID = "sim";
export const SIM_WIRE_VERSION = "sim-wire/1";

/** One event on the wire. `payload` is spec-encoded; its shape depends on `event_kind`. */
export interface WireEventRecord {
  event_id: string;
  event_kind: string;
  occurred_at: string;
  seq: number;
  stream: typeof SIM_STREAM_ID;
  payload: Record<string, unknown>;
}

/** Master data plus the opening state, as the simulation hands them over. */
export interface WireInitialState {
  wire_version: typeof SIM_WIRE_VERSION;
  /** Version of the domain schema the simulation was generated for (becomes `InitialStateFile.schemaVersion`). */
  domain_schema: string;
  master: Record<string, unknown>;
  state: Record<string, unknown>;
}

/** Source-native event id for an emission position. */
export const wireEventId = (seq: number): string => `SIM-E${String(seq).padStart(6, "0")}`;
