// ── Agent World Sky ──
//
// Atmosphere: gradient sky dome, sun or moon, drifting voxel clouds, a star
// field at night, and the scene lighting rig. The sky follows the world mood
// (light theme = day, dark theme = night).

import {
  AmbientLight,
  BackSide,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from "three";

import { stableNoise } from "../voxel_layout";
import { glowBatch, type VoxelBatch } from "./batch";
import type { WorldPalette } from "./palette";

export interface SkyHandle {
  group: Group;
  update(nowSeconds: number): void;
  dispose(): void;
}

interface CloudPuff {
  index: number;
  baseX: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  speed: number;
}

function createSkyDomeMaterial(palette: WorldPalette): MeshBasicMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, palette.skyTop);
    gradient.addColorStop(0.62, palette.skyHorizon);
    gradient.addColorStop(1, palette.fog);
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  return new MeshBasicMaterial({ map: texture, side: BackSide, fog: false, depthWrite: false });
}

function buildStars(palette: WorldPalette, domeRadius: number): VoxelBatch {
  const count = 360;
  const stars = glowBatch(count);
  for (let index = 0; index < count; index++) {
    const azimuth = stableNoise(`star-az:${index}`) * Math.PI * 2;
    const altitude = Math.asin(0.08 + stableNoise(`star-alt:${index}`) * 0.9);
    const radius = domeRadius * 0.96;
    const size = 1.4 + stableNoise(`star-size:${index}`) * 2.4;
    const twinkle = stableNoise(`star-tone:${index}`);
    stars.add({
      x: Math.cos(azimuth) * Math.cos(altitude) * radius,
      y: Math.sin(altitude) * radius,
      z: Math.sin(azimuth) * Math.cos(altitude) * radius,
      sx: size,
      sy: size,
      sz: size,
      color: new Color(palette.star).multiplyScalar(0.55 + twinkle * 0.45),
    });
  }
  stars.commit();
  return stars;
}

function buildClouds(
  palette: WorldPalette,
  worldRadius: number,
): { batch: VoxelBatch; puffs: CloudPuff[]; bound: number } {
  const clusterCount = 12;
  const bound = worldRadius * 1.7;
  const puffs: CloudPuff[] = [];
  const batch = glowBatch(clusterCount * 5, true, palette.cloudOpacity);

  for (let cluster = 0; cluster < clusterCount; cluster++) {
    const seed = `cloud:${cluster}`;
    const baseX = (stableNoise(`${seed}:x`) * 2 - 1) * bound;
    const y = worldRadius * (0.5 + stableNoise(`${seed}:y`) * 0.4);
    const z = (stableNoise(`${seed}:z`) * 2 - 1) * bound;
    const speed = 6 + stableNoise(`${seed}:v`) * 8;
    const puffCount = 3 + (Math.floor(stableNoise(`${seed}:n`) * 3) % 3);

    for (let puff = 0; puff < puffCount; puff++) {
      const offsetX = (stableNoise(`${seed}:${puff}:ox`) * 2 - 1) * 26;
      const offsetZ = (stableNoise(`${seed}:${puff}:oz`) * 2 - 1) * 14;
      const width = 26 + stableNoise(`${seed}:${puff}:w`) * 30;
      const index = batch.add({
        x: baseX + offsetX,
        y: y + (stableNoise(`${seed}:${puff}:oy`) * 2 - 1) * 4,
        z: z + offsetZ,
        sx: width,
        sy: 7 + stableNoise(`${seed}:${puff}:h`) * 5,
        sz: 16 + stableNoise(`${seed}:${puff}:d`) * 14,
        color: palette.cloud,
      });
      puffs.push({
        index,
        baseX: baseX + offsetX,
        y: y + (stableNoise(`${seed}:${puff}:oy`) * 2 - 1) * 4,
        z: z + offsetZ,
        sx: width,
        sy: 7 + stableNoise(`${seed}:${puff}:h`) * 5,
        sz: 16 + stableNoise(`${seed}:${puff}:d`) * 14,
        speed,
      });
    }
  }
  batch.commit();
  return { batch, puffs, bound };
}

export function createSky(palette: WorldPalette, worldRadius: number): SkyHandle {
  const group = new Group();
  const domeRadius = Math.max(worldRadius * 2.6, 900);

  // Dome
  const domeGeometry = new SphereGeometry(domeRadius, 24, 16);
  const domeMaterial = createSkyDomeMaterial(palette);
  const dome = new Mesh(domeGeometry, domeMaterial);
  dome.renderOrder = -10;
  group.add(dome);

  // Lighting rig
  const ambient = new AmbientLight(palette.ambient, palette.ambientIntensity);
  const hemisphere = new HemisphereLight(
    palette.hemiSky,
    palette.hemiGround,
    palette.hemiIntensity,
  );
  const sun = new DirectionalLight(palette.sunColor, palette.sunIntensity);
  const sunDirection =
    palette.mood === "day" ? new Vector3(0.55, 0.95, 0.4) : new Vector3(-0.45, 0.7, -0.35);
  sun.position.copy(sunDirection.multiplyScalar(domeRadius * 0.6));
  group.add(ambient, hemisphere, sun);

  // Sun / moon orb with a soft halo
  const orbPosition = sun.position.clone().multiplyScalar(0.92);
  const orbSize = palette.mood === "day" ? domeRadius * 0.045 : domeRadius * 0.035;
  const orb = glowBatch(2);
  orb.add({
    x: orbPosition.x,
    y: orbPosition.y,
    z: orbPosition.z,
    sx: orbSize,
    sy: orbSize,
    sz: orbSize,
    rotY: 0.6,
    color: palette.orb,
  });
  orb.add({
    x: orbPosition.x,
    y: orbPosition.y,
    z: orbPosition.z,
    sx: orbSize * 1.5,
    sy: orbSize * 1.5,
    sz: orbSize * 1.5,
    rotY: 0.2,
    color: new Color(palette.orbGlow).multiplyScalar(0.55),
  });
  orb.commit();
  (orb.mesh.material as MeshBasicMaterial).transparent = true;
  (orb.mesh.material as MeshBasicMaterial).opacity = 0.9;
  (orb.mesh.material as MeshBasicMaterial).fog = false;
  group.add(orb.mesh);

  // Stars (night only)
  let stars: VoxelBatch | null = null;
  if (palette.mood === "night") {
    stars = buildStars(palette, domeRadius);
    (stars.mesh.material as MeshBasicMaterial).fog = false;
    group.add(stars.mesh);
  }

  // Clouds
  const clouds = buildClouds(palette, worldRadius);
  group.add(clouds.batch.mesh);

  function update(nowSeconds: number): void {
    for (const puff of clouds.puffs) {
      const span = clouds.bound * 2;
      const travelled = (puff.baseX + clouds.bound + nowSeconds * puff.speed) % span;
      const x = travelled < 0 ? travelled + span - clouds.bound : travelled - clouds.bound;
      clouds.batch.set(puff.index, {
        x,
        y: puff.y,
        z: puff.z,
        sx: puff.sx,
        sy: puff.sy,
        sz: puff.sz,
        color: palette.cloud,
      });
    }
    clouds.batch.commit();
  }

  function dispose(): void {
    domeGeometry.dispose();
    domeMaterial.map?.dispose();
    domeMaterial.dispose();
    orb.dispose();
    stars?.dispose();
    clouds.batch.dispose();
  }

  return { group, update, dispose };
}
