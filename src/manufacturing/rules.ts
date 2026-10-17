/**
 * Shop-floor rules shared by the generator (choosing what to start) and the reducer (rejecting what may not):
 * sequence-dependent setup and equipment pooling. Pure functions of master data and state.
 */
import type { Equipment, EquipmentKind, FactoryState, Id, MasterData, Minutes, ProductionOperation } from "./types.ts";

/**
 * Setup for running `toProductId` at a work center after `fromProductId` (undefined = the station has no history).
 * Returns undefined when no rule applies, in which case the operation's standard setup is used.
 */
export function changeoverSetup(
  master: Pick<MasterData, "changeovers">,
  workCenterId: Id | undefined,
  fromProductId: Id | undefined,
  toProductId: Id,
): Minutes | undefined {
  if (!workCenterId || !fromProductId || !master.changeovers) return undefined;
  return master.changeovers.find((r) => r.workCenterId === workCenterId && r.fromProductId === fromProductId && r.toProductId === toProductId)
    ?.setupMinutes;
}

/** Operations a changeover applies to: ordinary routing steps, not rework (rework has its own fixed setup). */
export function usesChangeover(op: Pick<ProductionOperation, "isRework">): boolean {
  return !op.isRework;
}

/** Equipment currently held by an operation. */
export function isEquipmentBusy(state: Pick<FactoryState, "equipment">, equipmentId: Id): boolean {
  return Boolean(state.equipment?.[equipmentId]?.currentOperationId);
}

/**
 * One free unit per required kind, lowest id first (deterministic), or undefined when any kind is exhausted.
 * No requirement, or master data without equipment, resolves to an empty list.
 */
export function pickEquipment(
  master: Pick<MasterData, "equipment">,
  state: Pick<FactoryState, "equipment">,
  required: readonly EquipmentKind[] | undefined,
): Id[] | undefined {
  if (!required || required.length === 0 || !master.equipment) return [];
  const taken = new Set<Id>();
  for (const kind of required) {
    const unit = master.equipment.find((e: Equipment) => e.kind === kind && !taken.has(e.id) && !isEquipmentBusy(state, e.id));
    if (!unit) return undefined;
    taken.add(unit.id);
  }
  return [...taken];
}

/** Kinds from `required` that have no free unit right now (empty when the operation could get its equipment). */
export function missingEquipmentKinds(
  master: Pick<MasterData, "equipment">,
  state: Pick<FactoryState, "equipment">,
  required: readonly EquipmentKind[] | undefined,
): EquipmentKind[] {
  if (!required || !master.equipment) return [];
  const used = new Set<Id>();
  const missing: EquipmentKind[] = [];
  for (const kind of required) {
    const unit = master.equipment.find((e) => e.kind === kind && !used.has(e.id) && !isEquipmentBusy(state, e.id));
    if (unit) used.add(unit.id);
    else missing.push(kind);
  }
  return missing;
}
