import { Vector3 } from "three";

import type { GraphLink, GraphNode, GraphState } from "~/plugins/builtin/graph_view/graph_types";

export interface VoxelRoom {
  clusterIndex: number;
  name: string;
  center: Vector3;
  width: number;
  depth: number;
}

export interface VoxelVisibleStats {
  nodes: number;
  links: number;
  totalNodes: number;
  totalLinks: number;
  omittedNodes: number;
  omittedLinks: number;
  capped: boolean;
}

export const VOXEL_UNIT = 16;
export const MAX_NODES_FULL = 520;
export const MAX_NODES_COMPACT = 130;
export const MAX_LINKS_FULL = 1_250;
export const MAX_LINKS_COMPACT = 260;

const UINT32_MAX = 4_294_967_295;

export function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function stableNoise(value: string): number {
  return stableHash(value) / UINT32_MAX;
}

export function snap(value: number): number {
  return Math.round(value / VOXEL_UNIT) * VOXEL_UNIT;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function officeRadius(compact: boolean): number {
  return compact ? 190 : 360;
}

export function roomSize(compact: boolean): { width: number; depth: number } {
  return compact ? { width: 150, depth: 128 } : { width: 220, depth: 180 };
}

export function agentScale(node: GraphNode, compact: boolean): number {
  if (node.isOrphan) return compact ? 0.84 : 0.96;
  return clamp(0.98 + Math.sqrt(Math.max(0, node.linkCount)) * 0.08, 1.02, compact ? 1.22 : 1.48);
}

export function shortLabel(name: string): string {
  return name.length > 28 ? `${name.slice(0, 28)}...` : name;
}

export function selectVisibleNodes(
  state: GraphState,
  _currentFilePath: string | null,
  _compact: boolean,
): GraphNode[] {
  return [...state.nodes];
}

export function selectVisibleLinks(
  state: GraphState,
  includedPaths: Set<string>,
  _currentFilePath: string | null,
  _compact: boolean,
): GraphLink[] {
  return state.links.filter(
    (link) => includedPaths.has(link.source) && includedPaths.has(link.target),
  );
}

export function getVoxelVisibleStats(
  state: GraphState | null | undefined,
  currentFilePath: string | null,
  compact: boolean,
): VoxelVisibleStats {
  if (!state) {
    return {
      nodes: 0,
      links: 0,
      totalNodes: 0,
      totalLinks: 0,
      omittedNodes: 0,
      omittedLinks: 0,
      capped: false,
    };
  }

  const visibleNodes = selectVisibleNodes(state, currentFilePath, compact);
  const includedPaths = new Set(visibleNodes.map((node) => node.filePath));
  const visibleLinks = selectVisibleLinks(state, includedPaths, currentFilePath, compact);
  const omittedNodes = Math.max(0, state.nodes.length - visibleNodes.length);
  const omittedLinks = Math.max(0, state.links.length - visibleLinks.length);

  return {
    nodes: visibleNodes.length,
    links: visibleLinks.length,
    totalNodes: state.nodes.length,
    totalLinks: state.links.length,
    omittedNodes,
    omittedLinks,
    capped: omittedNodes > 0 || omittedLinks > 0,
  };
}

export function createRoomsForNodes(
  nodes: readonly GraphNode[],
  clusters: readonly string[],
  compact: boolean,
): VoxelRoom[] {
  const roomEntries = [...new Set(nodes.map((node) => node.clusterIndex))]
    .sort((left, right) => left - right)
    .map((clusterIndex) => ({
      clusterIndex,
      name: clusters[clusterIndex] ?? "Root",
    }));

  if (roomEntries.length === 0) {
    roomEntries.push({ clusterIndex: 0, name: "Root" });
  }

  const { width, depth } = roomSize(compact);
  const count = roomEntries.length;
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const gap = compact ? 30 : 46;
  const totalWidth = columns * width + (columns - 1) * gap;
  const totalDepth = rows * depth + (rows - 1) * gap;

  return roomEntries.map((entry, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    return {
      clusterIndex: entry.clusterIndex,
      name: entry.name,
      center: new Vector3(
        col * (width + gap) - totalWidth / 2 + width / 2,
        0,
        row * (depth + gap) - totalDepth / 2 + depth / 2,
      ),
      width,
      depth,
    };
  });
}

export function roomForNode(node: GraphNode, rooms: readonly VoxelRoom[]): VoxelRoom {
  return rooms.find((room) => room.clusterIndex === node.clusterIndex) ?? rooms[0];
}

export function homeForNode(
  node: GraphNode,
  room: VoxelRoom,
  index: number,
  roomMateCount: number,
): Vector3 {
  const cols = Math.max(2, Math.ceil(Math.sqrt(roomMateCount)));
  const row = Math.floor(index / cols);
  const col = index % cols;
  const xPad = room.width * 0.22;
  const zPad = room.depth * 0.24;
  const xStep = (room.width - xPad * 2) / Math.max(1, cols - 1);
  const zStep = (room.depth - zPad * 2) / Math.max(1, Math.ceil(roomMateCount / cols) - 1);
  const jitterX = (stableNoise(`${node.id}:jx`) * 2 - 1) * VOXEL_UNIT * 0.6;
  const jitterZ = (stableNoise(`${node.id}:jz`) * 2 - 1) * VOXEL_UNIT * 0.6;

  return new Vector3(
    snap(room.center.x - room.width / 2 + xPad + col * xStep + jitterX),
    0,
    snap(room.center.z - room.depth / 2 + zPad + row * zStep + jitterZ),
  );
}

export function roomLabelText(roomName: string): string {
  const name = roomName.split("/").filter(Boolean).at(-1) ?? roomName;
  return name.length > 18 ? `${name.slice(0, 18)}...` : name || "Root";
}
