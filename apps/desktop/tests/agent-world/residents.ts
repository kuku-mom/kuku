import { residentProfile } from "~/plugins/builtin/voxel_graph/world/resident_profile";
import { Color, Scene, PerspectiveCamera, WebGLRenderer, SRGBColorSpace } from "three";
import SpriteText from "three-spritetext";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import {
  HARBOR_RESIDENTS,
  loadCharacterModel,
  makeCharacterInstance,
  disposeCharacterModels,
} from "~/plugins/builtin/voxel_graph/world/character_model";
import { HarborGeometry } from "~/plugins/builtin/voxel_graph/world/harbor_geometry";
import { paletteForMood } from "~/plugins/builtin/voxel_graph/world/palette";
import { HarborRenderer } from "~/plugins/builtin/voxel_graph/world/postfx";
import { createSky } from "~/plugins/builtin/voxel_graph/world/sky";
const scene = new Scene();
scene.background = new Color("#438d99");
const camera = new PerspectiveCamera(42, innerWidth / innerHeight, 0.5, 1000);
const galleryDirection = { x: 22, y: 93, z: 123 };
function fitGallery() {
  const scale = Math.max(1, 1.6 / camera.aspect);
  camera.position.set(
    galleryDirection.x * scale,
    galleryDirection.y * scale,
    galleryDirection.z * scale,
  );
}
fitGallery();
const renderer = new WebGLRenderer({ antialias: true });
renderer.outputColorSpace = SRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
document.body.append(renderer.domElement);
const post = new HarborRenderer(renderer);
post.setSize(innerWidth, innerHeight);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 3, 0);
controls.update();
const palette = paletteForMood("day"),
  sky = createSky(palette, 80);
scene.add(sky.group);
loadCharacterModel(palette);
const kit = new HarborGeometry();
kit.box("#bcae94", 0, -1, 0, 99, 2, 111);
const characters = HARBOR_RESIDENTS.map((_, i) => {
  const x = ((i % 5) - 2) * 18,
    z = (Math.floor(i / 5) - 2) * 20;
  kit.add("pot", "#d6c5a5", x, 0.1, z, 12, 0.2, 12);
  const model = makeCharacterInstance(i, 11 * residentProfile(i).stature)!;
  model.root.position.set(x, 0, z);
  scene.add(model.root);
  const waving = new URLSearchParams(location.search).get("action") === "wave";
  model.setMoving(!waving);
  if (waving) model.setAction("wave");
  const label = new SpriteText(`${i + 1}  ${HARBOR_RESIDENTS[i]}`);
  label.textHeight = 1.65;
  label.color = "#fff7e6";
  label.backgroundColor = "#346977";
  label.padding = 1;
  label.borderRadius = 1;
  label.position.set(x, 14, z);
  scene.add(label);
  return { model, x, z, label };
});
scene.add(kit.finish());
let previous = performance.now(),
  frame = 0;
function render(now: number) {
  frame = requestAnimationFrame(render);
  if (document.hidden) {
    previous = now;
    return;
  }
  if (now - previous < 1000 / 30 - 1) return;
  const delta = Math.min(0.05, (now - previous) / 1000);
  previous = now;
  for (const { model, x, z } of characters) {
    model.root.position.set(x, 0, z);
    model.update(delta);
  }
  controls.update();
  post.render(scene, camera);
}
frame = requestAnimationFrame(render);
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  fitGallery();
  post.setSize(innerWidth, innerHeight);
});
addEventListener("pagehide", () => {
  cancelAnimationFrame(frame);
  characters.forEach(({ model, label }) => {
    model.dispose();
    label.material.map?.dispose();
    label.material.dispose();
  });
  disposeCharacterModels();
  kit.dispose();
  sky.dispose();
  controls.dispose();
  post.dispose();
  renderer.dispose();
});
