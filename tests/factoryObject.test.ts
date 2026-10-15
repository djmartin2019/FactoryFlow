import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { factoryLayout } from "../src/data/factoryLayout.ts";
import { FactoryObject } from "../src/graphics/FactoryObject.ts";

describe("FactoryObject picking", () => {
  it("resolves a ray hit on any part to the station's status body", () => {
    for (const config of factoryLayout) {
      const object = new FactoryObject(config);
      object.group.updateMatrixWorld(true);

      const raycaster = new THREE.Raycaster();
      const seen = new Set<THREE.Object3D>();

      // Sweep rays straight down across the footprint.
      const [x, , z] = config.position;
      for (let i = -9; i <= 9; i++) {
        for (let j = -9; j <= 9; j++) {
          const ox = x + (i / 10) * (config.size[0] / 2);
          const oz = z + (j / 10) * (config.size[2] / 2);
          raycaster.set(new THREE.Vector3(ox, 20, oz), new THREE.Vector3(0, -1, 0));
          const [hit] = raycaster.intersectObject(object.group, true);
          if (!hit) continue;
          seen.add(hit.object);
          expect(hit.object.userData.statusMesh, config.id).toBe(object.mesh);
          expect(hit.object.userData.factoryObject.id).toBe(config.id);
        }
      }
      // Multi-mesh station: rays hit more than just the status body.
      expect(seen.size, config.id).toBeGreaterThan(1);
    }
  });
});
