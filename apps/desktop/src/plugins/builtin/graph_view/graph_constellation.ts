import type { FGNode, GraphNode } from "./graph_types";

// The 3D palette is independent of the 2D renderer. Both the canvas and its
// folder legend use these pigments, including when folders are filtered.
const TONES = [258, 220, 177, 31, 331, 145, 195, 282, 12, 80];
export function constellationColor(index: number, theme: "light" | "dark", alpha?: number): string {
  const hue = TONES[((index % TONES.length) + TONES.length) % TONES.length];
  const saturation = index % TONES.length === 2 ? 39 : 62;
  const lightness = theme === "dark" ? 68 : 52;
  return alpha === undefined
    ? `hsl(${hue}, ${saturation}%, ${lightness}%)`
    : `hsla(${hue}, ${saturation}%, ${lightness}%, ${alpha})`;
}

export interface ConstellationPoint {
  x: number;
  y: number;
  z: number;
}

export function constellationCenters(
  count: number,
  radius: number,
): Map<number, ConstellationPoint> {
  const centers = new Map<number, ConstellationPoint>();
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    // Phyllotaxis across the view, with substantial depth between clusters.
    // A single folder stays centered. No node is constrained to a plane.
    const theta = count === 5 ? [2.65, 1.35, 0, 3.9, 5.15][i] : i * golden + 2.65;
    const r = count === 1 ? 0 : radius * (0.72 + 0.28 * Math.sqrt((i + 1) / count));
    centers.set(i, {
      x: Math.cos(theta) * r * 1.8,
      y: Math.sin(theta) * r,
      z: Math.sin(i * 1.9) * radius * 0.42,
    });
  }
  return centers;
}

export function seedConstellation(
  nodes: FGNode[],
  centers: Map<number, ConstellationPoint>,
  radius: number,
): void {
  for (const node of nodes) {
    if (Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z)) continue;
    let hash = 2166136261;
    for (const char of node.id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    const theta = ((hash >>> 0) / 4294967296) * Math.PI * 2;
    const cosPhi = ((hash >>> 8) % 1000) / 500 - 1;
    const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
    const spread = node.isOrphan
      ? radius * 1.35
      : (18 + ((hash >>> 16) % 60)) / (1 + Math.min(node.linkCount, 30) * 0.1);
    const center = node.isOrphan ? { x: 0, y: 0, z: 0 } : centers.get(node.clusterIndex);
    node.x = (center?.x ?? 0) + Math.cos(theta) * sinPhi * spread;
    node.y = (center?.y ?? 0) + Math.sin(theta) * sinPhi * spread;
    node.z = (center?.z ?? 0) + cosPhi * spread;
  }
}

/** One stable hub label per folder, then (when zoomed in) a bounded detail set. */
export function constellationLabelCandidates(
  nodes: readonly GraphNode[],
  focusedPaths: readonly (string | null | undefined)[],
  limit: number,
  detail: boolean,
): string[] {
  const byPath = new Map(nodes.map((node) => [node.filePath, node]));
  const result = new Set(
    focusedPaths.filter((path): path is string => Boolean(path && byPath.has(path))),
  );
  const ranked = [...nodes].sort(
    (a, b) => b.linkCount - a.linkCount || a.filePath.localeCompare(b.filePath),
  );
  const folders = new Set<number>();
  for (const node of ranked) {
    if (result.size >= limit) break;
    if (node.isOrphan || folders.has(node.clusterIndex)) continue;
    folders.add(node.clusterIndex);
    result.add(node.filePath);
  }
  if (detail) {
    for (const node of ranked) {
      if (result.size >= limit) break;
      if (!node.isOrphan) result.add(node.filePath);
    }
  }
  return [...result];
}
