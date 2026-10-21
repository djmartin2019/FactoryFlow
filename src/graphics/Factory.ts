import * as THREE from "three";

import { FactoryBuilding } from "./FactoryBuilding";
import { FactoryObject } from "./FactoryObject";
import { DepartmentZone } from "./DepartmentZone";
import { FloorMarkings } from "./FloorMarkings";
import { StationLabel } from "./StationLabel";
import {
  building,
  departments,
  dockDoors,
  factoryLayout,
  floorMarkings,
} from "../data/factoryLayout";

/**
 * Assembles the whole facility from the layout data. Only station groups
 * are registered as selectable; the building, zones, markings and labels
 * are decorative and never take part in raycasting.
 */
export class Factory {
  public readonly group = new THREE.Group();

  /** Station groups: the only objects the raycaster is run against. */
  public readonly selectableObjects: THREE.Object3D[] = [];

  /**
   * Station id -> its status-coloured body mesh. The simulation visualizer
   * and the interaction layer both key on this lookup.
   */
  public readonly objectsById = new Map<string, THREE.Mesh>();

  private readonly labels: StationLabel[] = [];

  constructor() {
    this.group.add(new FactoryBuilding(building, dockDoors).group);

    const zoneColors = new Map<string, number>();
    for (const department of departments) {
      zoneColors.set(department.id, department.color);
      this.group.add(new DepartmentZone(department).group);
    }

    this.group.add(new FloorMarkings(floorMarkings).group);
    this.createStations(zoneColors);
  }

  private createStations(zoneColors: ReadonlyMap<string, number>): void {
    for (const config of factoryLayout) {
      const object = new FactoryObject(config);
      this.group.add(object.group);
      this.selectableObjects.push(object.group);
      this.objectsById.set(config.id, object.mesh);

      const accent = zoneColors.get(config.department ?? "") ?? 0x94a3b8;
      // A station with another one just to its south would have its label
      // covered by that station's label from the default camera; lift it.
      const hasSouthNeighbour = factoryLayout.some(
        (other) =>
          other !== config &&
          Math.abs(other.position[0] - config.position[0]) < 6 &&
          other.position[2] > config.position[2] &&
          other.position[2] - config.position[2] <= 7,
      );
      const label = new StationLabel(config, accent, hasSouthNeighbour ? 1.1 : 0);
      this.labels.push(label);
      this.group.add(label.sprite);
    }
  }

  /**
   * With an analytical overlay, outline the labels of the objects it highlights (in `accent`) and fade the others, so
   * highlighted objects stay identifiable even when their equipment is hidden behind another label or rack. `null`
   * restores every label. The selected object's label is never faded.
   */
  public setLabelEmphasis(highlighted: ReadonlySet<string> | null, accent: string | null, selectedId: string | null): void {
    for (const label of this.labels) {
      const on = highlighted !== null && highlighted.has(label.objectId);
      label.setEmphasis(highlighted !== null && !on && label.objectId !== selectedId, on ? accent : null);
    }
  }

  /** Call once per frame so labels keep a legible on-screen size. */
  public updateLabels(camera: THREE.PerspectiveCamera, viewportHeightPx: number): void {
    for (const label of this.labels) label.update(camera, viewportHeightPx);
  }
}
