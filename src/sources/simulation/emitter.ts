/**
 * Emitter: converts generator output (`FactoryEvent`, `InitialStateFile`) to wire records at the generator's output edge.
 * The generator is not rewritten. The emitter is trusted code over trusted data: a domain field the wire spec does not
 * know throws immediately, so a new field cannot silently go missing from the wire.
 */
import type { FactoryEvent, InitialStateFile } from "../../manufacturing/types.ts";
import { SIM_STREAM_ID, SIM_WIRE_VERSION, wireEventId, type WireEventRecord, type WireInitialState } from "./wire.ts";
import { EVENT_KINDS, payloadEntity, simulationCodec } from "./wireSpec.ts";
import { toWireTimestamp } from "./codec.ts";

export function emitInitialState(file: InitialStateFile): WireInitialState {
  return {
    wire_version: SIM_WIRE_VERSION,
    domain_schema: file.schemaVersion,
    master: simulationCodec.encode("MasterData", file.master) as Record<string, unknown>,
    state: simulationCodec.encode("FactoryState", file.state) as Record<string, unknown>,
  };
}

export function emitEvent(event: FactoryEvent): WireEventRecord {
  return {
    event_id: wireEventId(event.sequence),
    event_kind: EVENT_KINDS[event.type],
    occurred_at: toWireTimestamp(event.timestamp),
    seq: event.sequence,
    stream: SIM_STREAM_ID,
    payload: simulationCodec.encode(payloadEntity(event.type), event.payload) as Record<string, unknown>,
  };
}

export function emitEvents(events: readonly FactoryEvent[]): WireEventRecord[] {
  return events.map(emitEvent);
}
