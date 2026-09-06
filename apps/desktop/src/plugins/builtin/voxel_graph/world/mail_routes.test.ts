import { describe, it, expect } from "vitest";
import { Vector3 } from "three";
import { createMailRouter } from "./mail_routes";
import { computeIslands, computePlots } from "../voxel_layout";
import type { GraphNode } from "~/plugins/builtin/graph_view/graph_types";
describe("postal graph routes", () => {
  it("routes around an intervening building instead of drawing through it", () => {
    const nodes: GraphNode[] = Array.from({ length: 9 }, (_, i) => ({
      id: String(i),
      name: String(i),
      filePath: `${i}.md`,
      folder: "Town",
      clusterIndex: 0,
      linkCount: 0,
      isOrphan: true,
    }));
    const islands = computeIslands(nodes, ["Town"]),
      plots = computePlots(nodes, islands),
      router = createMailRouter(plots, islands);
    const from = new Vector3(-55, 0, -12),
      to = new Vector3(55, 0, -12);
    const [route] = router([{ from, to }]);
    expect(route).toBeDefined();
    expect(route.length).toBeGreaterThan(3);
    for (let i = 1; i < route.length - 1; i++) {
      for (const plot of plots.values())
        expect(
          Math.abs(route[i].x - plot.position.x) > 14 ||
            Math.abs(route[i].z - plot.position.z) > 12,
        ).toBe(true);
    }
    expect(router([])).toEqual([]);
  });
});
