// ── Interaction Indicators ──
//
// Small instanced ring layer used for focus/hover/selection. It stays separate
// from the house and character materials so interaction feedback does not
// repaint the models themselves.

import {
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  RingGeometry,
  Vector3,
} from "three";

import { type WorldPalette } from "./palette";
import { noOutline } from "./toon";

export type InteractionIndicatorKind = "focus" | "hover" | "selected";

export interface InteractionIndicatorAnchor {
  position: Vector3;
  radius: number;
}

export interface InteractionIndicatorEntry {
  kind: InteractionIndicatorKind;
  anchor: InteractionIndicatorAnchor;
  tone?: "default" | "character";
}

export interface InteractionIndicatorsHandle {
  mesh: InstancedMesh;
  write(entries: readonly InteractionIndicatorEntry[], nowSeconds: number): void;
  clear(): void;
  dispose(): void;
}

const CAPACITY = 3;
// Draw after terrain/shadow layers, but keep depth testing so GLB houses and
// characters still occlude the ring when they overlap it.
const INDICATOR_RENDER_ORDER = 20;
const INDICATOR_GROUND_OFFSET = 0.72;
const HIDDEN_MATRIX = new Matrix4().makeScale(0, 0, 0);
const FLAT_QUATERNION = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);

const tmpMatrix = new Matrix4();
const tmpPosition = new Vector3();
const tmpScale = new Vector3();
const tmpColor = new Color();

interface IndicatorStyle {
  color: string;
  radiusScale: number;
  pulse: number;
  speed: number;
}

function styleFor(entry: InteractionIndicatorEntry, palette: WorldPalette): IndicatorStyle {
  if (entry.tone === "character") {
    switch (entry.kind) {
      case "selected":
        return { color: "#fffaf0", radiusScale: 0.92, pulse: 0.025, speed: 2.9 };
      case "hover":
        return { color: "#ffffff", radiusScale: 0.86, pulse: 0.018, speed: 4.2 };
      case "focus":
      default:
        return { color: "#fff7d8", radiusScale: 0.9, pulse: 0.02, speed: 2.1 };
    }
  }

  switch (entry.kind) {
    case "selected":
      return { color: palette.focusFlag, radiusScale: 1.08, pulse: 0.045, speed: 2.9 };
    case "hover":
      return { color: "#ffffff", radiusScale: 1, pulse: 0.025, speed: 4.2 };
    case "focus":
    default:
      return { color: palette.beacon, radiusScale: 1.04, pulse: 0.035, speed: 2.1 };
  }
}

export function createInteractionIndicators(palette: WorldPalette): InteractionIndicatorsHandle {
  const geometry = new RingGeometry(0.78, 1, 48, 1);
  const material = new MeshBasicMaterial({
    color: "#ffffff",
    transparent: true,
    opacity: 0.78,
    depthTest: true,
    depthWrite: false,
    side: DoubleSide,
  });
  noOutline(material);

  const mesh = new InstancedMesh(geometry, material, CAPACITY);
  mesh.name = "voxel-interaction-indicators";
  mesh.count = CAPACITY;
  mesh.frustumCulled = false;
  mesh.renderOrder = INDICATOR_RENDER_ORDER;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);

  for (let index = 0; index < CAPACITY; index++) {
    mesh.setMatrixAt(index, HIDDEN_MATRIX);
    mesh.setColorAt(index, tmpColor.set("#ffffff"));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  function hideFrom(startIndex: number): void {
    for (let index = startIndex; index < CAPACITY; index++) {
      mesh.setMatrixAt(index, HIDDEN_MATRIX);
    }
  }

  function write(entries: readonly InteractionIndicatorEntry[], nowSeconds: number): void {
    const count = Math.min(CAPACITY, entries.length);
    for (let index = 0; index < count; index++) {
      const { anchor } = entries[index];
      const style = styleFor(entries[index], palette);
      const pulse = 1 + Math.sin(nowSeconds * style.speed + index * 0.72) * style.pulse;
      const radius = Math.max(0.1, anchor.radius * style.radiusScale * pulse);
      tmpPosition.set(
        anchor.position.x,
        anchor.position.y + INDICATOR_GROUND_OFFSET + index * 0.035,
        anchor.position.z,
      );
      tmpScale.set(radius, radius, 1);
      tmpMatrix.compose(tmpPosition, FLAT_QUATERNION, tmpScale);
      mesh.setMatrixAt(index, tmpMatrix);
      mesh.setColorAt(index, tmpColor.set(style.color));
    }
    hideFrom(count);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  return {
    mesh,
    write,
    clear: () => {
      hideFrom(0);
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
