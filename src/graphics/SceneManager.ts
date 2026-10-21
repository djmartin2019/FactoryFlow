import * as THREE from "three";
import { CameraController } from "./CameraController";
import { Factory } from "./Factory";
import { InteractionManager } from "./InteractionManager";
import type { SimulationController } from "../simulation/SimulationController";
import { FactoryVisualizer } from "./FactoryVisualizer";
import { inShift } from "../manufacturing/calendar";
import StationDetails from "../ui/StationDetails";
import { PerfOverlay } from "../ui/PerfOverlay";
import { SceneLegend } from "../ui/SceneLegend";
import { PRODUCT_COLORS } from "./WipBuffers";
import { overlayFor, type Overlay, type OverlayMode } from "../analytics/overlays";
import type { PeriodId } from "../analytics/periods";
import { reportingSnapshot } from "../simulation/reportingSnapshot";
import { OverlayControl } from "../ui/OverlayControl";
import { RenderPipeline } from "./RenderPipeline";

export class SceneManager {
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly cameraController: CameraController;
  private readonly interactionManager: InteractionManager;
  private readonly stationDetails: StationDetails;
  private readonly simulation: SimulationController;
  private readonly clock = new THREE.Clock();
  private readonly factory: Factory;
  private readonly visualizer: FactoryVisualizer;
  private readonly perf: PerfOverlay;
  private readonly pipeline: RenderPipeline;
  private lastVisualizedSequence = -1;
  private lastShiftOpen: boolean | null = null;
  private lastVisualKey = "";
  private overlayMode: OverlayMode = "status";
  private overlayControl!: OverlayControl;
  private readonly getPeriod: () => PeriodId;
  private active = true;
  private readonly resizeObserver: ResizeObserver;
  private readonly onSelectionChange?: (id: string | null) => void;

  constructor(
    container: HTMLElement,
    simulation: SimulationController,
    options: { onSelectionChange?: (id: string | null) => void; getPeriod?: () => PeriodId } = {},
  ) {
    this.onSelectionChange = options.onSelectionChange;
    this.getPeriod = options.getPeriod ?? (() => "24h");
    this.simulation = simulation;
    this.scene = new THREE.Scene();

    this.scene.background = new THREE.Color("#070e1c");

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
    });

    this.renderer.setSize(container.clientWidth, container.clientHeight);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    container.appendChild(this.renderer.domElement);

    this.cameraController = new CameraController(
      this.renderer.domElement,
      container.clientWidth,
      container.clientHeight,
    );

    this.pipeline = new RenderPipeline(this.renderer, this.scene, this.cameraController.camera);
    this.pipeline.setSize(container.clientWidth, container.clientHeight);
    this.factory = new Factory();
    this.scene.add(this.factory.group);
    const factory = this.factory;

    // Must exist before the first syncVisuals(), which reports the active overlay to it.
    this.overlayControl = new OverlayControl(container, (mode) => this.setOverlayMode(mode));
    this.visualizer = new FactoryVisualizer(factory.objectsById, factory.group);
    this.syncVisuals();

    this.stationDetails = new StationDetails(container);
    new SceneLegend(container, this.simulation.engine.master.products, PRODUCT_COLORS);
    this.perf = new PerfOverlay(container, () => this.countMeshes());

    this.interactionManager = new InteractionManager(
      this.cameraController.camera,
      this.renderer.domElement,
      factory.selectableObjects,
      (selectedObject) => {
        this.stationDetails.render(selectedObject);
        this.onSelectionChange?.(selectedObject?.id ?? null);
      },
    );

    // The viewport is a layout cell, so observe it rather than the window.
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(container);

    this.renderer.setAnimationLoop(this.animate);
  }

  public get details(): StationDetails {
    return this.stationDetails;
  }

  /** Select (and highlight) a station by layout id, as if it were clicked. */
  public select(id: string | null): void {
    const mesh = id ? this.factory.objectsById.get(id) : undefined;
    this.interactionManager.select(mesh ?? null);
  }

  /** Colour the factory from an analytical overlay ("status" restores the normal status colours). */
  public setOverlayMode(mode: OverlayMode): void {
    if (this.overlayMode === mode) return;
    this.overlayMode = mode;
    this.refreshVisuals();
  }

  /** Re-derive the visuals now (e.g. after the reporting period changed). */
  public refreshVisuals(): void {
    this.lastVisualizedSequence = -1;
    this.syncVisuals();
  }

  /** Bring objects into view from outside the scene: optionally switch the overlay, then select the first object. */
  public focus(objectIds: readonly string[], mode?: OverlayMode): void {
    if (mode) this.setOverlayMode(mode);
    if (objectIds.length > 0) this.select(objectIds[0]);
  }

  private animate = (): void => {
    const deltaSeconds = this.clock.getDelta();

    // The simulation clock lives here, so it keeps ticking while the 3D view is hidden.
    this.simulation.update(deltaSeconds);

    if (!this.active) return;

    this.syncVisuals();

    this.cameraController.update();

    this.factory.updateLabels(
      this.cameraController.camera,
      this.renderer.domElement.clientHeight,
    );

    this.pipeline.render(deltaSeconds * 1000, this.cameraController.isMoving());

    if (this.perf.isEnabled) {
      const info = this.renderer.info.render;
      this.perf.frame(
        deltaSeconds * 1000,
        info.calls,
        info.triangles,
        this.simulation.eventsApplied,
        this.simulation.epoch,
        this.simulation.lastSeekMs,
        this.pipeline.currentQuality,
      );
    }
  };

  /** Pause/resume rendering (e.g. while another top-level view is shown). The clock is unaffected. */
  public setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.lastVisualizedSequence = -1; // force a visual resync after being hidden
      this.lastShiftOpen = null;
      this.handleResize();
    }
  }

  private countMeshes(): number {
    let meshes = 0;
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes++;
    });
    return meshes;
  }

  /** Only re-derive visuals when an event has actually been applied. */
  private syncVisuals(): void {
    const state = this.simulation.state;
    const nowMs = this.simulation.currentTime.getTime();
    // Shift boundaries change what the queues mean without any event being applied.
    const shiftOpen = inShift(nowMs);

    // Overlays that depend on a trailing window also move with the clock, so they are re-derived every simulated quarter hour.
    const key = `${this.overlayMode}|${this.getPeriod()}|${this.overlayMode === "utilization" ? Math.floor(nowMs / 900_000) : 0}`;
    if (state.lastSequence === this.lastVisualizedSequence && shiftOpen === this.lastShiftOpen && key === this.lastVisualKey) return;
    this.lastVisualizedSequence = state.lastSequence;
    this.lastShiftOpen = shiftOpen;
    this.lastVisualKey = key;

    let overlay: Overlay | null = null;
    if (this.overlayMode !== "status") overlay = overlayFor(reportingSnapshot(this.simulation), this.overlayMode, this.getPeriod());
    this.overlayControl.setMode(this.overlayMode, overlay);
    this.visualizer.update(state, this.simulation.engine.master, nowMs, overlay);
    // Queue boxes may have appeared or moved; shadows are otherwise static.
    this.pipeline.invalidateShadows();
  }

  private handleResize = (): void => {
    const container = this.renderer.domElement.parentElement;

    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width === 0 || height === 0) return; // hidden view

    this.cameraController.resize(width, height);

    this.renderer.setSize(width, height);
    this.pipeline.setSize(width, height);
  };

  public dispose(): void {
    this.renderer.setAnimationLoop(null);

    this.resizeObserver.disconnect();

    this.cameraController.dispose();
    this.interactionManager.dispose();
    this.pipeline.dispose();

    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();

        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];

        materials.forEach((material) => material.dispose());
      }
    });

    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
