import * as THREE from "three";

import type { OperationalStatus } from "./FactoryObject";
import type { FactoryObjectConfig } from "./FactoryObject";
import type { Overlay } from "../analytics/overlays";
import { inventoryByLocation, workstationViews } from "../manufacturing/selectors";
import type { FactoryState, MasterData } from "../manufacturing/types";
import { WipBuffers } from "./WipBuffers";

const STATUS_COLORS: Record<OperationalStatus, THREE.Color> = {
  idle: new THREE.Color("#64748b"),
  running: new THREE.Color("#22c55e"),
  blocked: new THREE.Color("#f59e0b"),
  down: new THREE.Color("#ef4444"),
};

/** Storage-style locations, coloured by how full their pallet space is. */
const FILL_COLORS = {
  empty: new THREE.Color("#64748b"),
  normal: new THREE.Color("#22c55e"),
  high: new THREE.Color("#f59e0b"),
  full: new THREE.Color("#ef4444"),
};

/** Layout objects the dataset has no workstation for (e.g. unstaffed line). */
const OFFLINE_COLOR = new THREE.Color("#334155");

/** Analytical overlays: objects the overlay does not highlight are muted, highlighted ones run from a cool base to a mode colour. */
const OVERLAY_MUTED = new THREE.Color("#1f2d44");
const OVERLAY_COOL = new THREE.Color("#3b5b86");
const OVERLAY_HOT: Record<Overlay["mode"], THREE.Color> = {
  queue: new THREE.Color("#ffb454"),
  utilization: new THREE.Color("#2ee6a6"),
  shortage: new THREE.Color("#ff5c7a"),
};

const HIGH_FILL = 0.7;
const FULL_FILL = 0.95;

/** The colour that marks an object as highlighted by an overlay of this mode (used for label outlines). */
export const overlayAccent = (mode: Overlay["mode"]): string => `#${OVERLAY_HOT[mode].getHexString()}`;

/** Translates manufacturing state into visual changes on the scene. */
export class FactoryVisualizer {
  private readonly objectsById: ReadonlyMap<string, THREE.Mesh>;
  private readonly parent: THREE.Object3D | null;
  private wip: WipBuffers | null = null;
  private overlayColors: Map<string, THREE.Color> | null = null;

  constructor(objectsById: ReadonlyMap<string, THREE.Mesh>, parent: THREE.Object3D | null = null) {
    this.objectsById = objectsById;
    this.parent = parent;
  }

  /** Single entry point: refresh every simulated object from state. */
  public update(state: Readonly<FactoryState>, master: MasterData, nowMs?: number, overlay: Overlay | null = null): void {
    this.setOverlay(overlay);
    this.updateWorkstations(state, master);
    this.updateLocations(state, master);
    this.updateQueues(state, master, nowMs);
  }

  /** With an overlay, every station and location is recoloured from it (muted when not highlighted); null restores status colours. */
  private setOverlay(overlay: Overlay | null): void {
    if (!overlay) {
      this.overlayColors = null;
      return;
    }
    const hot = OVERLAY_HOT[overlay.mode];
    this.overlayColors = new Map(overlay.cells.map((c) => [c.objectId, OVERLAY_COOL.clone().lerp(hot, c.intensity)]));
  }

  /** The colour to draw: the overlay's when one is active, otherwise the status colour. */
  private shown(id: string, statusColor: THREE.Color): THREE.Color {
    if (!this.overlayColors) return statusColor;
    return this.overlayColors.get(id) ?? OVERLAY_MUTED;
  }

  /** Work-center queue buffers; built on first use because lanes come from master data. */
  private updateQueues(state: Readonly<FactoryState>, master: MasterData, nowMs?: number): void {
    if (!this.parent) return;
    if (!this.wip) {
      const stations = new Map<string, FactoryObjectConfig>();
      for (const [id, mesh] of this.objectsById) {
        const config = mesh.userData.factoryObject as FactoryObjectConfig | undefined;
        if (config) stations.set(id, config);
      }
      this.wip = new WipBuffers(stations, master);
      this.parent.add(this.wip.group);
    }
    this.wip.update(state, master, nowMs);
  }

  /**
   * Every layout object that is not a workstation: storage objects follow
   * pallet utilization; production cells with no workstation show as offline.
   */
  public updateLocations(
    state: Readonly<FactoryState>,
    master: MasterData,
  ): void {
    const workstationIds = new Set(master.workstations.map((w) => w.id));
    const inventory = inventoryByLocation(state as FactoryState, master);

    for (const location of master.locations) {
      if (workstationIds.has(location.id)) continue;

      const mesh = this.objectsById.get(location.id);
      if (!mesh) continue;

      const isProduction =
        location.kind === "ASSEMBLY" || location.kind === "QUALITY";

      if (isProduction) {
        this.apply(mesh, this.shown(location.id, OFFLINE_COLOR), "idle", 0);
        continue;
      }

      const fill = inventory[location.id]?.utilization ?? 0;

      const color =
        fill <= 0 ? FILL_COLORS.empty
        : fill >= FULL_FILL ? FILL_COLORS.full
        : fill >= HIGH_FILL ? FILL_COLORS.high
        : FILL_COLORS.normal;

      const status: OperationalStatus =
        fill <= 0 ? "idle" : fill >= FULL_FILL ? "blocked" : "running";

      this.apply(mesh, this.shown(location.id, color), status, fill);
    }
  }

  public updateWorkstations(
    state: Readonly<FactoryState>,
    master: MasterData,
  ): void {
    for (const view of workstationViews(state, master)) {
      const mesh = this.objectsById.get(view.workstationId);
      if (!mesh) continue;

      this.apply(
        mesh,
        this.shown(view.workstationId, STATUS_COLORS[view.objectStatus]),
        view.objectStatus,
        view.utilization,
      );
    }
  }

  private apply(
    mesh: THREE.Mesh,
    color: THREE.Color,
    status: OperationalStatus,
    utilization: number,
  ): void {
    const material = mesh.material;
    if (!(material instanceof THREE.MeshStandardMaterial)) return;

    // Status colour is the base; an active hover/selection overlay wins
    // visually and is restored to this base when it clears.
    const overlay = mesh.userData.highlightColor as string | undefined;
    if (overlay) material.color.set(overlay);
    else material.color.copy(color);

    mesh.userData.baseColor = color;

    // Keep the details panel in sync with the simulation.
    const config = mesh.userData.factoryObject as
      FactoryObjectConfig | undefined;
    if (config) {
      config.status = status;
      config.utilization = utilization;
    }
  }
}
