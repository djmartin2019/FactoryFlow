import * as THREE from "three";

import { workCenterQueues } from "../analytics/workCenters";
import { inShift } from "../manufacturing/calendar";
import { BUFFER_SLOTS, bufferPad, bufferSlots, leadStations, type BufferSlot } from "../data/queueBuffers";
import type { FactoryObjectConfig } from "./FactoryObject";
import { decalMaterial, flatRect, makeNonInteractive } from "./geometryUtils";
import type { FactoryState, MasterData } from "../manufacturing/types";

/** Product colours, distinct from the status palette. Index = product order in master data. */
export const PRODUCT_COLORS = [0x60a5fa, 0xa78bfa, 0xf472b6, 0x38bdf8, 0xc084fc];

const PAD_Y = 0.05;
const PAD_IDLE = new THREE.Color("#475569");
const PAD_BOTTLENECK = new THREE.Color("#ffb454");
const BOX = 0.62;
/** Product colours are scaled by this while the plant is off shift. */
const OFF_SHIFT_DIM = 0.35;

interface Pad {
  mesh: THREE.Mesh;
  slots: BufferSlot[];
  workCenterIds: string[];
}

/**
 * Work-center input queues drawn as stacks of boxes on a pad beside the lead
 * station. Read-only: everything comes from `workCenterQueues`, the same
 * definition the Work Centers table uses, so the amber pad is the flagged row.
 */
export class WipBuffers {
  public readonly group = new THREE.Group();
  private readonly pads: Pad[] = [];
  private readonly boxes: THREE.InstancedMesh;
  private readonly productColor = new Map<string, THREE.Color>();
  private readonly color = new THREE.Color();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();

  constructor(stations: ReadonlyMap<string, FactoryObjectConfig>, master: MasterData) {
    this.group.name = "wip-buffers";
    master.products.forEach((p, i) => this.productColor.set(p.id, new THREE.Color(PRODUCT_COLORS[i % PRODUCT_COLORS.length])));

    const leads = leadStations(master.workstations);
    const ledBy = new Map<string, string[]>();
    for (const [wc, stationId] of leads) ledBy.set(stationId, [...(ledBy.get(stationId) ?? []), wc]);

    for (const [stationId, workCenterIds] of ledBy) {
      const config = stations.get(stationId);
      if (!config) continue;
      const rect = bufferPad(config);
      const mesh = new THREE.Mesh(flatRect(rect, PAD_Y), decalMaterial({ color: PAD_IDLE, transparent: true, opacity: 0.55 }, 7));
      mesh.renderOrder = 5;
      this.group.add(mesh);
      this.pads.push({ mesh, slots: bufferSlots(rect, workCenterIds), workCenterIds });
    }

    const capacity = Math.max(1, this.pads.reduce((n, p) => n + p.slots.length, 0), BUFFER_SLOTS);
    this.boxes = new THREE.InstancedMesh(
      new THREE.BoxGeometry(BOX, 1, BOX),
      new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.05 }),
      capacity,
    );
    this.boxes.count = 0;
    this.boxes.castShadow = true;
    this.boxes.receiveShadow = true;
    this.group.add(this.boxes);
    makeNonInteractive(this.group);
  }

  /**
   * `nowMs` is the simulation clock, which runs ahead of the last applied event; off shift the
   * queues are drawn faded because nothing can start until the next shift.
   */
  public update(state: Readonly<FactoryState>, master: MasterData, nowMs: number = Date.parse(state.asOf)): void {
    const shiftOpen = inShift(nowMs);
    const queues = new Map(workCenterQueues(state, master, nowMs).map((q) => [q.workCenterId, q]));
    let used = 0;

    for (const pad of this.pads) {
      let bottleneck = false;
      let overflow = false;
      for (const wc of pad.workCenterIds) {
        const q = queues.get(wc);
        if (!q) continue;
        bottleneck ||= q.isBottleneck;
        const slots = pad.slots.filter((s) => s.workCenterId === wc);
        overflow ||= q.queue.length > slots.length;
        q.queue.slice(0, slots.length).forEach((step, i) => {
          const height = Math.min(1.0, 0.3 + 0.12 * step.units);
          this.position.set(slots[i].x, 0.06 + height / 2, slots[i].z);
          this.scale.set(1, height, 1);
          this.matrix.compose(this.position, this.quaternion, this.scale);
          this.boxes.setMatrixAt(used, this.matrix);
          this.color.copy(this.productColor.get(step.productId) ?? PAD_IDLE);
          if (!shiftOpen) this.color.multiplyScalar(OFF_SHIFT_DIM);
          this.boxes.setColorAt(used, this.color);
          used++;
        });
      }
      const material = pad.mesh.material as THREE.MeshBasicMaterial;
      material.color.copy(bottleneck ? PAD_BOTTLENECK : PAD_IDLE);
      material.opacity = !shiftOpen ? 0.3 : bottleneck ? 0.8 : overflow ? 0.85 : 0.55;
    }

    this.boxes.count = used;
    this.boxes.instanceMatrix.needsUpdate = true;
    if (this.boxes.instanceColor) this.boxes.instanceColor.needsUpdate = true;
  }
}
