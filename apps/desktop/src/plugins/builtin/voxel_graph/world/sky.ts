// ── Agent World Sky ──
//
// A soft painterly daytime sky: a gradient dome, a warm directional sun that
// drives the cel banding, gentle ambient + hemisphere fill, and flat cream
// clouds drifting slowly overhead.

import {
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  Mesh,
  MeshToonMaterial,
  SphereGeometry,
  type BufferGeometry,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { WorldPalette } from "./palette";

import { stableNoise } from "../voxel_layout";
import { noOutline } from "./toon";

export interface SkyHandle {
  group: Group;
  update(nowSeconds: number): void;
  dispose(): void;
}

export function createSky(palette: WorldPalette, worldRadius: number): SkyHandle {
  const group = new Group();
  const domeRadius = Math.max(worldRadius * 3.2, 2_400);

  // ── Lighting rig ──
  const ambient = new AmbientLight(palette.ambient, palette.ambientIntensity);
  const hemi = new HemisphereLight(palette.hemiSky, palette.hemiGround, palette.hemiIntensity);
  const sun = new DirectionalLight(palette.sunColor, palette.sunIntensity);
  sun.position.set(worldRadius * 0.9, worldRadius * 1.4, worldRadius * 0.5);
  group.add(ambient, hemi, sun);

  // ── Gradient dome ──
  const domeGeometry = new SphereGeometry(domeRadius, 32, 20);
  const top = new Color(palette.skyTop);
  const horizon = new Color(palette.skyHorizon);
  const position = domeGeometry.attributes.position;
  const colors: number[] = [];
  const tmp = new Color();
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i) / domeRadius; // -1..1
    const t = Math.max(0, y) ** 0.6; // bias the gradient toward the top
    tmp.copy(horizon).lerp(top, t);
    colors.push(tmp.r, tmp.g, tmp.b);
  }
  domeGeometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  const domeMaterial = new MeshToonMaterial({ vertexColors: true, side: BackSide, fog: false });
  noOutline(domeMaterial);
  const dome = new Mesh(domeGeometry, domeMaterial);
  dome.renderOrder = -10;
  group.add(dome);

  // ── Distant hazy hills + mountains — layered atmospheric backdrop ──
  //
  // Three depth layers across the water: near forested hills, mid ridges, and a
  // far mountain range that all but dissolves into the sky. Each layer is hazed
  // (lerped toward the horizon colour) and the far ones get a subtle cool shift
  // so distance reads through atmospheric perspective.
  const hillGeometries: BufferGeometry[] = [];
  const hillColors: number[] = [];
  const horizonColor = new Color(palette.skyHorizon);
  const coolHaze = new Color(palette.skyHorizon).lerp(new Color(palette.skyTop), 0.35);
  const hillRings = [
    {
      radius: worldRadius * 1.42,
      height: worldRadius * 0.15,
      width: worldRadius * 0.5,
      haze: 0.42,
      cool: 0,
      count: 30,
    },
    {
      radius: worldRadius * 1.95,
      height: worldRadius * 0.26,
      width: worldRadius * 0.66,
      haze: 0.66,
      cool: 0.25,
      count: 26,
    },
    {
      radius: worldRadius * 2.6,
      height: worldRadius * 0.42,
      width: worldRadius * 0.9,
      haze: 0.86,
      cool: 0.5,
      count: 20,
    },
  ];
  for (const ring of hillRings) {
    const hazeTarget = horizonColor.clone().lerp(coolHaze, ring.cool);
    const col = new Color(palette.canopyDark).lerp(hazeTarget, ring.haze);
    for (let i = 0; i < ring.count; i++) {
      const angle =
        (i / ring.count) * Math.PI * 2 + stableNoise(`hill-a:${ring.radius}:${i}`) * 0.4;
      const r = ring.radius * (0.92 + stableNoise(`hill-r:${ring.radius}:${i}`) * 0.2);
      const h = ring.height * (0.55 + stableNoise(`hill-h:${ring.radius}:${i}`) * 0.9);
      const w = ring.width * (0.6 + stableNoise(`hill-w:${ring.radius}:${i}`) * 0.7);
      const dome2 = new SphereGeometry(1, 10, 7);
      dome2.scale(w, h, w);
      dome2.translate(Math.cos(angle) * r, -h * 0.4, Math.sin(angle) * r);
      const verts = dome2.attributes.position.count;
      for (let v = 0; v < verts; v++) hillColors.push(col.r, col.g, col.b);
      hillGeometries.push(dome2);
    }
  }
  const hillGeometry = mergeGeometries(hillGeometries);
  for (const geometry of hillGeometries) geometry.dispose();
  hillGeometry.setAttribute("color", new Float32BufferAttribute(hillColors, 3));
  const hillMaterial = new MeshToonMaterial({ vertexColors: true, fog: false });
  noOutline(hillMaterial);
  const hills = new Mesh(hillGeometry, hillMaterial);
  hills.renderOrder = -9;
  group.add(hills);

  // ── Clouds ──
  const cloudGeometries: BufferGeometry[] = [];
  const cloudCount = 16;
  for (let c = 0; c < cloudCount; c++) {
    const angle = (c / cloudCount) * Math.PI * 2 + stableNoise(`cloud-a:${c}`) * 1.4;
    const dist = worldRadius * (0.5 + stableNoise(`cloud-d:${c}`) * 1.1);
    const cx = Math.cos(angle) * dist;
    const cz = Math.sin(angle) * dist;
    const cy = worldRadius * (0.85 + stableNoise(`cloud-y:${c}`) * 0.5);
    const puffs = 3 + Math.floor(stableNoise(`cloud-p:${c}`) * 4);
    for (let p = 0; p < puffs; p++) {
      const r = 9 + stableNoise(`cloud-r:${c}:${p}`) * 11;
      const puff = new SphereGeometry(r, 10, 8);
      puff.scale(1.5, 0.55, 1.1);
      puff.translate(
        cx + (stableNoise(`cloud-px:${c}:${p}`) - 0.5) * 34,
        cy + (stableNoise(`cloud-py:${c}:${p}`) - 0.5) * 6,
        cz + (stableNoise(`cloud-pz:${c}:${p}`) - 0.5) * 22,
      );
      cloudGeometries.push(puff);
    }
  }
  const cloudGeometry = mergeGeometries(cloudGeometries);
  for (const geometry of cloudGeometries) geometry.dispose();
  const cloudMaterial = new MeshToonMaterial({ color: palette.cloud, fog: false });
  noOutline(cloudMaterial);
  const clouds = new Mesh(cloudGeometry, cloudMaterial);
  clouds.renderOrder = -9;
  const cloudSpan = worldRadius * 3.4;
  group.add(clouds);

  function update(nowSeconds: number): void {
    // Slow horizontal drift, wrapping across the sky.
    const drift = ((nowSeconds * 2.2) % cloudSpan) - cloudSpan / 2;
    clouds.position.x = drift;
  }

  function dispose(): void {
    domeGeometry.dispose();
    domeMaterial.dispose();
    hillGeometry.dispose();
    hillMaterial.dispose();
    cloudGeometry.dispose();
    cloudMaterial.dispose();
  }

  return { group, update, dispose };
}
