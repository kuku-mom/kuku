import { AmbientLight, DirectionalLight, Group, HemisphereLight } from "three";
import type { WorldPalette } from "./palette";
export interface SkyHandle {
  group: Group;
  update(nowSeconds: number): void;
  dispose(): void;
}
export function createSky(palette: WorldPalette, radius: number): SkyHandle {
  const group = new Group();
  const sun = new DirectionalLight(palette.sunColor, palette.sunIntensity);
  sun.position.set(-radius * 0.7, radius * 1.8, radius * 0.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const size = radius * 1.15;
  Object.assign(sun.shadow.camera, {
    left: -size,
    right: size,
    top: size,
    bottom: -size,
    near: 1,
    far: radius * 6,
  });
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.18;
  sun.shadow.radius = 3;
  group.add(
    new HemisphereLight(palette.hemiSky, palette.hemiGround, palette.hemiIntensity),
    new AmbientLight(palette.ambient, palette.ambientIntensity),
    sun,
  );
  return {
    group,
    update: () => {},
    dispose: () => {
      sun.shadow.dispose();
    },
  };
}
