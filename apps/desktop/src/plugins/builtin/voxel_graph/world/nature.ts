/** Sparse, purposeful quay furniture doubles as agent work destinations. */
import { Vector3, type Group } from "three";
import { stableNoise, type IslandSpec, type PlotSpec } from "../voxel_layout";
import { HarborGeometry } from "./harbor_geometry";
import type { WorldPalette } from "./palette";
import type { CurvedSurface } from "./curved_surface";
export interface WorkSite {
  position: Vector3;
  rotY: number;
  clusterIndex: number;
}
export interface WorkSites {
  fields: WorkSite[];
  stalls: WorkSite[];
  wells: WorkSite[];
  trees: WorkSite[];
}
export interface NatureHandle {
  group: Group;
  workSites: WorkSites;
  update(nowSeconds: number): void;
  dispose(): void;
}
export function createNature(
  islands: readonly IslandSpec[],
  plots: ReadonlyMap<string, PlotSpec>,
  _palette: WorldPalette,
  options: { densityMultiplier?: number; surface?: CurvedSurface } = {},
): NatureHandle {
  const kit = new HarborGeometry(options.surface),
    workSites: WorkSites = { fields: [], stalls: [], wells: [], trees: [] };
  function tree(x: number, z: number, scale = 1) {
    kit.setAnchor(new Vector3(x, 0, z));
    kit.add("pot", "#a37a52", x, 2 * scale, z, 6 * scale, 4 * scale, 6 * scale);
    kit.add("pot", "#c29263", x, 3.9 * scale, z, 6.5 * scale, 0.8 * scale, 6.5 * scale);
    kit.add("pot", "#665237", x, 4.35 * scale, z, 5.2 * scale, 0.2 * scale, 5.2 * scale);
    kit.add("pot", "#765a38", x, 8 * scale, z, 1.1 * scale, 8 * scale, 1.1 * scale);
    const leafClusters = scale < 0.5 ? 9 : 32;
    for (let i = 0; i < leafClusters; i++) {
      const a = i * 2.4,
        r = Math.sqrt(i / leafClusters) * 4.5 * scale;
      kit.add(
        "sphere",
        ["#778b39", "#8b9b41", "#a2a347"][i % 3],
        x + Math.cos(a) * r,
        13 * scale + (stableNoise(`tree:${i}`) - 0.5) * 5 * scale,
        z + Math.sin(a) * r,
        2.9 * scale,
        3.2 * scale,
        2.9 * scale,
      );
    }
  }
  for (const island of islands) {
    const x = island.center.x,
      z = island.center.z + island.radiusBlocks * 2.9;
    tree(x - 15, z, 0.95);
    kit.setAnchor(new Vector3(x + 4, 0, z));
    workSites.trees.push({
      position: new Vector3(x - 9, 0, z),
      rotY: -Math.PI / 2,
      clusterIndex: island.clusterIndex,
    });
    // Reading bench and a small book table, with clear approach positions.
    for (let i = 0; i < 4; i++) kit.box("#92714f", x + 4, 2, z - 1.5 + i * 0.8, 10, 0.45, 0.6);
    for (const dx of [-4, 4]) {
      kit.box("#365052", x + 4 + dx, 1, z, 0.6, 2, 0.6);
      kit.box("#365052", x + 4 + dx, 3, z - 2, 0.5, 5, 0.5);
    }
    kit.box("#a88860", x + 4, 4, z - 2, 10, 1.7, 0.4);
    workSites.wells.push({
      position: new Vector3(x + 4, 0, z + 4),
      rotY: Math.PI,
      clusterIndex: island.clusterIndex,
    });
    const lx = x + 18;
    kit.setAnchor(new Vector3(lx, 0, z));
    kit.add("pot", "#355052", lx, 6, z, 0.55, 12, 0.55);
    kit.add("pot", "#355052", lx, 0.7, z, 1.8, 1.4, 1.8);
    kit.box("#d2ad65", lx, 12.3, z, 2, 2.8, 2);
    kit.add("cone", "#355052", lx, 14.4, z, 3, 1.6, 3, 0, Math.PI / 4);
    workSites.stalls.push({
      position: new Vector3(lx - 4, 0, z),
      rotY: Math.PI / 2,
      clusterIndex: island.clusterIndex,
    });
  }
  // Small entrance topiary: fewer decorations when density is reduced.
  for (const plot of plots.values())
    if (stableNoise(plot.node.id) < Math.min(0.8, (options.densityMultiplier ?? 1) * 0.65))
      tree(plot.position.x + 11, plot.position.z + 9, 0.34);
  return { group: kit.finish(), workSites, update: () => {}, dispose: () => kit.dispose() };
}
