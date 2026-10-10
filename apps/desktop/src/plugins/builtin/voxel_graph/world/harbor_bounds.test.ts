import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { constrainToHarbor, harborBounds } from "./harbor_bounds";
describe("harbor walkable surface", () => {
  it("keeps restored or displaced residents inside every recessed corner", () => {
    const b = harborBounds([]);
    for (const x of [-1000, 0, 1000])
      for (const z of [-1000, 0, 1000]) {
        const p = new Vector3(x, 0, z);
        constrainToHarbor(p, b);
        expect(p.x).toBeGreaterThanOrEqual(b.minX + 4);
        expect(p.x).toBeLessThanOrEqual(b.maxX - 4);
        expect(p.z).toBeGreaterThanOrEqual(b.minZ + 4);
        expect(p.z).toBeLessThanOrEqual(b.maxZ - 4);
        const cornerX = p.x < b.minX + b.cutX + 4 || p.x > b.maxX - b.cutX - 4;
        const cornerZ = p.z < b.minZ + b.cutZ + 4 || p.z > b.maxZ - b.cutZ - 4;
        expect(cornerX && cornerZ).toBe(false);
      }
  });
  it("leaves a point on the plaza unchanged", () => {
    const p = new Vector3(10, 0, 10);
    constrainToHarbor(p, harborBounds([]));
    expect(p.toArray()).toEqual([10, 0, 10]);
  });
});
