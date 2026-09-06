import { describe, it, expect } from "vitest";
import { residentProfile } from "./resident_profile";
import { Box3, Vector3, Raycaster, Mesh, MeshLambertMaterial } from "three";
import {
  HARBOR_RESIDENTS,
  characterVariantCount,
  loadCharacterModel,
  makeCharacterInstance,
  disposeCharacterModels,
} from "./character_model";
import { paletteForMood } from "./palette";
describe("harbor residents", () => {
  it("has visibly different builds, heights, headwear, hair and three helper robots", () => {
    const profiles = Array.from({ length: 25 }, (_, i) => residentProfile(i));
    expect(new Set(profiles.map((p) => p.build)).size).toBe(5);
    expect(new Set(profiles.map((p) => p.headwear)).size).toBeGreaterThanOrEqual(10);
    expect(new Set(profiles.map((p) => p.hairStyle)).size).toBe(7);
    expect(profiles.filter((p) => p.robot)).toHaveLength(3);
    expect(
      Math.max(...profiles.map((p) => p.stature)) / Math.min(...profiles.map((p) => p.stature)),
    ).toBeGreaterThan(1.45);
    loadCharacterModel(paletteForMood("day"));
    const widths = profiles.map((_, i) => {
      const model = makeCharacterInstance(i, 10)!;
      const size = new Box3().setFromObject(model.root).getSize(new Vector3());
      model.dispose();
      return size.x;
    });
    expect(Math.max(...widths) / Math.min(...widths)).toBeGreaterThan(1.35);
    disposeCharacterModels();
  });
  it("creates 25 complete, distinct, independently articulated residents", () => {
    loadCharacterModel(paletteForMood("day"));
    expect(characterVariantCount()).toBe(25);
    expect(new Set(HARBOR_RESIDENTS).size).toBe(25);
    for (let i = 0; i < 25; i++) {
      const model = makeCharacterInstance(i, 10)!;
      expect(model.root.name).toBe(HARBOR_RESIDENTS[i]);
      expect(new Box3().setFromObject(model.root).max.y).toBeCloseTo(10, 3);
      const arm = model.root.getObjectByName("arm-right")!;
      model.setMoving(true);
      model.update(0.12);
      expect(Math.abs(arm.rotation.x)).toBeGreaterThan(0);
      model.dispose();
    }
    const first = makeCharacterInstance(0, 10)!,
      second = makeCharacterInstance(0, 10)!;
    first.setMoving(true);
    first.update(0.2);
    expect(second.root.getObjectByName("arm-right")!.rotation.x).toBeCloseTo(0);
    first.dispose();
    second.dispose();
    disposeCharacterModels();
    loadCharacterModel(paletteForMood("day"));
    expect(makeCharacterInstance(24, 10)).not.toBeNull();
    disposeCharacterModels();
  });
});

it("keeps the waving hand outside every face and hat throughout raise, wave and lower", () => {
  loadCharacterModel(paletteForMood("day"));
  for (let variant = 0; variant < 25; variant++) {
    const model = makeCharacterInstance(variant, 10)!;
    const head = model.root.getObjectByName("head")!;
    const forearm = model.root.getObjectByName("elbow-right")!.getObjectByName("forearm")!;
    model.setAction("wave");
    for (let frame = 0; frame < 180; frame++) {
      if (frame === 144) model.setAction("idle");
      model.update(1 / 60);
      model.root.updateMatrixWorld(true);
      const headBounds = new Box3().setFromObject(head);
      const handBounds = new Box3().setFromObject(forearm);
      expect(handBounds.intersectsBox(headBounds), `variant ${variant}, frame ${frame}`).toBe(
        false,
      );
    }
    model.dispose();
  }
  disposeCharacterModels();
});

it("uses matte head surfaces and separates the exposed crown layers", () => {
  loadCharacterModel(paletteForMood("day"));
  for (let variant = 0; variant < 25; variant++) {
    const model = makeCharacterInstance(variant, 10)!;
    model.root.updateMatrixWorld(true);
    const head = model.root.getObjectByName("head")!;
    const bounds = new Box3().setFromObject(head);
    const face = head.getObjectByName("face") as Mesh;
    expect(face.material).toBeInstanceOf(MeshLambertMaterial);
    expect(face.receiveShadow).toBe(false);
    // Topmost surfaces must not compete for identical depth as the head moves.
    for (const x of [0.137, 0.371, 0.683])
      for (const z of [0.193, 0.437, 0.719]) {
        const origin = new Vector3(
          bounds.min.x + (bounds.max.x - bounds.min.x) * x,
          bounds.max.y + 1,
          bounds.min.z + (bounds.max.z - bounds.min.z) * z,
        );
        const hits = new Raycaster(origin, new Vector3(0, -1, 0)).intersectObject(head, true);
        if (hits.length > 1)
          expect(
            hits[1].distance - hits[0].distance,
            `crown ${variant} at ${x},${z}`,
          ).toBeGreaterThan(0.00001);
      }
    model.dispose();
  }
  disposeCharacterModels();
});
