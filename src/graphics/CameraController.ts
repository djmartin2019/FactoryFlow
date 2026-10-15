import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export class CameraController {
  public readonly camera: THREE.PerspectiveCamera;

  private readonly controls: OrbitControls;

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 400);

    // Elevated three-quarter view of the 56 x 32 m facility (centred on
    // the origin), from the south-east so department names read upright.
    this.camera.position.set(27, 36, 47);

    this.controls = new OrbitControls(this.camera, canvas);

    this.controls.target.set(0, 0, 2);

    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;

    this.controls.minDistance = 5;
    this.controls.maxDistance = 110;

    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;

    this.controls.update();
  }

  public update(): void {
    this.controls.update();
  }

  public resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  public dispose(): void {
    this.controls.dispose();
  }
}
