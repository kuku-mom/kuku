import { describe, expect, it } from "vitest";
import { BoxGeometry, Matrix4, Quaternion, Vector3 } from "three";
import { CurvedSurface } from "./curved_surface";

describe("spherical harbor surface", () => {
  it("has gentle curvature, radial altitude and outward up across the island", () => {
    const surface = new CurvedSurface(200);
    for (const x of [-180, -70, 0, 90, 180])
      for (const z of [-90, 0, 90]) {
        const chart = new Vector3(x, 7, z),
          world = surface.project(chart);
        expect(world.distanceTo(surface.center)).toBeCloseTo(surface.radius + 7, 7);
        expect(surface.unproject(world).distanceTo(chart)).toBeLessThan(1e-7);
        const up = new Vector3(0, 1, 0).applyQuaternion(surface.orientationAt(chart));
        expect(up.dot(world.clone().sub(surface.center).normalize())).toBeCloseTo(1, 7);
      }
    const edge = surface.project(new Vector3(180, 0, 0));
    expect(edge.y).toBeLessThan(-10);
    expect(edge.y).toBeGreaterThan(-20);
    expect(surface.normalAt(new Vector3(-180, 0, 0)).x).toBeLessThan(-0.15);
    expect(surface.normalAt(new Vector3(180, 0, 0)).x).toBeGreaterThan(0.15);
  });

  it("keeps building pieces rigid on one tangent frame", () => {
    const surface = new CurvedSurface(160),
      anchor = new Vector3(110, 0, 50);
    const points = [anchor.clone(), anchor.clone().add(new Vector3(9, 40, 7))];
    const projected = points.map((p) => {
      const matrix = new Matrix4().compose(p, new Quaternion(), new Vector3(1, 1, 1));
      return new Vector3().setFromMatrixPosition(surface.placeMatrix(matrix, anchor));
    });
    expect(projected[0].distanceTo(projected[1])).toBeCloseTo(points[0].distanceTo(points[1]), 7);
    expect(projected[0].distanceTo(surface.project(anchor))).toBeLessThan(1e-7);
  });

  it("bends the slab geometry, retaining finite normals and radial thickness", () => {
    const surface = new CurvedSurface(160),
      slab = new BoxGeometry(240, 8, 100, 40, 1, 20);
    slab.translate(0, -4, 0);
    surface.bendGeometry(slab);
    const vertices = slab.getAttribute("position"),
      p = new Vector3();
    let minimumAltitude = Infinity,
      maximumAltitude = -Infinity;
    for (let i = 0; i < vertices.count; i++) {
      p.fromBufferAttribute(vertices, i);
      const altitude = p.distanceTo(surface.center) - surface.radius;
      minimumAltitude = Math.min(minimumAltitude, altitude);
      maximumAltitude = Math.max(maximumAltitude, altitude);
    }
    expect(minimumAltitude).toBeCloseTo(-8, 3);
    expect(maximumAltitude).toBeCloseTo(0, 3);
    expect(slab.boundingBox!.min.y).toBeLessThan(-15);
    expect([...slab.getAttribute("normal").array].every(Number.isFinite)).toBe(true);
    slab.dispose();
  });
});
