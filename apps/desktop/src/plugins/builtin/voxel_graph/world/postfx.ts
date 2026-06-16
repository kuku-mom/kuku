// ── Painterly post-processing ──
//
// Turns the cel-shaded 3D scene into something that reads like a hand-painted
// 2D anime background. The scene is rendered (with bold ink outlines) into an
// offscreen buffer, then a full-screen pass flattens it into posterised fills,
// lays a soft paper grain over the top, and warms the whole frame — the look of
// gouache on textured paper rather than clean CG.

import { ShaderMaterial, Vector2, WebGLRenderTarget, type WebGLRenderer } from "three";
import { OutlineEffect } from "three/examples/jsm/effects/OutlineEffect.js";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform vec2 resolution;
  varying vec2 vUv;

  vec3 toSRGB(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main() {
    // Scene is stored linear; move to perceptual space for painterly grading.
    vec3 col = toSRGB(texture2D(tDiffuse, vUv).rgb);

    // Flat gouache fills: quantise tone, but keep ink (near-black) crisp.
    float ink = smoothstep(0.0, 0.22, dot(col, vec3(0.333)));
    float levels = 9.0;
    vec3 posterized = floor(col * levels + 0.5) / levels;
    col = mix(col, posterized, ink * 0.8);

    // Paper grain: two octaves, very gentle so it reads as tooth, not noise.
    vec2 px = vUv * resolution;
    float coarse = vnoise(px * 0.012);
    float fine = vnoise(px * 0.55);
    col *= 0.965 + 0.045 * coarse;
    col -= (fine - 0.5) * 0.022;

    // Painted-cel grade: a touch more saturation, a soft contrast S-curve, and a
    // warm golden-hour cast — the storybook-afternoon look.
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(l), col, 1.07);
    col = (col - 0.5) * 1.06 + 0.5;
    col *= vec3(1.045, 1.005, 0.93);
    // Lift shadows slightly toward a warm amber so darks aren't muddy.
    col = mix(vec3(0.34, 0.3, 0.24), col, smoothstep(0.0, 0.5, l) * 0.18 + 0.82);

    // Quiet vignette to frame the world.
    vec2 d = vUv - 0.5;
    col *= 1.0 - dot(d, d) * 0.18;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export class PainterlyRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly outline: OutlineEffect;
  private readonly rt: WebGLRenderTarget;
  private readonly quad: FullScreenQuad;
  private readonly material: ShaderMaterial;
  private readonly uniforms: {
    tDiffuse: { value: unknown };
    resolution: { value: Vector2 };
  };

  constructor(renderer: WebGLRenderer, inkColor: [number, number, number]) {
    this.renderer = renderer;
    this.outline = new OutlineEffect(renderer, {
      defaultThickness: 0.004,
      defaultColor: inkColor,
      defaultAlpha: 1,
      defaultKeepAlive: false,
    });
    this.rt = new WebGLRenderTarget(2, 2, { depthBuffer: true, stencilBuffer: false });
    this.uniforms = {
      tDiffuse: { value: this.rt.texture },
      resolution: { value: new Vector2(2, 2) },
    };
    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width: number, height: number): void {
    const pr = this.renderer.getPixelRatio();
    this.renderer.setSize(width, height);
    this.outline.setSize(width, height);
    this.rt.setSize(Math.max(1, Math.floor(width * pr)), Math.max(1, Math.floor(height * pr)));
    this.uniforms.resolution.value.set(width, height);
  }

  render(
    scene: Parameters<OutlineEffect["render"]>[0],
    camera: Parameters<OutlineEffect["render"]>[1],
  ): void {
    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rt);
    this.outline.render(scene, camera);
    this.renderer.setRenderTarget(previous);
    this.quad.render(this.renderer);
  }

  dispose(): void {
    this.rt.dispose();
    this.material.dispose();
  }
}
