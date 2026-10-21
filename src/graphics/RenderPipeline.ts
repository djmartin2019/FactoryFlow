import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

/**
 * "high": shadows + ambient occlusion. AO is nearly all of the extra GPU cost, so
 * it is only drawn while the camera is at rest and fades in once it stops;
 * orbiting costs the same as "medium".
 * "medium": shadows only; they are re-rendered only when objects move, so this
 * costs about the same as "low". "low": neither, with a softer light balance.
 */
export type RenderQuality = "high" | "medium" | "low";
const QUALITIES: readonly RenderQuality[] = ["high", "medium", "low"];

/**
 * Station labels live on their own layer and are drawn after post-processing,
 * so the AO pass never sees the sprites (it would shade them as quads) and
 * the labels stay crisp.
 */
export const LABEL_LAYER = 1;

/** Covers the 80 x 44 m building plus wall height, seen from the key light. */
const SHADOW_EXTENT = 52;
const SHADOW_MAP_SIZE = 2048;

/**
 * Auto step-down from "high" to "medium": measured in wall-clock time, not frames,
 * so a very slow GPU is detected as quickly as a fast one. Keeps watching after load.
 */
const SLOW_FRAME_MS = 22;
const WARMUP_MS = 500;
const WINDOW_MS = 1000;
/** AO fades in over this long after the camera comes to rest. */
const AO_FADE_MS = 250;
const AO_BLEND = 0.85;

/** `?quality=high|medium|low` wins; otherwise touch-first devices start low. */
export function requestedQuality(): { quality: RenderQuality; explicit: boolean } {
  try {
    const q = new URLSearchParams(window.location.search).get("quality");
    const match = QUALITIES.find((x) => x === q);
    if (match) return { quality: match, explicit: true };
    const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    return { quality: coarse ? "low" : "high", explicit: false };
  } catch {
    return { quality: "high", explicit: false };
  }
}

/**
 * Owns lighting, colour management and the frame's render passes. The scene
 * graph and the simulation know nothing about it; SceneManager calls
 * `render()` once per frame and `invalidateShadows()` when objects move.
 */
export class RenderPipeline {
  private quality: RenderQuality;
  private readonly explicitQuality: boolean;
  private composer: EffectComposer | null = null;
  private gtao: GTAOPass | null = null;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly fillLight: THREE.HemisphereLight;
  private readonly envTarget: THREE.WebGLRenderTarget;
  private width = 1;
  private height = 1;
  private elapsedMs = 0;
  /** Frame times in the current window; the median ignores one-off hitches (tab switch, JSON parse). */
  private readonly windowSamples: number[] = [];
  private windowMs = 0;
  private aoFade = 0;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    const requested = requestedQuality();
    this.quality = requested.quality;
    this.explicitQuality = requested.explicit;

    // Neutral (Khronos PBR Neutral) keeps hues and saturation close to the
    // authored sRGB values, so status and product colours still mean what the legend says.
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // The plant is static between events, so shadows are re-rendered on demand only.
    renderer.shadowMap.autoUpdate = false;
    renderer.info.autoReset = false;

    // Image-based light from a generated room: gives steel and floors soft
    // reflections without shipping an HDR file.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.envTarget = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    scene.environment = this.envTarget.texture;
    scene.environmentIntensity = 0.3;

    // Physically based lighting: the key light must clearly dominate the fill,
    // otherwise shadows and occlusion have nothing to darken. Cool sky / warm floor fill.
    this.fillLight = new THREE.HemisphereLight(0xdbe7ff, 0x3a3430, 0.4);
    scene.add(this.fillLight);

    // Key light: high and to the south-east, like skylights over the dock side.
    this.keyLight = new THREE.DirectionalLight(0xfff4e6);
    this.keyLight.position.set(24, 48, 30);
    this.keyLight.target.position.set(0, 0, 0);
    const shadow = this.keyLight.shadow;
    shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    Object.assign(shadow.camera, {
      left: -SHADOW_EXTENT,
      right: SHADOW_EXTENT,
      top: SHADOW_EXTENT,
      bottom: -SHADOW_EXTENT,
      near: 10,
      far: 140,
    });
    shadow.camera.updateProjectionMatrix();
    shadow.bias = -0.0008;
    shadow.normalBias = 0.06;
    shadow.radius = 3;
    scene.add(this.keyLight, this.keyLight.target);

    // A cool rim from the opposite side keeps faces turned away from the key
    // (e.g. the east wall's interior) from going flat black.
    const rim = new THREE.DirectionalLight(0x9db7ff, 1.2);
    rim.position.set(-30, 25, -20);
    scene.add(rim);

    this.applyQuality();
  }

  get currentQuality(): RenderQuality {
    return this.quality;
  }

  /** Re-render the shadow map on the next frame (call after objects move or appear). */
  public invalidateShadows(): void {
    this.renderer.shadowMap.needsUpdate = true;
  }

  public setQuality(quality: RenderQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.applyQuality();
  }

  /** Size in CSS pixels; the renderer's pixel ratio is applied here. */
  public setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(width, height);
  }

  /**
   * `frameMs` feeds the auto step-down check. While `cameraMoving`, AO is skipped
   * (plain render, same lighting and shadows) and fades back in once the camera rests.
   */
  public render(frameMs: number, cameraMoving = false): void {
    // Several passes per frame: count them all for the perf HUD.
    this.renderer.info.reset();
    if (this.composer && this.gtao && !cameraMoving) {
      this.aoFade = Math.min(1, this.aoFade + frameMs / AO_FADE_MS);
      this.gtao.blendIntensity = AO_BLEND * this.aoFade;
      this.composer.render();
    } else {
      this.aoFade = 0;
      this.renderer.render(this.scene, this.camera);
    }
    this.renderLabels();
    this.watchFrameTime(frameMs);
  }

  private renderLabels(): void {
    const background = this.scene.background;
    const autoClear = this.renderer.autoClear;
    this.scene.background = null;
    this.renderer.autoClear = false;
    this.camera.layers.set(LABEL_LAYER);
    this.renderer.render(this.scene, this.camera);
    this.camera.layers.set(0);
    this.renderer.autoClear = autoClear;
    this.scene.background = background;
  }

  private watchFrameTime(frameMs: number): void {
    if (this.explicitQuality || this.quality !== "high") return;
    this.elapsedMs += frameMs;
    if (this.elapsedMs < WARMUP_MS) return;
    this.windowSamples.push(frameMs);
    this.windowMs += frameMs;
    if (this.windowMs < WINDOW_MS) return;
    const sorted = this.windowSamples.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    this.windowSamples.length = 0;
    this.windowMs = 0;
    if (median > SLOW_FRAME_MS) {
      console.info(`FactoryFlow: 3D frames take ${median.toFixed(0)} ms, turning off ambient occlusion (override with ?quality=high).`);
      this.setQuality("medium");
    }
  }

  private applyQuality(): void {
    const shadows = this.quality !== "low";
    this.renderer.shadowMap.enabled = shadows;
    this.keyLight.castShadow = shadows;
    // Without shadows a strong key over-lights surfaces that should be shaded
    // (lower shelves, rack interiors), so low quality uses a softer, fill-heavy balance.
    this.keyLight.intensity = shadows ? 6 : 3.2;
    this.fillLight.intensity = shadows ? 0.4 : 0.9;
    this.invalidateShadows();
    // Materials compile differently with/without shadow maps.
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
      }
    });

    this.disposeComposer();
    if (this.quality !== "high") return;

    // MSAA on the composer's target, since post-processing bypasses the canvas's own antialiasing.
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, target);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const gtao = new GTAOPass(this.scene, this.camera, this.width, this.height);
    // Radius in metres, sized for the default 20-80 m viewing distance: darkens
    // under benches, between rack levels and along the wall base.
    gtao.updateGtaoMaterial({ radius: 2, distanceExponent: 1, thickness: 3, scale: 1.6, samples: 12 });
    gtao.blendIntensity = 0;
    composer.addPass(gtao);
    composer.addPass(new OutputPass());
    this.composer = composer;
    this.gtao = gtao;
    this.setSize(this.width, this.height);
  }

  private disposeComposer(): void {
    this.gtao?.dispose();
    this.composer?.dispose();
    this.composer = null;
    this.gtao = null;
  }

  public dispose(): void {
    this.disposeComposer();
    this.envTarget.dispose();
  }
}
