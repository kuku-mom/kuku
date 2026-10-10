/** Single-pass harbor rendering with a bounded backing buffer.
 * MSAA and real sun shadows preserve depth without full-scene SSAO copies.
 */
import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from "three";
export class HarborRenderer {
  private readonly renderer: WebGLRenderer;
  private lastShadowAt = -Infinity;
  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
  }
  setSize(width: number, height: number): void {
    // Retina panels must not multiply every fragment by 3–4x.
    const ratio = Math.min(
      globalThis.devicePixelRatio || 1,
      1.25,
      Math.sqrt(1_800_000 / Math.max(1, width * height)),
    );
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height);
  }
  invalidateShadows(): void {
    this.lastShadowAt = -Infinity;
  }
  render(scene: Scene, camera: Camera): void {
    const now = performance.now();
    // Architecture is static; only residents/boat need occasional shadow refresh.
    if (now - this.lastShadowAt >= 100) {
      this.renderer.shadowMap.needsUpdate = true;
      this.lastShadowAt = now;
    }
    this.renderer.render(scene, camera);
  }
  dispose(): void {}
}
