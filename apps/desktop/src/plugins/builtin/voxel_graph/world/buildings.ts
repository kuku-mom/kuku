// ── Agent World Buildings (instanced) ──
//
// Every note becomes a detailed, textured 3D house model (sculpted by
// image-to-3D, re-skinned with the cel/ink look). Plots are grouped by variant
// and rendered as InstancedMesh batches — one draw call per variant sub-mesh,
// no matter how many notes — so large vaults stay fast. Each plot is sized to a
// tier footprint that stays well within the plot spacing (no overlap) and turned
// to face the plaza. Door/roof anchors are derived synchronously from the plot
// so paths and agents connect even before the GLBs finish loading; the instanced
// meshes are added once loaded. Interaction state is drawn by a separate
// indicator layer, so house materials keep their base tones.

import {
  BoxGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Group,
  Quaternion,
  Vector3,
} from "three";

import type { GraphNode } from "~/plugins/builtin/graph_view/graph_types";

import { stableNoise, type PlotSpec } from "../voxel_layout";
import {
  getHouseVariant,
  houseVariantCount,
  loadHouseModels,
  onHouseModels,
} from "./buildings_model";
import type { InteractionIndicatorAnchor } from "./indicators";
import { type WorldPalette } from "./palette";
import { noOutline } from "./toon";

export interface BuildingsHandle {
  group: Group;
  pickMesh: InstancedMesh;
  nodeForInstance(instanceId: number): GraphNode | null;
  indicatorAnchor(filePath: string): InteractionIndicatorAnchor | null;
  doorPosition(filePath: string): Vector3 | null;
  roofPosition(filePath: string): Vector3 | null;
  update(nowSeconds: number): void;
  dispose(): void;
}

/** Nominal footprint + height per tier (world units), for anchors and pick box.
 *  Plot spacing grew with PLOT_SPACING so these larger footprints still stay
 *  clear of neighbours. */
function tierDims(tier: number): { footprint: number; height: number } {
  switch (tier) {
    case 0:
      return { footprint: 22, height: 20 };
    case 1:
      return { footprint: 27, height: 25 };
    case 2:
      return { footprint: 32, height: 30 };
    default:
      return { footprint: 29, height: 28 };
  }
}

interface Placed {
  plot: PlotSpec;
  variant: number;
  footprint: number;
  doorAnchor: Vector3;
  roofAnchor: Vector3;
}

/** A subtle per-house instanceColor multiplier so the village isn't uniform —
 *  some homes read a touch warmer, cooler, or weathered. Stays near white. */
function houseTone(id: string): Color {
  const t = stableNoise(`${id}:tone`);
  if (t < 0.28) return new Color(1, 0.95, 0.86); // warm timber
  if (t < 0.52) return new Color(0.9, 0.95, 1.02); // cool slate
  if (t < 0.74) return new Color(0.9, 0.9, 0.87); // weathered/dim
  return new Color(1, 1, 1); // neutral
}

export function createBuildings(
  plots: ReadonlyMap<string, PlotSpec>,
  palette: WorldPalette,
): BuildingsHandle {
  const group = new Group();

  // Invisible pick proxy: one bounding box per plot for raycasting.
  const pickGeometry = new BoxGeometry(1, 1, 1);
  const pickMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  noOutline(pickMaterial);
  const pickMesh = new InstancedMesh(pickGeometry, pickMaterial, Math.max(1, plots.size));
  pickMesh.frustumCulled = false;
  pickMesh.count = 0;
  const pickNode: (GraphNode | null)[] = [];
  const pickMatrix = new Matrix4();
  const pickPos = new Vector3();
  const pickQuat = new Quaternion();
  const pickScale = new Vector3();
  const yAxis = new Vector3(0, 1, 0);

  // Opaque interior fill: a solid dim box just inside each house shell, so
  // glimpsing through a window/gap shows a shadowed interior instead of the
  // hollow model's garbled back-face texture. One instanced draw call total.
  const fillGeometry = new BoxGeometry(1, 1, 1);
  const fillMaterial = new MeshBasicMaterial({ color: new Color(palette.beam) });
  noOutline(fillMaterial);
  const fillMesh = new InstancedMesh(fillGeometry, fillMaterial, Math.max(1, plots.size));
  fillMesh.frustumCulled = false;
  fillMesh.count = 0;
  const fillMatrix = new Matrix4();
  const fillPos = new Vector3();
  const fillScale = new Vector3();

  // Soft contact shadow: a flat dark disc laid on the ground under each house to
  // ground it (anchors the building to the terrain instead of floating).
  const shadowGeometry = new CircleGeometry(0.5, 20);
  const shadowMaterial = new MeshBasicMaterial({
    color: new Color("#1d2417"),
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: DoubleSide,
  });
  noOutline(shadowMaterial);
  const shadowMesh = new InstancedMesh(shadowGeometry, shadowMaterial, Math.max(1, plots.size));
  shadowMesh.frustumCulled = false;
  shadowMesh.count = 0;
  shadowMesh.renderOrder = -1;
  const shadowMatrix = new Matrix4();
  const shadowPos = new Vector3();
  const shadowQuat = new Quaternion();
  const shadowScale = new Vector3();
  const flatAxis = new Vector3(1, 0, 0);

  const placed = new Map<string, Placed>();
  const houseMeshes: InstancedMesh[] = [];
  let disposed = false;

  const variantCount = Math.max(1, houseVariantCount());
  let pickIndex = 0;
  for (const plot of plots.values()) {
    const { node, rotationY, tier } = plot;
    const dims = tierDims(tier);
    const surfaceY = plot.position.y;
    const front = new Vector3(Math.sin(rotationY), 0, Math.cos(rotationY));
    const variant = Math.floor(stableNoise(`${node.id}:house`) * variantCount);

    const doorAnchor = new Vector3(
      plot.position.x + front.x * (dims.footprint * 0.5 + 2),
      surfaceY,
      plot.position.z + front.z * (dims.footprint * 0.5 + 2),
    );
    const roofAnchor = new Vector3(plot.position.x, surfaceY + dims.height, plot.position.z);
    placed.set(node.filePath, { plot, variant, footprint: dims.footprint, doorAnchor, roofAnchor });

    pickPos.set(plot.position.x, surfaceY + dims.height / 2, plot.position.z);
    pickQuat.setFromAxisAngle(yAxis, rotationY);
    pickScale.set(dims.footprint, dims.height, dims.footprint);
    pickMatrix.compose(pickPos, pickQuat, pickScale);
    pickMesh.setMatrixAt(pickIndex, pickMatrix);
    pickNode[pickIndex] = node;

    // Interior fill: a dark slab filling most of the wall interior so a sightline
    // through any window lands on it (no see-through, even glancing across to the
    // opposite window). Wide (just inside the walls) is what kills the see-through;
    // height stays under the eaves (nominal footprint includes the roof overhang)
    // so it never pokes through the roof.
    const fillH = dims.height * 0.46;
    fillPos.set(plot.position.x, surfaceY + fillH / 2, plot.position.z);
    fillScale.set(dims.footprint * 0.66, fillH, dims.footprint * 0.66);
    fillMatrix.compose(fillPos, pickQuat, fillScale);
    fillMesh.setMatrixAt(pickIndex, fillMatrix);

    // Ground shadow disc: flat (rotated onto the XZ plane), a touch wider than
    // the footprint, hugging the surface.
    shadowPos.set(plot.position.x, surfaceY + 0.12, plot.position.z);
    shadowQuat.setFromAxisAngle(flatAxis, -Math.PI / 2);
    shadowScale.set(dims.footprint * 1.15, dims.footprint * 1.15, 1);
    shadowMatrix.compose(shadowPos, shadowQuat, shadowScale);
    shadowMesh.setMatrixAt(pickIndex, shadowMatrix);

    pickIndex += 1;
  }
  pickMesh.count = pickIndex;
  pickMesh.instanceMatrix.needsUpdate = true;
  group.add(pickMesh);
  fillMesh.count = pickIndex;
  fillMesh.instanceMatrix.needsUpdate = true;
  group.add(fillMesh);
  shadowMesh.count = pickIndex;
  shadowMesh.instanceMatrix.needsUpdate = true;
  group.add(shadowMesh);

  // Load the house GLBs once, then build one InstancedMesh per variant sub-mesh.
  loadHouseModels(palette, plots.size);
  const unsubscribeHouseModels = onHouseModels(() => {
    if (disposed) return;
    // Group plots by their resolved variant.
    const byVariant = new Map<number, Placed[]>();
    for (const entry of placed.values()) {
      const list = byVariant.get(entry.variant) ?? [];
      list.push(entry);
      byVariant.set(entry.variant, list);
    }

    const tPos = new Matrix4();
    const tRot = new Matrix4();
    const tScale = new Matrix4();
    const tCenter = new Matrix4();
    const matrix = new Matrix4();

    for (const [variantIndex, entries] of byVariant) {
      const variant = getHouseVariant(variantIndex);
      if (!variant) continue;

      // One InstancedMesh per sub-mesh of the variant; all share the per-plot
      // matrices, and each plot maps to the same instance index across them.
      const meshes = variant.parts.map((part) => {
        const inst = new InstancedMesh(part.geometry, part.material.clone(), entries.length);
        inst.userData.outlineParameters = part.material.userData.outlineParameters;
        inst.frustumCulled = false; // spans the world; cheaper to always draw
        return inst;
      });

      for (let i = 0; i < entries.length; i++) {
        const { plot, footprint } = entries[i];
        const scale = footprint / variant.footprint;
        // world = T(plot) · Ry(yaw) · S(scale) · T(-centerX, -minY, -centerZ)
        // so the model is centred in XZ and its base sits on the plot surface.
        tPos.makeTranslation(plot.position.x, plot.position.y, plot.position.z);
        tRot.makeRotationY(plot.rotationY);
        tScale.makeScale(scale, scale, scale);
        tCenter.makeTranslation(-variant.centerX, -variant.minY, -variant.centerZ);
        matrix.copy(tPos).multiply(tRot).multiply(tScale).multiply(tCenter);
        const base = houseTone(plot.node.id);
        for (const inst of meshes) {
          inst.setMatrixAt(i, matrix);
          inst.setColorAt(i, base);
        }
      }

      for (const inst of meshes) {
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        group.add(inst);
        houseMeshes.push(inst);
      }
    }
  });

  function update(_nowSeconds: number): void {
    // Houses are static.
  }

  return {
    group,
    pickMesh,
    nodeForInstance: (id) => pickNode[id] ?? null,
    indicatorAnchor: (filePath) => {
      const entry = placed.get(filePath);
      if (!entry) return null;
      return {
        position: entry.plot.position.clone(),
        radius: entry.footprint * 0.58,
      };
    },
    doorPosition: (filePath) => placed.get(filePath)?.doorAnchor.clone() ?? null,
    roofPosition: (filePath) => placed.get(filePath)?.roofAnchor.clone() ?? null,
    update,
    dispose: () => {
      disposed = true;
      unsubscribeHouseModels();
      for (const mesh of houseMeshes) {
        mesh.dispose();
        (mesh.material as MeshBasicMaterial).dispose();
      }
      pickGeometry.dispose();
      pickMaterial.dispose();
      pickMesh.dispose();
      fillGeometry.dispose();
      fillMaterial.dispose();
      fillMesh.dispose();
      shadowGeometry.dispose();
      shadowMaterial.dispose();
      shadowMesh.dispose();
    },
  };
}
