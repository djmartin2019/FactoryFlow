import * as THREE from "three";

import type { DepartmentId } from "../data/layoutTypes";
import { boxAt, mergeAll } from "./geometryUtils";
import { buildStationParts, type PartMaterial } from "./stationModels";

export type FactoryObjectType =
  "pallet" | "rack" | "workstation" | "inspection" | "shipping";

export type OperationalStatus = "idle" | "running" | "blocked" | "down";

export interface FactoryObjectConfig {
  id: string;
  type: FactoryObjectType;
  /**
   * Centre of the station's bounding envelope in world metres:
   * x/z on the floor plane, y = size[1] / 2 (envelope sits on the floor).
   */
  position: [number, number, number];
  /** Overall envelope [width (x), height (y), depth (z)] in metres. */
  size: [number, number, number];
  color: number;

  name?: string;
  status?: OperationalStatus;
  capacity?: number;
  utilization?: number;
  department?: DepartmentId;
}

/** Neutral, non-status materials shared by all stations. */
const SHARED_MATERIALS: Record<Exclude<PartMaterial, "status">, THREE.Material> = {
  wood: new THREE.MeshStandardMaterial({ color: 0x8d6e47, roughness: 0.9 }),
  carton: new THREE.MeshStandardMaterial({ color: 0xb59463, roughness: 0.85 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x8b95a5, roughness: 0.5, metalness: 0.4 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 }),
  light: new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.7 }),
};

/**
 * One manufacturing station built from several primitive meshes.
 *
 * `group` is the logical object. `mesh` is the single status-coloured body
 * that the simulation recolours and the interaction layer highlights.
 * Every child carries `userData.statusMesh` so a ray hitting any part
 * resolves to the same station.
 */
export class FactoryObject {
  public readonly group = new THREE.Group();
  public readonly mesh: THREE.Mesh;

  constructor(config: FactoryObjectConfig) {
    const byMaterial = new Map<PartMaterial, THREE.BufferGeometry[]>();
    for (const part of buildStationParts(config)) {
      const list = byMaterial.get(part.material) ?? [];
      list.push(boxAt(part.size, part.pos));
      byMaterial.set(part.material, list);
    }

    const statusGeometries = byMaterial.get("status");
    if (!statusGeometries) throw new Error(`${config.id} has no status body`);

    this.mesh = new THREE.Mesh(
      mergeAll(statusGeometries),
      new THREE.MeshStandardMaterial({
        color: config.color,
        roughness: 0.65,
        metalness: 0.15,
      }),
    );
    this.group.add(this.mesh);

    for (const [key, geometries] of byMaterial) {
      if (key === "status") continue;
      this.group.add(new THREE.Mesh(mergeAll(geometries), SHARED_MATERIALS[key]));
    }

    // The group sits on the floor at the envelope's x/z centre.
    this.group.position.set(config.position[0], 0, config.position[2]);
    this.group.name = config.id;

    this.group.traverse((child) => {
      child.userData.factoryObject = config;
      child.userData.statusMesh = this.mesh;
    });
  }
}
