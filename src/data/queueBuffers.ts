/**
 * Where work-center queues are drawn on the floor. Pure geometry (no three.js)
 * so layout tests and the renderer share it.
 *
 * A queue is drawn once per work center, on the pad of its *lead station*: the
 * serving station that serves the fewest work centers (ties: master order), so
 * a flexible station never leads and a shared lane is not drawn twice.
 */
import type { FactoryObjectConfig } from "../graphics/FactoryObject";
import type { FloorRect } from "./layoutTypes";

export const BUFFER_GAP = 0.1;
export const BUFFER_DEPTH = 0.9;
export const BUFFER_SLOTS = 6;

/** Pad on the south side of a station (towards the main aisle), as wide as the station. */
export function bufferPad(station: Pick<FactoryObjectConfig, "position" | "size">): FloorRect {
  const [x, , z] = station.position;
  const [w, , d] = station.size;
  const front = z + d / 2 + BUFFER_GAP;
  return { minX: x - w / 2, maxX: x + w / 2, minZ: front, maxZ: front + BUFFER_DEPTH };
}

export interface LeadCandidate {
  id: string;
  workCenterIds?: string[];
}

/** work center id -> lead station id. */
export function leadStations(stations: readonly LeadCandidate[]): Map<string, string> {
  const lead = new Map<string, { id: string; breadth: number }>();
  for (const s of stations) {
    const ids = s.workCenterIds ?? [];
    for (const wc of ids) {
      const best = lead.get(wc);
      if (!best || ids.length < best.breadth) lead.set(wc, { id: s.id, breadth: ids.length });
    }
  }
  return new Map([...lead].map(([wc, v]) => [wc, v.id]));
}

export interface BufferSlot {
  workCenterId: string;
  x: number;
  z: number;
}

/**
 * Slot centres for the work centers led by one station: the pad is split into
 * equal shares (one per led work center) of `BUFFER_SLOTS / n` slots each.
 */
export function bufferSlots(pad: FloorRect, workCenterIds: readonly string[]): BufferSlot[] {
  if (workCenterIds.length === 0) return [];
  const per = Math.max(1, Math.floor(BUFFER_SLOTS / workCenterIds.length));
  const total = per * workCenterIds.length;
  const pitch = (pad.maxX - pad.minX) / total;
  const z = (pad.minZ + pad.maxZ) / 2;
  return workCenterIds.flatMap((workCenterId, w) =>
    Array.from({ length: per }, (_, i) => ({ workCenterId, x: pad.minX + (w * per + i + 0.5) * pitch, z })),
  );
}
