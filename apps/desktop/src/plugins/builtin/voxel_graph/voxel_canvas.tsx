// Voxel office graph canvas.
//
// This renderer treats the graph as an isometric office diorama: every note is
// a tiny workstation with a seated voxel agent, desk, iMac, and keyboard. The
// expensive repeating geometry is rendered with InstancedMesh so all graph
// nodes can stay visible without creating thousands of individual Three.js
// objects.

import {
  FitViewIcon,
  LocateIcon,
  ResetViewIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "~/components/icons";

import {
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  ACESFilmicToneMapping,
  AmbientLight,
  AlwaysDepth,
  BackSide,
  BoxGeometry,
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  DirectionalLight,
  Euler,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
  type MeshBasicMaterialParameters,
  type MeshStandardMaterialParameters,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import SpriteText from "three-spritetext";

import { t, tf } from "~/i18n";
import {
  getGraphSummary,
  type GraphLink,
  type GraphNode,
  type GraphVariant,
} from "~/plugins/builtin/graph_view/graph_types";
import { getEffectiveTheme } from "~/stores/theme";

import { clamp, roomLabelText, shortLabel, stableNoise, type VoxelRoom } from "./voxel_layout";
import { getVoxelGraphStore } from "./voxel_store";

interface VoxelCanvasProps {
  variant: GraphVariant;
  currentFilePath?: string | null;
  onNodeClick?: (node: GraphNode) => void;
  initialFollowMode?: boolean;
  class?: string;
}

interface OfficeRoom extends VoxelRoom {
  columns: number;
  rows: number;
  cellWidth: number;
  cellDepth: number;
  nodeCount: number;
  elevation: number;
  totalDocumentLength: number;
  averageDocumentLength: number;
  maxDocumentLength: number;
  averageLinkCount: number;
  maxLinkCount: number;
}

type CharacterType =
  | "operator"
  | "robot"
  | "astronaut"
  | "wizard"
  | "hero"
  | "holiday"
  | "ranger"
  | "creature";

interface OfficeMeshes {
  body: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  shirtPanel: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  collar: InstancedMesh<BoxGeometry, MeshBasicMaterial>;
  head: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  headHighlight: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  hair: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  hairFront: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  hairSide: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  eye: InstancedMesh<BoxGeometry, MeshBasicMaterial>;
  brow: InstancedMesh<BoxGeometry, MeshBasicMaterial>;
  cheek: InstancedMesh<BoxGeometry, MeshBasicMaterial>;
  nose: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  mouth: InstancedMesh<BoxGeometry, MeshBasicMaterial>;
  beard: InstancedMesh<BoxGeometry, MeshBasicMaterial>;
  headsetBand: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  headsetEar: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  headsetMic: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  hatBrim: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  hatCrown: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  hatTip: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  visor: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  visorGlint: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  chestPanel: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  chestButton: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  outfitBelt: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  outfitSash: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  shoulderPad: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  sleeveCuff: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  bootTrim: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  helmetSide: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  cape: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  backpack: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  antennaBase: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  antennaTip: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  leftArm: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  rightArm: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  leftHand: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  rightHand: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  leftLeg: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  rightLeg: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  shoe: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  badge: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  signal: InstancedMesh<BoxGeometry, MeshBasicMaterial>;
  shadow: InstancedMesh<BoxGeometry, MeshBasicMaterial>;
  desk: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  deskLeg: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  chair: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  chairBack: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  chairBase: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  chairWheel: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  monitorFrame: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  monitor: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  monitorLogo: InstancedMesh<BoxGeometry, MeshBasicMaterial>;
  screenPixel: InstancedMesh<BoxGeometry, MeshBasicMaterial>;
  monitorStand: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  keyboard: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  keyboardKey: InstancedMesh<BoxGeometry, MeshBasicMaterial>;
  mouse: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  mug: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  notebook: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
  paperStack: InstancedMesh<BoxGeometry, MeshStandardMaterial>;
}

interface VoxelRuntimeNode {
  node: GraphNode;
  instanceIndex: number;
  position: Vector3;
  room: OfficeRoom;
  size: number;
  heading: number;
  characterType: CharacterType;
  skinColor: string;
  hairColor: string;
  headTopColor: string;
  faceShadowColor: string;
  accessoryColor: string;
  secondaryColor: string;
  visorColor: string;
  trimColor: string;
  patternColor: string;
  outfitVariant: number;
  headsetColor: string;
  chairColor: string;
  deskColor: string;
  deskAccentColor: string;
  shirtColor: string;
  pantsColor: string;
  shoeColor: string;
  idlePhase: number;
  idleSpeed: number;
  typingPhase: number;
  clickPulseUntil: number;
}

interface VoxelRuntimeLink {
  source: VoxelRuntimeNode;
  target: VoxelRuntimeNode;
  link: GraphLink;
}

interface CameraTween {
  fromPosition: Vector3;
  toPosition: Vector3;
  fromTarget: Vector3;
  toTarget: Vector3;
  startedAt: number;
  duration: number;
}

interface VisibleStats {
  nodes: number;
  links: number;
}

interface VoxelBoxInstance {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
}

interface VoxelBoxBatch {
  add: (
    material: MeshStandardMaterial | MeshBasicMaterial,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ) => void;
  flush: () => void;
}

type StationWriteMode = "full" | "motion";

interface EnvironmentAnimState {
  waterMaterials: MeshStandardMaterial[];
  skyDome?: Mesh;
}

interface RetroSkyPalette {
  top: string;
  mid: string;
  bottom: string;
  band: string;
  line: string;
}

interface BookMaterials {
  bookBlue: MeshStandardMaterial;
  bookRed: MeshStandardMaterial;
  bookYellow: MeshStandardMaterial;
}

const TAU = Math.PI * 2;
const Y_AXIS = new Vector3(0, 1, 0);
const LINK_UP = new Vector3(0, 1, 0);
const OFFICE_CLUSTER_COLORS = [
  "#12679d",
  "#c46d2e",
  "#2f8f57",
  "#c83a2b",
  "#d4a520",
  "#008b8f",
  "#8f5a2a",
  "#5c7f2e",
  "#e1b232",
  "#155f8d",
];
const RETRO_INK = "#0b2138";
const RETRO_CREAM = "#d8c27a";
const RETRO_PAPER = "#e1d19a";
const RETRO_BLUE = "#12679d";
const RETRO_CYAN = "#0f9aa7";
const RETRO_GREEN = "#2f8f57";
const RETRO_RED = "#c83a2b";
const RETRO_YELLOW = "#d4a520";
const RETRO_ORANGE = "#c46d2e";
const RETRO_SLATE = "#526a73";
const RETRO_STEEL = "#6f8790";
const HAIR_COLORS = ["#6a3f2b", "#8a5236", "#a96a38", "#c58b43", "#4f4a40", "#9f4e38", "#355f4f"];
const SKIN_COLORS = ["#d9975f", "#c98250", "#b96d43", "#a95e3d", "#8f4d35"];
const HEADSET_COLORS = [RETRO_BLUE, RETRO_CYAN, RETRO_GREEN, RETRO_RED, RETRO_YELLOW, "#3f4a4e"];
const CHAIR_COLORS = ["#315f74", "#2f6f5a", "#9b6a36", "#7c4f32", "#54646b", "#b24a35"];
const DESK_COLORS = ["#d7b56d", "#cda45f", "#b97a48", "#b8a16a", "#c68652"];
const PANTS_COLORS = ["#255f89", "#2f7752", "#9c5f34", "#6e5840", "#78513a", "#197e85"];
const SHOE_COLORS = ["#7b4a2d", "#4d5457", "#8f5a2e", "#5c4535", "#8a6a2f"];
const IDLE_SHIRT_COLORS = [
  RETRO_BLUE,
  RETRO_GREEN,
  RETRO_YELLOW,
  RETRO_RED,
  RETRO_CYAN,
  RETRO_CREAM,
  RETRO_ORANGE,
];
const ACCESSORY_COLORS = [
  RETRO_RED,
  RETRO_YELLOW,
  RETRO_CYAN,
  RETRO_BLUE,
  RETRO_GREEN,
  RETRO_ORANGE,
  RETRO_PAPER,
];
const SECONDARY_COLORS = [
  RETRO_INK,
  RETRO_PAPER,
  RETRO_BLUE,
  RETRO_ORANGE,
  RETRO_GREEN,
  RETRO_RED,
  RETRO_STEEL,
];
const VISOR_COLORS = ["#19a9d0", "#1fb7c4", "#26b76a", "#e0bc2f", "#b9d7d4"];
const TRIM_COLORS = [
  RETRO_PAPER,
  RETRO_YELLOW,
  RETRO_RED,
  "#19a9d0",
  RETRO_GREEN,
  RETRO_ORANGE,
  RETRO_INK,
];
const PATTERN_COLORS = [
  RETRO_INK,
  RETRO_RED,
  RETRO_BLUE,
  RETRO_YELLOW,
  RETRO_GREEN,
  RETRO_ORANGE,
  RETRO_PAPER,
];
const WIZARD_HAT_COLORS = [RETRO_BLUE, RETRO_GREEN, RETRO_RED, RETRO_YELLOW, RETRO_PAPER];
const RANGER_HAT_COLORS = ["#a86635", "#7b4a2d", "#2f8f6a", RETRO_BLUE, "#c6a052"];
const HOLIDAY_HAT_COLORS = [RETRO_RED, RETRO_GREEN, RETRO_PAPER, RETRO_BLUE, RETRO_YELLOW];

const tmpMatrix = new Matrix4();
const tmpQuaternion = new Quaternion();
const tmpLocalQuaternion = new Quaternion();
const tmpEuler = new Euler();
const tmpPosition = new Vector3();
const tmpScale = new Vector3();
const tmpColor = new Color();
const tmpDirection = new Vector3();
const tmpSource = new Vector3();
const tmpTarget = new Vector3();
const tmpArcStart = new Vector3();
const tmpArcA = new Vector3();
const tmpArcB = new Vector3();
const tmpArcEnd = new Vector3();
const CAMERA_NEAR_PLANE = 12;
const CAMERA_FAR_MIN = 3_600;
const CAMERA_FAR_MAX = 14_000;
const CAMERA_MIN_POLAR_ANGLE = Math.PI * 0.2;
const CAMERA_MAX_POLAR_ANGLE = Math.PI * 0.4;
const CAMERA_MIN_DISTANCE = 118;
const CAMERA_COMPACT_MIN_DISTANCE = 86;
const CAMERA_CLOSE_ZOOM_RATIO = 0.18;
const CAMERA_COMPACT_CLOSE_ZOOM_RATIO = 0.24;

function easeInOutCubic(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

function isometricCameraPosition(radius: number): Vector3 {
  return new Vector3(radius * 1.22, radius * 1.18, radius * 1.18);
}

function isometricCameraTarget(): Vector3 {
  return new Vector3(0, 12, 0);
}

function officeClusterColor(clusterIndex: number): string {
  return OFFICE_CLUSTER_COLORS[Math.abs(clusterIndex) % OFFICE_CLUSTER_COLORS.length];
}

function skinColorForNode(node: GraphNode): string {
  const index = Math.floor(stableNoise(`${node.id}:skin`) * SKIN_COLORS.length);
  return SKIN_COLORS[Math.min(index, SKIN_COLORS.length - 1)];
}

function hairColorForNode(node: GraphNode): string {
  const index = Math.floor(stableNoise(`${node.id}:hair`) * HAIR_COLORS.length);
  return HAIR_COLORS[Math.min(index, HAIR_COLORS.length - 1)];
}

function paletteColorForNode(node: GraphNode, palette: readonly string[], salt: string): string {
  const index = Math.floor(stableNoise(`${node.id}:${salt}`) * palette.length);
  return palette[Math.min(index, palette.length - 1)];
}

function stableIndexForNode(node: GraphNode, length: number, salt: string): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.floor(stableNoise(`${node.id}:${salt}`) * length));
}

function pickCharacterTypeForNode(
  node: GraphNode,
  pool: readonly CharacterType[],
  salt: string,
): CharacterType {
  const index =
    outfitVariantForNode(node) +
    stableIndexForNode(node, pool.length, salt) +
    documentLengthTier(node) +
    linkCountTier(node) +
    node.clusterIndex;
  return pool[Math.abs(index) % pool.length];
}

function characterTypeForNode(node: GraphNode): CharacterType {
  const lengthTier = documentLengthTier(node);
  const degreeTier = linkCountTier(node);
  if (degreeTier >= 3 && lengthTier >= 3) {
    return pickCharacterTypeForNode(
      node,
      ["astronaut", "hero", "robot", "ranger", "wizard", "operator"],
      "elite-role",
    );
  }
  if (degreeTier >= 3)
    return pickCharacterTypeForNode(
      node,
      ["hero", "robot", "operator", "ranger", "astronaut"],
      "hub-role",
    );
  if (lengthTier >= 4) {
    return pickCharacterTypeForNode(
      node,
      ["wizard", "ranger", "astronaut", "operator", "hero", "holiday"],
      "long-role",
    );
  }
  if (degreeTier >= 2 && lengthTier >= 2) {
    return pickCharacterTypeForNode(
      node,
      ["robot", "hero", "ranger", "operator", "astronaut", "wizard"],
      "deep-linked-role",
    );
  }
  if (degreeTier >= 2)
    return pickCharacterTypeForNode(
      node,
      ["robot", "ranger", "hero", "operator", "holiday"],
      "linked-role",
    );
  if (lengthTier >= 3)
    return pickCharacterTypeForNode(
      node,
      ["wizard", "operator", "ranger", "astronaut", "hero"],
      "long-lite-role",
    );
  if (lengthTier >= 2)
    return pickCharacterTypeForNode(
      node,
      ["operator", "ranger", "holiday", "robot", "creature"],
      "medium-role",
    );
  if (degreeTier === 1)
    return pickCharacterTypeForNode(
      node,
      ["holiday", "operator", "ranger", "creature", "robot"],
      "single-link-role",
    );
  return pickCharacterTypeForNode(
    node,
    ["creature", "operator", "holiday", "robot", "ranger"],
    "quiet-role",
  );
}

function skinColorForCharacter(
  node: GraphNode,
  characterType: CharacterType,
  baseColor: string,
): string {
  if (characterType === "robot")
    return paletteColorForNode(node, ["#8fa0a2", "#6f8790", "#a6aaa0"], "robot-skin");
  if (characterType === "astronaut") return RETRO_PAPER;
  if (characterType === "creature") {
    return paletteColorForNode(
      node,
      [RETRO_GREEN, "#25794b", "#5d8b36", RETRO_CYAN],
      "creature-skin",
    );
  }
  return baseColor;
}

function documentLengthForNode(node: GraphNode): number {
  return Math.max(0, node.documentLength ?? 0);
}

function documentLengthTier(node: GraphNode): number {
  const length = documentLengthForNode(node);
  if (length >= 4_200) return 4;
  if (length >= 2_400) return 3;
  if (length >= 1_100) return 2;
  if (length >= 420) return 1;
  return 0;
}

function linkCountTier(node: GraphNode): number {
  if (node.linkCount >= 10) return 3;
  if (node.linkCount >= 5) return 2;
  if (node.linkCount >= 1) return 1;
  return 0;
}

function documentScaleForNode(node: GraphNode): number {
  return clamp(Math.log10(documentLengthForNode(node) + 80) / 3.25, 0.34, 1.24);
}

function outfitVariantForNode(node: GraphNode): number {
  const lineCount = node.lineCount ?? 0;
  const wordCount = node.wordCount ?? 0;
  const stableOffset = stableIndexForNode(node, 4, "outfit-variant");
  return (
    Math.abs(
      documentLengthTier(node) * 3 + linkCountTier(node) * 5 + lineCount + wordCount + stableOffset,
    ) % 4
  );
}

function dataPaletteColorForNode(node: GraphNode, palette: readonly string[], offset = 0): string {
  const stableOffset = stableIndexForNode(node, palette.length, `data-palette:${offset}`);
  const index =
    Math.abs(
      outfitVariantForNode(node) +
        documentLengthTier(node) * 2 +
        linkCountTier(node) * 3 +
        node.clusterIndex +
        stableOffset +
        offset,
    ) % palette.length;
  return palette[index];
}

function shirtColorForCharacter(
  node: GraphNode,
  characterType: CharacterType,
  baseColor: string,
): string {
  if (characterType === "robot")
    return paletteColorForNode(node, ["#526a73", "#445b62", "#1b6f8e"], "robot-suit");
  if (characterType === "astronaut") return RETRO_PAPER;
  if (characterType === "wizard")
    return paletteColorForNode(
      node,
      [RETRO_BLUE, RETRO_GREEN, RETRO_CYAN, RETRO_RED, RETRO_YELLOW],
      "wizard-robe",
    );
  if (characterType === "hero")
    return paletteColorForNode(node, [RETRO_INK, RETRO_RED, RETRO_BLUE], "hero-suit");
  if (characterType === "holiday")
    return paletteColorForNode(node, [RETRO_RED, RETRO_GREEN, RETRO_PAPER], "holiday-suit");
  if (characterType === "ranger")
    return paletteColorForNode(node, ["#9b6a36", RETRO_BLUE, RETRO_GREEN], "ranger-suit");
  if (characterType === "creature")
    return paletteColorForNode(node, [RETRO_GREEN, RETRO_CYAN, "#6b8f2e"], "creature-suit");
  return baseColor;
}

function pantsColorForCharacter(node: GraphNode, characterType: CharacterType): string {
  if (characterType === "robot")
    return paletteColorForNode(node, ["#4f636d", "#748995", "#2f5366"], "robot-pants");
  if (characterType === "astronaut") return "#d8c99d";
  if (characterType === "wizard")
    return paletteColorForNode(node, ["#18324a", "#2f8f6a", "#8a5c34"], "wizard-pants");
  if (characterType === "hero")
    return paletteColorForNode(node, ["#102132", "#32435c", "#8f2f2f"], "hero-pants");
  if (characterType === "holiday")
    return paletteColorForNode(node, [RETRO_PAPER, RETRO_GREEN, RETRO_RED], "holiday-pants");
  if (characterType === "ranger")
    return paletteColorForNode(node, ["#7b5338", "#286b8e", "#5f6f72"], "ranger-pants");
  if (characterType === "creature")
    return paletteColorForNode(node, ["#378e5a", "#2a9d78", "#278c87"], "creature-pants");
  return paletteColorForNode(node, PANTS_COLORS, "pants");
}

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace("#", "");
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function mixHexColor(baseColor: string, mixColor: string, amount: number): string {
  const base = parseHexColor(baseColor);
  const mix = parseHexColor(mixColor);
  const channel = (left: number, right: number) =>
    Math.round(left * (1 - amount) + right * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(base.r, mix.r)}${channel(base.g, mix.g)}${channel(base.b, mix.b)}`;
}

function agentScale(node: GraphNode, compact: boolean): number {
  if (node.isOrphan) return compact ? 0.76 : 0.9;
  return clamp(0.88 + Math.sqrt(Math.max(0, node.linkCount)) * 0.045, 0.9, compact ? 1.02 : 1.16);
}

function agentLinkPoint(runtime: VoxelRuntimeNode): Vector3 {
  return runtime.position.clone().add(new Vector3(0, 17 * runtime.size, 5 * runtime.size));
}

function bookMaterialForSlot(slot: number, materials: BookMaterials): MeshStandardMaterial {
  if (slot % 3 === 0) return materials.bookBlue;
  if (slot % 3 === 1) return materials.bookRed;
  return materials.bookYellow;
}

function disposeMaterial(material: Material | Material[]): void {
  if (Array.isArray(material)) {
    for (const item of material) disposeMaterial(item);
    return;
  }
  const mappedMaterial = material as Material & {
    map?: { dispose: () => void } | null;
    alphaMap?: { dispose: () => void } | null;
    emissiveMap?: { dispose: () => void } | null;
  };
  mappedMaterial.map?.dispose();
  mappedMaterial.alphaMap?.dispose();
  mappedMaterial.emissiveMap?.dispose();
  material.dispose();
}

function disposeObject(
  object: Object3D,
  options: { preserveGeometry?: (geometry: BufferGeometry) => boolean } = {},
): void {
  const disposedMaterials = new Set<Material>();
  object.traverse((child) => {
    const disposable = child as Object3D & {
      geometry?: BufferGeometry;
      material?: Material | Material[];
    };
    if (disposable.geometry && !options.preserveGeometry?.(disposable.geometry)) {
      disposable.geometry.dispose();
    }
    if (Array.isArray(disposable.material)) {
      for (const material of disposable.material) {
        if (disposedMaterials.has(material)) continue;
        disposedMaterials.add(material);
        disposeMaterial(material);
      }
    } else if (disposable.material && !disposedMaterials.has(disposable.material)) {
      disposedMaterials.add(disposable.material);
      disposeMaterial(disposable.material);
    }
  });
}

function standardMaterial(color: string, options: MeshStandardMaterialParameters = {}) {
  const material = new MeshStandardMaterial({
    color: "#ffffff",
    vertexColors: true,
    roughness: 0.68,
    metalness: 0.02,
    emissive: color,
    emissiveIntensity: 0.18,
    flatShading: true,
    ...options,
  });
  material.needsUpdate = true;
  return material;
}

function basicMaterial(color: string, options: MeshBasicMaterialParameters = {}) {
  const material = new MeshBasicMaterial({
    color,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    ...options,
  });
  material.needsUpdate = true;
  return material;
}

function roomForNode(node: GraphNode, rooms: readonly OfficeRoom[]): OfficeRoom {
  return rooms.find((room) => room.clusterIndex === node.clusterIndex) ?? rooms[0];
}

function createOfficeRooms(
  nodes: readonly GraphNode[],
  clusters: readonly string[],
  compact: boolean,
): OfficeRoom[] {
  const groups = new Map<number, GraphNode[]>();
  for (const node of nodes)
    groups.set(node.clusterIndex, [...(groups.get(node.clusterIndex) ?? []), node]);

  const entries = [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([clusterIndex, groupNodes]) => {
      const nodeCount = groupNodes.length;
      const totalDocumentLength = groupNodes.reduce(
        (sum, node) => sum + documentLengthForNode(node),
        0,
      );
      const totalLinkCount = groupNodes.reduce((sum, node) => sum + node.linkCount, 0);
      const maxDocumentLength = Math.max(0, ...groupNodes.map(documentLengthForNode));
      const maxLinkCount = Math.max(0, ...groupNodes.map((node) => node.linkCount));
      const cellWidth = compact ? 40 : 52;
      const cellDepth = compact ? 38 : 48;
      const columns = Math.max(2, Math.ceil(Math.sqrt(nodeCount * 1.08)));
      const rows = Math.max(1, Math.ceil(nodeCount / columns));
      const width = Math.max(compact ? 176 : 242, columns * cellWidth + (compact ? 82 : 112));
      const depth = Math.max(compact ? 150 : 202, rows * cellDepth + (compact ? 78 : 104));
      const elevationStep = compact ? 12 : 18;
      const elevationBand = Math.floor(stableNoise(`voxel-room:${clusterIndex}:elevation`) * 4);
      return {
        clusterIndex,
        name: clusters[clusterIndex] ?? "Root",
        center: new Vector3(),
        width,
        depth,
        columns,
        rows,
        cellWidth,
        cellDepth,
        nodeCount,
        elevation: (elevationBand - 1) * elevationStep,
        totalDocumentLength,
        averageDocumentLength: nodeCount === 0 ? 0 : totalDocumentLength / nodeCount,
        maxDocumentLength,
        averageLinkCount: nodeCount === 0 ? 0 : totalLinkCount / nodeCount,
        maxLinkCount,
      };
    });

  if (entries.length === 0) {
    entries.push({
      clusterIndex: 0,
      name: "Root",
      center: new Vector3(),
      width: compact ? 176 : 242,
      depth: compact ? 150 : 202,
      columns: 2,
      rows: 1,
      cellWidth: compact ? 40 : 52,
      cellDepth: compact ? 38 : 48,
      nodeCount: 0,
      elevation: 0,
      totalDocumentLength: 0,
      averageDocumentLength: 0,
      maxDocumentLength: 0,
      averageLinkCount: 0,
      maxLinkCount: 0,
    });
  }

  const roomColumns = Math.max(1, Math.ceil(Math.sqrt(entries.length)));
  const rowChunks: OfficeRoom[][] = [];
  for (let index = 0; index < entries.length; index += roomColumns) {
    rowChunks.push(entries.slice(index, index + roomColumns));
  }

  const gap = compact ? 126 : 176;
  const rowWidths = rowChunks.map(
    (row) => row.reduce((sum, room) => sum + room.width, 0) + gap * (row.length - 1),
  );
  const rowDepths = rowChunks.map((row) => Math.max(...row.map((room) => room.depth)));
  const totalDepth =
    rowDepths.reduce((sum, depth) => sum + depth, 0) + gap * (rowDepths.length - 1);

  let z = -totalDepth / 2;
  rowChunks.forEach((row, rowIndex) => {
    const rowWidth = rowWidths[rowIndex];
    const rowDepth = rowDepths[rowIndex];
    let x = -rowWidth / 2;
    for (const room of row) {
      room.center.set(x + room.width / 2, 0, z + rowDepth / 2);
      const rowStagger = (rowIndex % 2 === 0 ? -1 : 1) * gap * 0.34;
      const islandJitterX = (stableNoise(`${room.name}:island-jitter:x`) * 2 - 1) * gap * 0.22;
      const islandJitterZ = (stableNoise(`${room.name}:island-jitter:z`) * 2 - 1) * gap * 0.26;
      room.center.x += rowStagger + islandJitterX;
      room.center.z += islandJitterZ;
      x += room.width + gap;
    }
    z += rowDepth + gap;
  });

  return entries;
}

function roomStationPosition(
  node: GraphNode,
  room: OfficeRoom,
  index: number,
  compact: boolean,
): Vector3 {
  const row = Math.floor(index / room.columns);
  const col = index % room.columns;
  const xStart = room.center.x - ((room.columns - 1) * room.cellWidth) / 2;
  const zStart = room.center.z - ((room.rows - 1) * room.cellDepth) / 2;
  const jitterX = (stableNoise(`${node.id}:station:x`) * 2 - 1) * (compact ? 1.25 : 1.8);
  const jitterZ = (stableNoise(`${node.id}:station:z`) * 2 - 1) * (compact ? 1.15 : 1.65);
  return new Vector3(
    xStart + col * room.cellWidth + jitterX,
    room.elevation,
    zStart + row * room.cellDepth + jitterZ,
  );
}

function setInstance(
  mesh: InstancedMesh<BoxGeometry, Material>,
  index: number,
  base: Vector3,
  heading: number,
  rel: Vector3,
  size: Vector3,
  color?: string,
  scaleBoost = 1,
  localRotationX = 0,
  localRotationY = 0,
  localRotationZ = 0,
): void {
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  tmpPosition.set(
    base.x + rel.x * cos + rel.z * sin,
    base.y + rel.y,
    base.z - rel.x * sin + rel.z * cos,
  );
  tmpQuaternion.setFromAxisAngle(Y_AXIS, heading);
  if (localRotationX !== 0 || localRotationY !== 0 || localRotationZ !== 0) {
    tmpEuler.set(localRotationX, localRotationY, localRotationZ);
    tmpLocalQuaternion.setFromEuler(tmpEuler);
    tmpQuaternion.multiply(tmpLocalQuaternion);
  }
  tmpScale.set(size.x * scaleBoost, size.y * scaleBoost, size.z * scaleBoost);
  tmpMatrix.compose(tmpPosition, tmpQuaternion, tmpScale);
  mesh.setMatrixAt(index, tmpMatrix);
  if (color) mesh.setColorAt(index, tmpColor.set(color));
}

function hideInstance(mesh: InstancedMesh<BoxGeometry, Material>, index: number): void {
  tmpMatrix.makeScale(0, 0, 0);
  mesh.setMatrixAt(index, tmpMatrix);
}

function setBeamInstance(
  mesh: InstancedMesh<BoxGeometry, MeshBasicMaterial>,
  index: number,
  source: Vector3,
  target: Vector3,
  width: number,
  color: string,
): void {
  tmpDirection.subVectors(target, source);
  const length = tmpDirection.length();
  if (length <= 0.1) {
    tmpMatrix.makeScale(0, 0, 0);
  } else {
    tmpPosition.lerpVectors(source, target, 0.5);
    tmpQuaternion.setFromUnitVectors(LINK_UP, tmpDirection.normalize());
    tmpScale.set(width, length, width);
    tmpMatrix.compose(tmpPosition, tmpQuaternion, tmpScale);
  }
  mesh.setMatrixAt(index, tmpMatrix);
  mesh.setColorAt(index, tmpColor.set(color));
}

function setArcBeamInstances(
  mesh: InstancedMesh<BoxGeometry, MeshBasicMaterial>,
  index: number,
  source: Vector3,
  target: Vector3,
  width: number,
  color: string,
  liftBoost = 0,
): number {
  const planarDistance = Math.hypot(target.x - source.x, target.z - source.z);
  const lift = clamp(planarDistance * 0.075 + liftBoost, 14, 58);
  tmpArcStart.copy(source);
  tmpArcA.lerpVectors(source, target, 0.34);
  tmpArcB.lerpVectors(source, target, 0.68);
  tmpArcEnd.copy(target);
  tmpArcA.y += lift;
  tmpArcB.y += lift * 0.92;
  setBeamInstance(mesh, index, tmpArcStart, tmpArcA, width, color);
  setBeamInstance(mesh, index + 1, tmpArcA, tmpArcB, width * 0.88, color);
  setBeamInstance(mesh, index + 2, tmpArcB, tmpArcEnd, width, color);
  return index + 3;
}

export default function VoxelCanvas(props: VoxelCanvasProps): JSX.Element {
  let hostEl: HTMLDivElement | undefined;
  let scene: Scene | undefined;
  let camera: PerspectiveCamera | undefined;
  let renderer: WebGLRenderer | undefined;
  let controls: OrbitControls | undefined;
  let resizeObs: ResizeObserver | undefined;
  let environmentGroup: Group | undefined;
  let workstationGroup: Group | undefined;
  let linkGroup: Group | undefined;
  let labelGroup: Group | undefined;
  let cubeGeometry: BoxGeometry | undefined;
  let meshes: OfficeMeshes | undefined;
  let linkMesh: InstancedMesh<BoxGeometry, MeshBasicMaterial> | undefined;
  let highlightLinkMesh: InstancedMesh<BoxGeometry, MeshBasicMaterial> | undefined;
  let animationFrame: number | undefined;
  let lastFrameAt = 0;
  let lastAgentFrameAt = 0;
  let smoothCameraUntil = 0;
  let cameraTween: CameraTween | null = null;
  let pointerDown: { x: number; y: number } | null = null;
  let rooms: OfficeRoom[] = [];
  let environmentVoxelBatch: VoxelBoxBatch | undefined;
  let idleCursor = 0;
  let lastPointerPickAt = 0;
  let lastVisualRuntimePaths = new Set<string>();
  let lastVisualFocusPath: string | null | undefined;
  let environmentAnim: EnvironmentAnimState = { waterMaterials: [] };

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const runtimeNodes = new Map<string, VoxelRuntimeNode>();
  const runtimeNodeList: VoxelRuntimeNode[] = [];
  const runtimeLinks: VoxelRuntimeLink[] = [];
  const pickableMeshes: InstancedMesh<BoxGeometry, Material>[] = [];

  const [initError, setInitError] = createSignal<string | null>(null);
  const [hoveredNode, setHoveredNode] = createSignal<VoxelRuntimeNode | null>(null);
  const [selectedNode, setSelectedNode] = createSignal<string | null>(null);
  const [followMode, setFollowMode] = createSignal(props.initialFollowMode ?? false);
  const [idleEnabled] = createSignal(true);
  const [zoomLevel, setZoomLevel] = createSignal(1);
  const [visibleStats, setVisibleStats] = createSignal<VisibleStats>({ nodes: 0, links: 0 });

  const store = createMemo(() => getVoxelGraphStore());
  const graphState = createMemo(() => store()?.state ?? null);
  const currentFilePath = () => props.currentFilePath ?? null;
  const isCompact = () => props.variant === "compact";
  const summary = createMemo(() => getGraphSummary(graphState()));

  const focusedFilePath = () => selectedNode() ?? hoveredNode()?.node.filePath ?? currentFilePath();

  const connectedToFocus = createMemo(() => {
    const fp = focusedFilePath();
    const state = graphState();
    if (!fp || !state) return new Set<string>();
    return new Set(state.adjacencyMap[fp]);
  });

  const status = createMemo((): "loading" | "error" | "empty" | "ready" => {
    const state = graphState();
    if (!state || state.isIndexing) return "loading";
    if (state.error) return "error";
    if (state.nodes.length === 0) return "empty";
    return "ready";
  });

  function cssVar(name: string, fallback: string): string {
    if (!hostEl) return fallback;
    return getComputedStyle(hostEl).getPropertyValue(name).trim() || fallback;
  }

  function retroSkyPalette(): RetroSkyPalette {
    const dark = getEffectiveTheme() === "dark";
    return {
      top: cssVar("--color-voxel-world-sky-top", dark ? "#07162a" : "#2a78a6"),
      mid: cssVar("--color-voxel-world-sky-mid", dark ? "#0b3f63" : "#6f8790"),
      bottom: cssVar("--color-voxel-world-sky", dark ? RETRO_INK : "#a79b82"),
      band: cssVar("--color-voxel-world-sky-band", dark ? RETRO_ORANGE : RETRO_CREAM),
      line: cssVar("--color-voxel-world-sky-line", dark ? "#d8c27a" : "#0f5d84"),
    };
  }

  function applyVoxelWorldTheme(): void {
    const dark = getEffectiveTheme() === "dark";
    const fogColor = cssVar("--color-voxel-world-fog", dark ? "#0f3150" : "#9b9586");
    const skyPalette = retroSkyPalette();
    if (scene?.fog) {
      const fog = scene.fog as FogExp2;
      fog.color = new Color(fogColor);
      fog.density = dark ? 0.000014 : 0.000009;
    }
    renderer?.setClearColor(new Color(skyPalette.bottom), 1);
    if (environmentAnim.skyDome) {
      const previous = environmentAnim.skyDome.material;
      environmentAnim.skyDome.material = createSkyMaterial(skyPalette);
      disposeMaterial(previous);
    }
  }

  function updateEnvironmentAnimations(now: number): void {
    const elapsedSeconds = now * 0.001;
    for (const water of environmentAnim.waterMaterials) {
      water.emissiveIntensity = 0.16 + Math.sin(elapsedSeconds * 1.55) * 0.04;
    }
  }

  function updateCameraClipPlanes(radius = environmentRadius()): void {
    if (!camera) return;
    camera.near = CAMERA_NEAR_PLANE;
    camera.far = clamp(radius * 4.2, CAMERA_FAR_MIN, CAMERA_FAR_MAX);
    camera.updateProjectionMatrix();
    if (!controls) return;
    const fitDistance = isometricCameraPosition(radius).distanceTo(isometricCameraTarget());
    controls.minDistance = clamp(
      radius * (isCompact() ? CAMERA_COMPACT_CLOSE_ZOOM_RATIO : CAMERA_CLOSE_ZOOM_RATIO),
      isCompact() ? CAMERA_COMPACT_MIN_DISTANCE : CAMERA_MIN_DISTANCE,
      isCompact() ? 280 : 420,
    );
    controls.maxDistance = clamp(Math.max(fitDistance + 140, radius * 2.28), 720, 4_800);
    const currentOffset = camera.position.clone().sub(controls.target);
    if (currentOffset.length() < controls.minDistance) {
      currentOffset.setLength(controls.minDistance);
      camera.position.copy(controls.target.clone().add(currentOffset));
      controls.update();
      updateZoomFromCamera();
    }
    if (currentOffset.length() > controls.maxDistance) {
      currentOffset.setLength(controls.maxDistance);
      camera.position.copy(controls.target.clone().add(currentOffset));
      controls.update();
      updateZoomFromCamera();
    }
  }

  function nodeColor(node: GraphNode): string {
    const selected = selectedNode();
    if (node.filePath === selected) return RETRO_YELLOW;
    if (selected) return officeClusterColor(node.clusterIndex);
    if (node.filePath === currentFilePath()) return "#28b99b";
    if (node.filePath === hoveredNode()?.node.filePath) return "#5d8cff";
    if (node.isOrphan) return "#9aa3a6";
    return officeClusterColor(node.clusterIndex);
  }

  function createInstancedMesh<T extends MeshStandardMaterial | MeshBasicMaterial>(
    material: T,
    count: number,
  ): InstancedMesh<BoxGeometry, T> {
    if (!cubeGeometry) throw new Error("Voxel geometry is not ready");
    const mesh = new InstancedMesh(cubeGeometry, material, Math.max(1, count));
    mesh.frustumCulled = false;
    mesh.count = count;
    return mesh;
  }

  function createOfficeMeshes(count: number): OfficeMeshes {
    const group = new Group();
    const created: OfficeMeshes = {
      shadow: createInstancedMesh(basicMaterial("#a79878", { opacity: 0.07 }), count),
      chair: createInstancedMesh(
        standardMaterial("#315f74", { roughness: 0.6, emissiveIntensity: 0.22 }),
        count,
      ),
      chairBack: createInstancedMesh(
        standardMaterial("#294f60", { roughness: 0.56, emissiveIntensity: 0.18 }),
        count,
      ),
      chairBase: createInstancedMesh(
        standardMaterial(RETRO_SLATE, { roughness: 0.66, emissiveIntensity: 0.1 }),
        count,
      ),
      chairWheel: createInstancedMesh(
        standardMaterial("#3f4a4e", { roughness: 0.7, emissiveIntensity: 0.06 }),
        count * 4,
      ),
      desk: createInstancedMesh(
        standardMaterial("#cda45f", { roughness: 0.78, emissiveIntensity: 0.13 }),
        count,
      ),
      deskLeg: createInstancedMesh(
        standardMaterial("#8f6233", { roughness: 0.76, emissiveIntensity: 0.08 }),
        count * 4,
      ),
      monitorStand: createInstancedMesh(
        standardMaterial("#9b9b90", { roughness: 0.48, metalness: 0.18 }),
        count,
      ),
      monitorFrame: createInstancedMesh(
        standardMaterial("#d7c99d", { roughness: 0.38, metalness: 0.1 }),
        count,
      ),
      monitor: createInstancedMesh(
        standardMaterial("#19a9d0", {
          emissive: "#0f6f9d",
          emissiveIntensity: 0.28,
          roughness: 0.32,
        }),
        count,
      ),
      monitorLogo: createInstancedMesh(basicMaterial(RETRO_SLATE, { opacity: 0.7 }), count),
      screenPixel: createInstancedMesh(basicMaterial(RETRO_PAPER, { opacity: 0.94 }), count * 3),
      keyboard: createInstancedMesh(standardMaterial("#d8c99d", { roughness: 0.58 }), count),
      keyboardKey: createInstancedMesh(basicMaterial(RETRO_SLATE, { opacity: 0.56 }), count * 5),
      mouse: createInstancedMesh(standardMaterial("#d7b56d", { roughness: 0.58 }), count),
      mug: createInstancedMesh(standardMaterial(RETRO_YELLOW, { roughness: 0.56 }), count),
      notebook: createInstancedMesh(standardMaterial(RETRO_BLUE, { roughness: 0.64 }), count),
      paperStack: createInstancedMesh(
        standardMaterial(RETRO_PAPER, { roughness: 0.62, emissiveIntensity: 0.1 }),
        count * 3,
      ),
      leftLeg: createInstancedMesh(
        standardMaterial("#255f89", { roughness: 0.58, emissiveIntensity: 0.2 }),
        count,
      ),
      rightLeg: createInstancedMesh(
        standardMaterial("#255f89", { roughness: 0.58, emissiveIntensity: 0.2 }),
        count,
      ),
      shoe: createInstancedMesh(
        standardMaterial("#7b4a2d", { roughness: 0.62, emissiveIntensity: 0.18 }),
        count * 2,
      ),
      body: createInstancedMesh(
        standardMaterial(RETRO_BLUE, { roughness: 0.52, emissiveIntensity: 0.26 }),
        count,
      ),
      shirtPanel: createInstancedMesh(
        standardMaterial(RETRO_CREAM, { roughness: 0.48, emissiveIntensity: 0.12 }),
        count,
      ),
      collar: createInstancedMesh(basicMaterial(RETRO_PAPER, { opacity: 0.82 }), count * 2),
      leftArm: createInstancedMesh(
        standardMaterial(RETRO_BLUE, { roughness: 0.52, emissiveIntensity: 0.26 }),
        count,
      ),
      rightArm: createInstancedMesh(
        standardMaterial(RETRO_BLUE, { roughness: 0.52, emissiveIntensity: 0.26 }),
        count,
      ),
      leftHand: createInstancedMesh(standardMaterial("#c98250", { roughness: 0.76 }), count),
      rightHand: createInstancedMesh(standardMaterial("#c98250", { roughness: 0.76 }), count),
      head: createInstancedMesh(
        standardMaterial("#c98250", { roughness: 0.54, emissiveIntensity: 0.26 }),
        count,
      ),
      headHighlight: createInstancedMesh(
        standardMaterial("#d9975f", { roughness: 0.5, emissiveIntensity: 0.18 }),
        count,
      ),
      hair: createInstancedMesh(
        standardMaterial("#8a5236", { roughness: 0.66, emissiveIntensity: 0.14 }),
        count,
      ),
      hairFront: createInstancedMesh(
        standardMaterial("#a96a38", { roughness: 0.62, emissiveIntensity: 0.18 }),
        count,
      ),
      hairSide: createInstancedMesh(standardMaterial("#6a4938", { roughness: 0.7 }), count * 2),
      eye: createInstancedMesh(basicMaterial("#201d1b", { opacity: 0.92 }), count * 2),
      brow: createInstancedMesh(basicMaterial("#3f2a22", { opacity: 0.74 }), count * 2),
      cheek: createInstancedMesh(basicMaterial("#f0a27c", { opacity: 0.5 }), count * 2),
      nose: createInstancedMesh(
        standardMaterial("#b97954", { roughness: 0.62, emissiveIntensity: 0.24 }),
        count,
      ),
      mouth: createInstancedMesh(basicMaterial("#7a4438", { opacity: 0.78 }), count),
      beard: createInstancedMesh(basicMaterial("#6a4938", { opacity: 0.18 }), count),
      headsetBand: createInstancedMesh(
        standardMaterial("#26333a", { roughness: 0.58, metalness: 0.08 }),
        count,
      ),
      headsetEar: createInstancedMesh(
        standardMaterial("#26333a", { roughness: 0.58, metalness: 0.08 }),
        count * 2,
      ),
      headsetMic: createInstancedMesh(
        standardMaterial("#26333a", { roughness: 0.52, metalness: 0.12 }),
        count,
      ),
      hatBrim: createInstancedMesh(
        standardMaterial(RETRO_BLUE, { roughness: 0.58, emissiveIntensity: 0.18 }),
        count,
      ),
      hatCrown: createInstancedMesh(
        standardMaterial(RETRO_GREEN, { roughness: 0.58, emissiveIntensity: 0.18 }),
        count,
      ),
      hatTip: createInstancedMesh(
        standardMaterial(RETRO_YELLOW, { roughness: 0.54, emissiveIntensity: 0.22 }),
        count,
      ),
      visor: createInstancedMesh(
        standardMaterial("#33d8ff", {
          emissive: "#33d8ff",
          emissiveIntensity: 0.62,
          roughness: 0.26,
        }),
        count,
      ),
      visorGlint: createInstancedMesh(
        standardMaterial("#b9d7d4", {
          emissive: "#b9d7d4",
          emissiveIntensity: 0.62,
          roughness: 0.22,
        }),
        count,
      ),
      chestPanel: createInstancedMesh(
        standardMaterial("#33d8ff", {
          emissive: "#33d8ff",
          emissiveIntensity: 0.52,
          roughness: 0.34,
        }),
        count,
      ),
      chestButton: createInstancedMesh(
        standardMaterial(RETRO_YELLOW, {
          emissive: RETRO_YELLOW,
          emissiveIntensity: 0.58,
          roughness: 0.34,
        }),
        count * 2,
      ),
      outfitBelt: createInstancedMesh(
        standardMaterial("#102132", { roughness: 0.55, emissiveIntensity: 0.16 }),
        count,
      ),
      outfitSash: createInstancedMesh(
        standardMaterial(RETRO_PAPER, { roughness: 0.5, emissiveIntensity: 0.16 }),
        count,
      ),
      shoulderPad: createInstancedMesh(
        standardMaterial("#f7d06a", { roughness: 0.52, emissiveIntensity: 0.24 }),
        count * 2,
      ),
      sleeveCuff: createInstancedMesh(
        standardMaterial(RETRO_PAPER, { roughness: 0.5, emissiveIntensity: 0.16 }),
        count * 2,
      ),
      bootTrim: createInstancedMesh(
        standardMaterial("#f7d06a", { roughness: 0.56, emissiveIntensity: 0.2 }),
        count * 2,
      ),
      helmetSide: createInstancedMesh(
        standardMaterial(RETRO_PAPER, { roughness: 0.48, emissiveIntensity: 0.18 }),
        count * 2,
      ),
      cape: createInstancedMesh(
        standardMaterial("#d13f31", { roughness: 0.62, emissiveIntensity: 0.18 }),
        count,
      ),
      backpack: createInstancedMesh(
        standardMaterial("#d8c99d", { roughness: 0.5, emissiveIntensity: 0.18 }),
        count,
      ),
      antennaBase: createInstancedMesh(
        standardMaterial("#8794a0", { roughness: 0.58, metalness: 0.08 }),
        count,
      ),
      antennaTip: createInstancedMesh(
        standardMaterial("#59ddc3", {
          emissive: "#59ddc3",
          emissiveIntensity: 0.62,
          roughness: 0.34,
        }),
        count,
      ),
      badge: createInstancedMesh(standardMaterial(RETRO_PAPER, { roughness: 0.5 }), count),
      signal: createInstancedMesh(basicMaterial("#59ddc3", { opacity: 0.62 }), count),
    };

    for (const mesh of [
      created.shadow,
      created.desk,
      created.deskLeg,
      created.chair,
      created.chairBack,
      created.chairBase,
      created.chairWheel,
      created.monitorStand,
      created.monitorFrame,
      created.monitor,
      created.monitorLogo,
      created.screenPixel,
      created.keyboard,
      created.keyboardKey,
      created.mouse,
      created.mug,
      created.notebook,
      created.paperStack,
      created.leftLeg,
      created.rightLeg,
      created.shoe,
      created.body,
      created.shirtPanel,
      created.collar,
      created.leftArm,
      created.rightArm,
      created.leftHand,
      created.rightHand,
      created.head,
      created.headHighlight,
      created.hair,
      created.hairFront,
      created.hairSide,
      created.headsetBand,
      created.headsetEar,
      created.headsetMic,
      created.hatBrim,
      created.hatCrown,
      created.hatTip,
      created.visor,
      created.visorGlint,
      created.chestPanel,
      created.chestButton,
      created.outfitBelt,
      created.outfitSash,
      created.shoulderPad,
      created.sleeveCuff,
      created.bootTrim,
      created.helmetSide,
      created.cape,
      created.backpack,
      created.antennaBase,
      created.antennaTip,
      created.eye,
      created.brow,
      created.cheek,
      created.nose,
      created.mouth,
      created.beard,
      created.badge,
      created.signal,
    ]) {
      group.add(mesh);
    }

    workstationGroup = group;
    scene?.add(group);
    pickableMeshes.length = 0;
    pickableMeshes.push(
      created.body,
      created.head,
      created.desk,
      created.monitorFrame,
      created.monitor,
    );
    return created;
  }

  function writeStationInstances(
    runtime: VoxelRuntimeNode,
    now = performance.now(),
    mode: StationWriteMode = "full",
  ): void {
    if (!meshes) return;
    const writeFullStation = mode === "full";
    const i = runtime.instanceIndex;
    const s = runtime.size;
    const pulseRemaining = Math.max(0, runtime.clickPulseUntil - now);
    const pulse = pulseRemaining > 0 ? Math.sin((pulseRemaining / 780) * Math.PI) : 0;
    const selectedPath = selectedNode();
    const isSelectedFocus = runtime.node.filePath === selectedPath;
    const activeBoost = (isSelectedFocus ? 1.06 : 1) + pulse * 0.16;
    const accentColor = isSelectedFocus ? RETRO_YELLOW : nodeColor(runtime.node);
    const bodyColor = runtime.shirtColor;
    const skinColor = runtime.skinColor;
    const chairColor = runtime.chairColor;
    const deskColor = runtime.deskColor;
    const pantsColor = runtime.pantsColor;
    const shoeColor = runtime.shoeColor;
    const idleWave = idleEnabled()
      ? Math.sin(now * 0.0021 * runtime.idleSpeed + runtime.idlePhase)
      : 0;
    const shoulderWave = idleEnabled()
      ? Math.sin(now * 0.0032 * runtime.idleSpeed + runtime.idlePhase * 0.6)
      : 0;
    const typingWave = idleEnabled() ? Math.sin(now * 0.0105 + runtime.typingPhase) : 0;
    const bob = (idleWave * 1.05 + pulse * 2.8) * s;
    const leftTyping = typingWave * 2.1 * s;
    const rightTyping = -typingWave * 1.9 * s;
    const leftTap = Math.sin(now * 0.017 + runtime.typingPhase * 1.7);
    const rightTap = Math.sin(now * 0.0185 + runtime.typingPhase + 1.35);
    const armLean = idleWave * 0.08 + pulse * 0.06;
    const blinkScale =
      Math.sin(now * 0.0011 * runtime.idleSpeed + runtime.idlePhase * 1.9) > 0.986 ? 0.24 : 1;
    const glance = Math.sin(now * 0.0014 * runtime.idleSpeed + runtime.idlePhase * 0.7) * 1.25 * s;
    let monitorColor = "#1aa0b6";
    if (isSelectedFocus) {
      monitorColor = RETRO_YELLOW;
    } else if (runtime.node.filePath === hoveredNode()?.node.filePath) {
      monitorColor = "#19a9d0";
    } else if (runtime.node.filePath === currentFilePath()) {
      monitorColor = "#39dfbd";
    }
    let screenAccent = accentColor;
    if (isSelectedFocus) {
      screenAccent = "#e8c44a";
    } else if (pulse > 0) {
      screenAccent = "#dfb83f";
    }
    const deskAccent = runtime.deskAccentColor;
    const headTopColor = runtime.headTopColor;
    const headsetColor = runtime.headsetColor;
    const faceShadowColor = runtime.faceShadowColor;
    const characterType = runtime.characterType;
    const accessoryColor = runtime.accessoryColor;
    const secondaryColor = runtime.secondaryColor;
    const visorColor = runtime.visorColor;
    const trimColor = runtime.trimColor;
    const patternColor = runtime.patternColor;
    const outfitVariant = runtime.outfitVariant;
    const lengthTier = documentLengthTier(runtime.node);
    const degreeTier = linkCountTier(runtime.node);
    const documentScale = documentScaleForNode(runtime.node);
    const hasVisorFace = characterType === "robot" || characterType === "astronaut";
    const showHeadset =
      characterType === "operator" || characterType === "robot" || characterType === "astronaut";
    const showHat =
      characterType === "wizard" || characterType === "holiday" || characterType === "ranger";
    const showTallHat = characterType === "wizard";
    const showCape = characterType === "wizard" || characterType === "hero";
    const showBackpack = characterType === "astronaut" || characterType === "holiday";
    const showAntenna = characterType === "robot" || characterType === "creature";
    const showChestPanel =
      characterType === "robot" || characterType === "astronaut" || characterType === "hero";
    const showShoulderPads =
      degreeTier >= 2 || characterType === "hero" || characterType === "ranger";
    const showSash = lengthTier >= 2 || characterType === "wizard" || characterType === "holiday";
    const showHelmetSide = characterType === "robot" || characterType === "astronaut";
    const base = runtime.position;
    const heading = runtime.heading;

    setInstance(
      meshes.shadow,
      i,
      base,
      heading,
      new Vector3(0, 0.16, 2 * s),
      new Vector3(25 * s, 0.25, 19 * s),
      isSelectedFocus ? "#d4a520" : "#8b7a5a",
      isSelectedFocus ? 1.18 : 1,
    );
    if (writeFullStation) {
      setInstance(
        meshes.chair,
        i,
        base,
        heading,
        new Vector3(0, 5.2 * s, -8 * s),
        new Vector3(10 * s, 7.5 * s, 8 * s),
        chairColor,
      );
      setInstance(
        meshes.chairBack,
        i,
        base,
        heading,
        new Vector3(0, 10.8 * s, -12.8 * s),
        new Vector3(11.4 * s, 13.5 * s, 2.4 * s),
        mixHexColor(chairColor, "#5f8196", 0.2),
      );
      setInstance(
        meshes.chairBase,
        i,
        base,
        heading,
        new Vector3(0, 1.55 * s, -8 * s),
        new Vector3(8.8 * s, 1.6 * s, 8.8 * s),
        "#8aa3a9",
      );
      setInstance(
        meshes.chairWheel,
        i * 4,
        base,
        heading,
        new Vector3(-4.8 * s, 0.55 * s, -12.3 * s),
        new Vector3(1.8 * s, 1.1 * s, 1.8 * s),
        "#5f6f72",
      );
      setInstance(
        meshes.chairWheel,
        i * 4 + 1,
        base,
        heading,
        new Vector3(4.8 * s, 0.55 * s, -12.3 * s),
        new Vector3(1.8 * s, 1.1 * s, 1.8 * s),
        "#5f6f72",
      );
      setInstance(
        meshes.chairWheel,
        i * 4 + 2,
        base,
        heading,
        new Vector3(-4.8 * s, 0.55 * s, -3.9 * s),
        new Vector3(1.8 * s, 1.1 * s, 1.8 * s),
        "#5f6f72",
      );
      setInstance(
        meshes.chairWheel,
        i * 4 + 3,
        base,
        heading,
        new Vector3(4.8 * s, 0.55 * s, -3.9 * s),
        new Vector3(1.8 * s, 1.1 * s, 1.8 * s),
        "#5f6f72",
      );
      setInstance(
        meshes.desk,
        i,
        base,
        heading,
        new Vector3(0, 5.2 * s, 5.2 * s),
        new Vector3(25 * s, 5.2 * s, 14 * s),
        deskColor,
      );
      setInstance(
        meshes.deskLeg,
        i * 4,
        base,
        heading,
        new Vector3(-10.6 * s, 2.2 * s, -0.2 * s),
        new Vector3(1.55 * s, 5.2 * s, 1.55 * s),
        "#8f6233",
      );
      setInstance(
        meshes.deskLeg,
        i * 4 + 1,
        base,
        heading,
        new Vector3(10.6 * s, 2.2 * s, -0.2 * s),
        new Vector3(1.55 * s, 5.2 * s, 1.55 * s),
        "#8f6233",
      );
      setInstance(
        meshes.deskLeg,
        i * 4 + 2,
        base,
        heading,
        new Vector3(-10.6 * s, 2.2 * s, 10.6 * s),
        new Vector3(1.55 * s, 5.2 * s, 1.55 * s),
        "#8f6233",
      );
      setInstance(
        meshes.deskLeg,
        i * 4 + 3,
        base,
        heading,
        new Vector3(10.6 * s, 2.2 * s, 10.6 * s),
        new Vector3(1.55 * s, 5.2 * s, 1.55 * s),
        "#8f6233",
      );
      setInstance(
        meshes.monitorStand,
        i,
        base,
        heading,
        new Vector3(0, 12.2 * s, 2.5 * s),
        new Vector3(2.1 * s, 7 * s, 1.6 * s),
        "#9b9b90",
      );
      setInstance(
        meshes.monitorFrame,
        i,
        base,
        heading,
        new Vector3(0, 18 * s, 1.18 * s),
        new Vector3(15.6 * s, 9.6 * s, 1.35 * s),
        "#d7c99d",
      );
    }
    setInstance(
      meshes.monitor,
      i,
      base,
      heading,
      new Vector3(0, 18.2 * s, 0.42 * s),
      new Vector3(11.8 * s, 6.4 * s, 0.5 * s),
      monitorColor,
    );
    if (writeFullStation) {
      setInstance(
        meshes.monitorLogo,
        i,
        base,
        heading,
        new Vector3(0, 14.35 * s, 0.08 * s),
        new Vector3(1.25 * s, 0.82 * s, 0.2 * s),
        "#6f7f83",
      );
    }
    setInstance(
      meshes.screenPixel,
      i * 3,
      base,
      heading,
      new Vector3(-3.6 * s, 19.25 * s, 0.12 * s),
      new Vector3(2.2 * s, 1.1 * s, 0.28 * s),
      screenAccent,
    );
    setInstance(
      meshes.screenPixel,
      i * 3 + 1,
      base,
      heading,
      new Vector3(1.2 * s, 17.75 * s, 0.1 * s),
      new Vector3(4.2 * s, 0.8 * s, 0.28 * s),
      "#b9d7d4",
    );
    setInstance(
      meshes.screenPixel,
      i * 3 + 2,
      base,
      heading,
      new Vector3(3.8 * s, 20.25 * s, 0.09 * s),
      new Vector3(1.4 * s, 1.4 * s, 0.28 * s),
      "#f7d06a",
    );
    if (writeFullStation) {
      setInstance(
        meshes.keyboard,
        i,
        base,
        heading,
        new Vector3(0, 8.35 * s, -0.7 * s),
        new Vector3(10 * s, 0.65 * s, 2.7 * s),
        "#d8c99d",
      );
    }
    for (let keyIndex = 0; keyIndex < 5; keyIndex += 1) {
      setInstance(
        meshes.keyboardKey,
        i * 5 + keyIndex,
        base,
        heading,
        new Vector3((-3.8 + keyIndex * 1.9) * s, 8.84 * s, -0.9 * s),
        new Vector3(0.9 * s, 0.16 * s, 0.36 * s),
        keyIndex === 2 ? screenAccent : "#8fa5a9",
      );
    }
    if (writeFullStation) {
      setInstance(
        meshes.mouse,
        i,
        base,
        heading,
        new Vector3(8.7 * s, 8.95 * s, -1.9 * s),
        new Vector3(3.1 * s, 0.85 * s, 2.2 * s),
        "#d7b56d",
      );
      setInstance(
        meshes.mug,
        i,
        base,
        heading,
        new Vector3(-9.1 * s, 10.1 * s, 6.3 * s),
        new Vector3(2.3 * s, 2.7 * s, 2.3 * s),
        deskAccent,
      );
      setInstance(
        meshes.notebook,
        i,
        base,
        heading,
        new Vector3(-7.4 * s, 8.95 * s, -0.2 * s),
        new Vector3((4.8 + documentScale * 2.4) * s, 0.7 * s, (3.2 + documentScale * 1.6) * s),
        deskAccent,
      );
      for (let stackIndex = 0; stackIndex < 3; stackIndex += 1) {
        if (stackIndex > lengthTier - 2) {
          hideInstance(meshes.paperStack, i * 3 + stackIndex);
          continue;
        }
        let stackColor = secondaryColor;
        if (stackIndex === 0) {
          stackColor = RETRO_PAPER;
        } else if (stackIndex === 1) {
          stackColor = "#d8c99d";
        }
        setInstance(
          meshes.paperStack,
          i * 3 + stackIndex,
          base,
          heading,
          new Vector3(
            (-10.3 + stackIndex * 1.45) * s,
            (9.12 + stackIndex * 0.58) * s,
            (1.9 + stackIndex * 0.15) * s,
          ),
          new Vector3((3.8 - stackIndex * 0.28) * s, 0.45 * s, 2.8 * s),
          stackColor,
        );
      }
      setInstance(
        meshes.leftLeg,
        i,
        base,
        heading,
        new Vector3(-2.2 * s, 5.8 * s, -2.4 * s),
        new Vector3(2.9 * s, 7.2 * s, 3.3 * s),
        pantsColor,
      );
      setInstance(
        meshes.rightLeg,
        i,
        base,
        heading,
        new Vector3(2.2 * s, 5.8 * s, -2.4 * s),
        new Vector3(2.9 * s, 7.2 * s, 3.3 * s),
        pantsColor,
      );
      setInstance(
        meshes.shoe,
        i * 2,
        base,
        heading,
        new Vector3(-2.2 * s, 1.8 * s, 1.2 * s),
        new Vector3(3.8 * s, 1.7 * s, 4.6 * s),
        shoeColor,
      );
      setInstance(
        meshes.shoe,
        i * 2 + 1,
        base,
        heading,
        new Vector3(2.2 * s, 1.8 * s, 1.2 * s),
        new Vector3(3.8 * s, 1.7 * s, 4.6 * s),
        shoeColor,
      );
      setInstance(
        meshes.bootTrim,
        i * 2,
        base,
        heading,
        new Vector3(-2.2 * s, 2.86 * s, 3.62 * s),
        new Vector3(3.9 * s, 0.72 * s, 0.5 * s),
        outfitVariant % 2 === 0 ? trimColor : patternColor,
      );
      setInstance(
        meshes.bootTrim,
        i * 2 + 1,
        base,
        heading,
        new Vector3(2.2 * s, 2.86 * s, 3.62 * s),
        new Vector3(3.9 * s, 0.72 * s, 0.5 * s),
        outfitVariant % 2 === 0 ? trimColor : patternColor,
      );
    }
    setInstance(
      meshes.body,
      i,
      base,
      heading,
      new Vector3(0, 13.7 * s + bob, -6.8 * s),
      new Vector3(8.1 * s, 9.5 * s, 5.1 * s),
      bodyColor,
      activeBoost,
      shoulderWave * 0.035,
      0,
      armLean,
    );
    setInstance(
      meshes.shirtPanel,
      i,
      base,
      heading,
      new Vector3(0, 13.4 * s + bob, -3.9 * s),
      new Vector3(
        (outfitVariant === 1 ? 5.1 : 3.35) * s,
        (outfitVariant === 2 ? 2.4 : 5.7) * s,
        0.42 * s,
      ),
      outfitVariant === 3 ? patternColor : mixHexColor(bodyColor, RETRO_PAPER, 0.54),
      activeBoost,
      shoulderWave * 0.035,
      0,
      armLean,
    );
    setInstance(
      meshes.collar,
      i * 2,
      base,
      heading,
      new Vector3(-1.65 * s, 17.8 * s + bob, -3.74 * s),
      new Vector3(1.45 * s, 0.72 * s, 0.36 * s),
      RETRO_PAPER,
      activeBoost,
      0,
      0,
      -0.28 + armLean,
    );
    setInstance(
      meshes.collar,
      i * 2 + 1,
      base,
      heading,
      new Vector3(1.65 * s, 17.8 * s + bob, -3.74 * s),
      new Vector3(1.45 * s, 0.72 * s, 0.36 * s),
      RETRO_PAPER,
      activeBoost,
      0,
      0,
      0.28 + armLean,
    );
    setInstance(
      meshes.outfitBelt,
      i,
      base,
      heading,
      new Vector3(0, 10.7 * s + bob, -3.72 * s),
      new Vector3(7.5 * s, 0.9 * s, 0.54 * s),
      patternColor,
      activeBoost,
      shoulderWave * 0.035,
      0,
      armLean,
    );
    if (showSash) {
      const sashTilt = outfitVariant % 2 === 0 ? -0.62 : 0.62;
      setInstance(
        meshes.outfitSash,
        i,
        base,
        heading,
        new Vector3((outfitVariant % 2 === 0 ? -0.6 : 0.6) * s, 14.8 * s + bob, -3.46 * s),
        new Vector3(1.65 * s, 8.4 * s, 0.58 * s),
        trimColor,
        activeBoost,
        shoulderWave * 0.035,
        0,
        sashTilt + armLean * 0.2,
      );
    } else {
      hideInstance(meshes.outfitSash, i);
    }
    if (showShoulderPads) {
      const padColor =
        characterType === "hero" ? trimColor : mixHexColor(trimColor, bodyColor, 0.16);
      setInstance(
        meshes.shoulderPad,
        i * 2,
        base,
        heading,
        new Vector3(-5.15 * s, 17.3 * s + bob, -6.2 * s),
        new Vector3(2.9 * s, 1.6 * s, 4.6 * s),
        padColor,
        activeBoost,
        0,
        0,
        0.1 + armLean * 0.2,
      );
      setInstance(
        meshes.shoulderPad,
        i * 2 + 1,
        base,
        heading,
        new Vector3(5.15 * s, 17.3 * s + bob, -6.2 * s),
        new Vector3(2.9 * s, 1.6 * s, 4.6 * s),
        padColor,
        activeBoost,
        0,
        0,
        -0.1 + armLean * 0.2,
      );
    } else {
      hideInstance(meshes.shoulderPad, i * 2);
      hideInstance(meshes.shoulderPad, i * 2 + 1);
    }
    if (showChestPanel) {
      const chestColor = characterType === "hero" ? accessoryColor : visorColor;
      setInstance(
        meshes.chestPanel,
        i,
        base,
        heading,
        new Vector3(0, 14.05 * s + bob, -3.58 * s),
        new Vector3(3.1 * s, 3.1 * s, 0.44 * s),
        chestColor,
        activeBoost,
        shoulderWave * 0.035,
        0,
        armLean,
      );
      setInstance(
        meshes.chestButton,
        i * 2,
        base,
        heading,
        new Vector3(-1.05 * s, 12.95 * s + bob, -3.26 * s),
        new Vector3(0.62 * s, 0.62 * s, 0.36 * s),
        secondaryColor,
        activeBoost,
      );
      setInstance(
        meshes.chestButton,
        i * 2 + 1,
        base,
        heading,
        new Vector3(1.05 * s, 15.25 * s + bob, -3.24 * s),
        new Vector3(0.62 * s, 0.62 * s, 0.36 * s),
        screenAccent,
        activeBoost,
      );
    } else {
      hideInstance(meshes.chestPanel, i);
      hideInstance(meshes.chestButton, i * 2);
      hideInstance(meshes.chestButton, i * 2 + 1);
    }
    if (showCape) {
      setInstance(
        meshes.cape,
        i,
        base,
        heading,
        new Vector3(0, 13.5 * s + bob, -10.15 * s),
        new Vector3(8.9 * s, 9.2 * s, 1.05 * s),
        accessoryColor,
        activeBoost,
        shoulderWave * 0.02,
        0,
        armLean * 0.2,
      );
    } else {
      hideInstance(meshes.cape, i);
    }
    if (showBackpack) {
      const packColor = characterType === "astronaut" ? "#d8c99d" : secondaryColor;
      setInstance(
        meshes.backpack,
        i,
        base,
        heading,
        new Vector3(0, 13.65 * s + bob, -11.25 * s),
        new Vector3(5.6 * s, 7.4 * s, 2.45 * s),
        packColor,
        activeBoost,
        shoulderWave * 0.02,
        0,
        armLean * 0.2,
      );
    } else {
      hideInstance(meshes.backpack, i);
    }
    setInstance(
      meshes.leftArm,
      i,
      base,
      heading,
      new Vector3(-5.9 * s, 13.1 * s + bob + leftTyping * 0.22, -0.9 * s),
      new Vector3(2.6 * s, 7.9 * s, 2.7 * s),
      bodyColor,
      activeBoost,
      -0.76 + leftTap * 0.18,
      0.07,
      0.2 + armLean,
    );
    setInstance(
      meshes.rightArm,
      i,
      base,
      heading,
      new Vector3(5.9 * s, 13.1 * s + bob + rightTyping * 0.22, -0.9 * s),
      new Vector3(2.6 * s, 7.9 * s, 2.7 * s),
      bodyColor,
      activeBoost,
      -0.76 + rightTap * 0.18,
      -0.07,
      -0.2 + armLean,
    );
    setInstance(
      meshes.sleeveCuff,
      i * 2,
      base,
      heading,
      new Vector3(-5.65 * s, 9.3 * s + bob + leftTyping * 0.22, s),
      new Vector3(2.8 * s, 0.86 * s, 2.9 * s),
      trimColor,
      activeBoost,
      -0.76 + leftTap * 0.18,
      0.07,
      0.2 + armLean,
    );
    setInstance(
      meshes.sleeveCuff,
      i * 2 + 1,
      base,
      heading,
      new Vector3(5.65 * s, 9.3 * s + bob + rightTyping * 0.22, s),
      new Vector3(2.8 * s, 0.86 * s, 2.9 * s),
      trimColor,
      activeBoost,
      -0.76 + rightTap * 0.18,
      -0.07,
      -0.2 + armLean,
    );
    setInstance(
      meshes.leftHand,
      i,
      base,
      heading,
      new Vector3(0, 0, 0),
      new Vector3(0, 0, 0),
      skinColor,
    );
    setInstance(
      meshes.rightHand,
      i,
      base,
      heading,
      new Vector3(0, 0, 0),
      new Vector3(0, 0, 0),
      skinColor,
    );
    setInstance(
      meshes.head,
      i,
      base,
      heading,
      new Vector3(glance, 23.2 * s + bob, -6.8 * s),
      new Vector3(7.85 * s, 7.85 * s, 7.85 * s),
      skinColor,
      activeBoost,
      shoulderWave * 0.018,
      glance * 0.018,
      armLean * 0.34,
    );
    setInstance(
      meshes.headHighlight,
      i,
      base,
      heading,
      new Vector3(glance - 2.2 * s, 25.15 * s + bob, -2.52 * s),
      new Vector3(1.55 * s, 2.3 * s, 0.3 * s),
      mixHexColor(skinColor, "#ffd4a2", 0.48),
      activeBoost,
      shoulderWave * 0.018,
      glance * 0.018,
      armLean * 0.34,
    );
    if (hasVisorFace) {
      hideInstance(meshes.hair, i);
      hideInstance(meshes.hairFront, i);
    } else {
      setInstance(
        meshes.hair,
        i,
        base,
        heading,
        new Vector3(glance, 27.48 * s + bob, -7.08 * s),
        new Vector3(6.45 * s, 0.52 * s, 6.55 * s),
        headTopColor,
        activeBoost,
        0,
        glance * 0.018,
        armLean * 0.34,
      );
      setInstance(
        meshes.hairFront,
        i,
        base,
        heading,
        new Vector3(glance, 25.7 * s + bob, -2.58 * s),
        new Vector3(3.1 * s, 0.44 * s, 0.32 * s),
        mixHexColor(skinColor, headTopColor, 0.16),
        activeBoost,
      );
    }
    if (showHeadset) {
      setInstance(
        meshes.hairSide,
        i * 2,
        base,
        heading,
        new Vector3(glance - 4.48 * s, 24.2 * s + bob, -6.85 * s),
        new Vector3(0.72 * s, 3.35 * s, 3.6 * s),
        headsetColor,
        activeBoost,
      );
      setInstance(
        meshes.hairSide,
        i * 2 + 1,
        base,
        heading,
        new Vector3(glance + 4.48 * s, 24.2 * s + bob, -6.85 * s),
        new Vector3(0.72 * s, 3.35 * s, 3.6 * s),
        headsetColor,
        activeBoost,
      );
      setInstance(
        meshes.headsetBand,
        i,
        base,
        heading,
        new Vector3(glance, 27.72 * s + bob, -6.75 * s),
        new Vector3(8.4 * s, 0.62 * s, 1.35 * s),
        headsetColor,
        activeBoost,
        0,
        glance * 0.018,
        armLean * 0.34,
      );
      setInstance(
        meshes.headsetEar,
        i * 2,
        base,
        heading,
        new Vector3(glance - 4.75 * s, 24.1 * s + bob, -5.5 * s),
        new Vector3(1.05 * s, 3.25 * s, 2.1 * s),
        headsetColor,
        activeBoost,
      );
      setInstance(
        meshes.headsetEar,
        i * 2 + 1,
        base,
        heading,
        new Vector3(glance + 4.75 * s, 24.1 * s + bob, -5.5 * s),
        new Vector3(1.05 * s, 3.25 * s, 2.1 * s),
        headsetColor,
        activeBoost,
      );
      setInstance(
        meshes.headsetMic,
        i,
        base,
        heading,
        new Vector3(glance + 4.05 * s, 22.2 * s + bob, -2.15 * s),
        new Vector3(0.75 * s, 0.72 * s, 3.2 * s),
        headsetColor,
        activeBoost,
        0.12,
        0.18,
        0.06,
      );
    } else {
      hideInstance(meshes.hairSide, i * 2);
      hideInstance(meshes.hairSide, i * 2 + 1);
      hideInstance(meshes.headsetBand, i);
      hideInstance(meshes.headsetEar, i * 2);
      hideInstance(meshes.headsetEar, i * 2 + 1);
      hideInstance(meshes.headsetMic, i);
    }
    if (showHelmetSide) {
      const helmetColor =
        characterType === "astronaut" ? RETRO_PAPER : mixHexColor(secondaryColor, visorColor, 0.28);
      setInstance(
        meshes.helmetSide,
        i * 2,
        base,
        heading,
        new Vector3(glance - 4.75 * s, 24.55 * s + bob, -7.1 * s),
        new Vector3(1.25 * s, 4.2 * s, 4.4 * s),
        helmetColor,
        activeBoost,
      );
      setInstance(
        meshes.helmetSide,
        i * 2 + 1,
        base,
        heading,
        new Vector3(glance + 4.75 * s, 24.55 * s + bob, -7.1 * s),
        new Vector3(1.25 * s, 4.2 * s, 4.4 * s),
        helmetColor,
        activeBoost,
      );
    } else {
      hideInstance(meshes.helmetSide, i * 2);
      hideInstance(meshes.helmetSide, i * 2 + 1);
    }
    if (showHat) {
      let hatBrimWidth = 8.2;
      if (characterType === "ranger") {
        hatBrimWidth = 9.8;
      } else if (characterType === "holiday") {
        hatBrimWidth = 8.6;
      }
      let hatCrownHeight = 3.3;
      if (characterType === "wizard") {
        hatCrownHeight = 4.8;
      } else if (characterType === "ranger") {
        hatCrownHeight = 2.3;
      }
      let hatCrownColor = dataPaletteColorForNode(runtime.node, HOLIDAY_HAT_COLORS);
      if (characterType === "wizard") {
        hatCrownColor = dataPaletteColorForNode(runtime.node, WIZARD_HAT_COLORS);
      } else if (characterType === "ranger") {
        hatCrownColor = dataPaletteColorForNode(runtime.node, RANGER_HAT_COLORS);
      }
      let hatTrimColor = mixHexColor(hatCrownColor, RETRO_PAPER, 0.22);
      if (characterType === "holiday") {
        hatTrimColor = hatCrownColor === RETRO_PAPER ? "#d13f31" : RETRO_PAPER;
      } else if (showTallHat) {
        hatTrimColor = dataPaletteColorForNode(runtime.node, TRIM_COLORS, 1);
      }
      setInstance(
        meshes.hatBrim,
        i,
        base,
        heading,
        new Vector3(glance, 28.32 * s + bob, -6.85 * s),
        new Vector3(hatBrimWidth * s, 0.72 * s, 8.1 * s),
        hatTrimColor,
        activeBoost,
        0,
        glance * 0.018,
        armLean * 0.34,
      );
      setInstance(
        meshes.hatCrown,
        i,
        base,
        heading,
        new Vector3(glance, (30.05 + hatCrownHeight * 0.28) * s + bob, -6.88 * s),
        new Vector3(
          (showTallHat ? 4.7 : 5.5) * s,
          hatCrownHeight * s,
          (showTallHat ? 4.7 : 5.5) * s,
        ),
        hatCrownColor,
        activeBoost,
        0,
        glance * 0.018,
        characterType === "holiday" ? -0.15 : armLean * 0.28,
      );
      if (showTallHat || characterType === "holiday") {
        const tipColor =
          characterType === "holiday"
            ? hatTrimColor
            : dataPaletteColorForNode(runtime.node, SECONDARY_COLORS, 2);
        setInstance(
          meshes.hatTip,
          i,
          base,
          heading,
          new Vector3(
            glance + (characterType === "holiday" ? 1.6 * s : 0),
            (33.6 + (showTallHat ? 1.7 : 0)) * s + bob,
            -6.88 * s,
          ),
          new Vector3(
            (showTallHat ? 3.2 : 1.7) * s,
            (showTallHat ? 3.5 : 1.7) * s,
            (showTallHat ? 3.2 : 1.7) * s,
          ),
          tipColor,
          activeBoost,
          0,
          glance * 0.018,
          characterType === "holiday" ? -0.28 : armLean * 0.28,
        );
      } else {
        hideInstance(meshes.hatTip, i);
      }
    } else {
      hideInstance(meshes.hatBrim, i);
      hideInstance(meshes.hatCrown, i);
      hideInstance(meshes.hatTip, i);
    }
    if (hasVisorFace) {
      setInstance(
        meshes.visor,
        i,
        base,
        heading,
        new Vector3(glance, 24.38 * s + bob, -2.02 * s),
        new Vector3(4.75 * s, 2.35 * s, 0.42 * s),
        visorColor,
        activeBoost,
        shoulderWave * 0.018,
        glance * 0.018,
        armLean * 0.34,
      );
      setInstance(
        meshes.visorGlint,
        i,
        base,
        heading,
        new Vector3(glance - 1.45 * s, 25 * s + bob, -1.72 * s),
        new Vector3(1.2 * s, 0.34 * s, 0.3 * s),
        "#b9d7d4",
        activeBoost,
        shoulderWave * 0.018,
        glance * 0.018,
        armLean * 0.34,
      );
    } else {
      hideInstance(meshes.visor, i);
      hideInstance(meshes.visorGlint, i);
    }
    if (showAntenna) {
      setInstance(
        meshes.antennaBase,
        i,
        base,
        heading,
        new Vector3(glance + 2.45 * s, 30.15 * s + bob, -6.9 * s),
        new Vector3(0.62 * s, 3.4 * s, 0.62 * s),
        secondaryColor,
        activeBoost,
        0.08,
        glance * 0.018,
        armLean * 0.34,
      );
      setInstance(
        meshes.antennaTip,
        i,
        base,
        heading,
        new Vector3(glance + 2.45 * s, 32.25 * s + bob + Math.abs(idleWave) * 0.35 * s, -6.9 * s),
        new Vector3(1.55 * s, 1.55 * s, 1.55 * s),
        characterType === "creature" ? accessoryColor : visorColor,
        activeBoost + Math.abs(idleWave) * 0.08,
      );
    } else {
      hideInstance(meshes.antennaBase, i);
      hideInstance(meshes.antennaTip, i);
    }
    if (hasVisorFace) {
      hideInstance(meshes.brow, i * 2);
      hideInstance(meshes.brow, i * 2 + 1);
      hideInstance(meshes.eye, i * 2);
      hideInstance(meshes.eye, i * 2 + 1);
      hideInstance(meshes.cheek, i * 2);
      hideInstance(meshes.cheek, i * 2 + 1);
      hideInstance(meshes.nose, i);
      hideInstance(meshes.mouth, i);
    } else {
      setInstance(
        meshes.brow,
        i * 2,
        base,
        heading,
        new Vector3(glance - 1.58 * s, 25.18 * s + bob, -2.24 * s),
        new Vector3(1.05 * s, 0.24 * s, 0.24 * s),
        "#3f2a22",
        activeBoost,
      );
      setInstance(
        meshes.brow,
        i * 2 + 1,
        base,
        heading,
        new Vector3(glance + 1.58 * s, 25.18 * s + bob, -2.24 * s),
        new Vector3(1.05 * s, 0.24 * s, 0.24 * s),
        "#3f2a22",
        activeBoost,
      );
      setInstance(
        meshes.eye,
        i * 2,
        base,
        heading,
        new Vector3(glance - 1.55 * s, 24.58 * s + bob, -2.42 * s),
        new Vector3(0.9 * s, 0.82 * s * blinkScale, 0.32 * s),
        "#201d1b",
        activeBoost,
      );
      setInstance(
        meshes.eye,
        i * 2 + 1,
        base,
        heading,
        new Vector3(glance + 1.55 * s, 24.58 * s + bob, -2.42 * s),
        new Vector3(0.9 * s, 0.82 * s * blinkScale, 0.32 * s),
        "#201d1b",
        activeBoost,
      );
      setInstance(
        meshes.cheek,
        i * 2,
        base,
        heading,
        new Vector3(glance - 2.85 * s, 23.55 * s + bob, -2.28 * s),
        new Vector3(0.58 * s, 0.5 * s, 0.22 * s),
        mixHexColor(skinColor, "#ff8f7a", 0.34),
        activeBoost,
      );
      setInstance(
        meshes.cheek,
        i * 2 + 1,
        base,
        heading,
        new Vector3(glance + 2.85 * s, 23.55 * s + bob, -2.28 * s),
        new Vector3(0.58 * s, 0.5 * s, 0.22 * s),
        mixHexColor(skinColor, "#ff8f7a", 0.34),
        activeBoost,
      );
      setInstance(
        meshes.nose,
        i,
        base,
        heading,
        new Vector3(glance, 23.58 * s + bob, -2.36 * s),
        new Vector3(0.72 * s, 1.08 * s, 0.34 * s),
        mixHexColor(skinColor, faceShadowColor, 0.26),
        activeBoost,
      );
      setInstance(
        meshes.mouth,
        i,
        base,
        heading,
        new Vector3(glance, 22.6 * s + bob, -2.08 * s),
        new Vector3(1.45 * s, 0.26 * s, 0.28 * s),
        "#7a4438",
        activeBoost,
      );
    }
    hideInstance(meshes.beard, i);
    setInstance(
      meshes.badge,
      i,
      base,
      heading,
      new Vector3(2.7 * s, 14.7 * s + bob, -3.8 * s),
      new Vector3(2.5 * s, 1.7 * s, 0.55 * s),
      accentColor,
      activeBoost,
    );
    setInstance(
      meshes.signal,
      i,
      base,
      heading,
      new Vector3(-6.6 * s, 27.5 * s + bob + pulse * 5, -6.8 * s),
      new Vector3(
        (1.75 + degreeTier * 0.42) * s,
        (1.75 + degreeTier * 0.42) * s,
        (1.75 + degreeTier * 0.42) * s,
      ),
      accentColor,
      (isSelectedFocus ? 1.42 : 1) + Math.abs(idleWave) * 0.18 + pulse * 0.5,
    );
  }

  function markOfficeMeshUpdates(): void {
    if (!meshes) return;
    for (const mesh of Object.values(meshes)) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  function markAnimatedAgentMeshUpdates(): void {
    if (!meshes) return;
    for (const mesh of [
      meshes.monitor,
      meshes.screenPixel,
      meshes.keyboardKey,
      meshes.paperStack,
      meshes.body,
      meshes.shirtPanel,
      meshes.collar,
      meshes.leftArm,
      meshes.rightArm,
      meshes.leftHand,
      meshes.rightHand,
      meshes.head,
      meshes.headHighlight,
      meshes.hair,
      meshes.hairFront,
      meshes.hairSide,
      meshes.headsetBand,
      meshes.headsetEar,
      meshes.headsetMic,
      meshes.hatBrim,
      meshes.hatCrown,
      meshes.hatTip,
      meshes.visor,
      meshes.visorGlint,
      meshes.chestPanel,
      meshes.chestButton,
      meshes.outfitBelt,
      meshes.outfitSash,
      meshes.shoulderPad,
      meshes.sleeveCuff,
      meshes.bootTrim,
      meshes.helmetSide,
      meshes.cape,
      meshes.backpack,
      meshes.antennaBase,
      meshes.antennaTip,
      meshes.eye,
      meshes.brow,
      meshes.cheek,
      meshes.nose,
      meshes.mouth,
      meshes.beard,
      meshes.badge,
      meshes.signal,
    ]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  function markHighlightLinkMeshUpdates(): void {
    if (!highlightLinkMesh) return;
    highlightLinkMesh.instanceMatrix.needsUpdate = true;
    if (highlightLinkMesh.instanceColor) highlightLinkMesh.instanceColor.needsUpdate = true;
  }

  function markMeshUpdates(): void {
    markOfficeMeshUpdates();
    if (linkMesh) {
      linkMesh.instanceMatrix.needsUpdate = true;
      if (linkMesh.instanceColor) linkMesh.instanceColor.needsUpdate = true;
    }
    if (highlightLinkMesh) {
      highlightLinkMesh.instanceMatrix.needsUpdate = true;
      if (highlightLinkMesh.instanceColor) highlightLinkMesh.instanceColor.needsUpdate = true;
    }
  }

  function environmentRadius(): number {
    if (rooms.length === 0) return isCompact() ? 260 : 420;
    let radius = isCompact() ? 260 : 420;
    for (const room of rooms) {
      radius = Math.max(
        radius,
        Math.abs(room.center.x) + room.width / 2,
        Math.abs(room.center.z) + room.depth / 2,
      );
    }
    return radius;
  }

  function createVoxelBoxBatch(group: Group): VoxelBoxBatch {
    if (!cubeGeometry) throw new Error("Voxel geometry is not ready");
    const batches = new Map<MeshStandardMaterial | MeshBasicMaterial, VoxelBoxInstance[]>();

    return {
      add: (material, x, y, z, sx, sy, sz) => {
        const batch = batches.get(material) ?? [];
        batch.push({ x, y, z, sx, sy, sz });
        batches.set(material, batch);
      },
      flush: () => {
        for (const [material, boxes] of batches) {
          if (boxes.length === 0 || !cubeGeometry) continue;
          const mesh = new InstancedMesh(cubeGeometry, material, boxes.length);
          mesh.frustumCulled = false;
          boxes.forEach((box, index) => {
            tmpPosition.set(box.x, box.y, box.z);
            tmpQuaternion.identity();
            tmpScale.set(box.sx, box.sy, box.sz);
            tmpMatrix.compose(tmpPosition, tmpQuaternion, tmpScale);
            mesh.setMatrixAt(index, tmpMatrix);
          });
          mesh.instanceMatrix.needsUpdate = true;
          group.add(mesh);
        }
        batches.clear();
      },
    };
  }

  function addVoxelBox(
    group: Group,
    material: MeshStandardMaterial | MeshBasicMaterial,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ): Mesh | undefined {
    if (!cubeGeometry) throw new Error("Voxel geometry is not ready");
    if (environmentVoxelBatch) {
      environmentVoxelBatch.add(material, x, y, z, sx, sy, sz);
      return undefined;
    }
    const mesh = new Mesh(cubeGeometry, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    group.add(mesh);
    return mesh;
  }

  function createEnvironmentMaterial(
    color: string,
    options: ConstructorParameters<typeof MeshStandardMaterial>[0] = {},
  ): MeshStandardMaterial {
    return new MeshStandardMaterial({
      color,
      roughness: 0.82,
      metalness: 0,
      flatShading: true,
      ...options,
    });
  }

  function createVoxelTree(
    group: Group,
    x: number,
    z: number,
    scale: number,
    baseY: number,
    materials: {
      trunk: MeshStandardMaterial;
      leaf: MeshStandardMaterial;
      leafLight: MeshStandardMaterial;
      blossom?: MeshStandardMaterial;
    },
    seed = `${x}:${z}`,
  ): void {
    if (!cubeGeometry) throw new Error("Voxel geometry is not ready");
    const variant = stableNoise(`tree:variant:${seed}`);
    addVoxelBox(
      group,
      materials.trunk,
      x,
      baseY + 7 * scale,
      z,
      3.2 * scale,
      14 * scale,
      3.2 * scale,
    );
    addVoxelBox(
      group,
      materials.leaf,
      x,
      baseY + 19 * scale,
      z,
      13 * scale,
      11 * scale,
      13 * scale,
    );
    addVoxelBox(
      group,
      materials.leafLight,
      x - 2.8 * scale,
      baseY + 26 * scale,
      z + 1.8 * scale,
      10 * scale,
      8 * scale,
      10 * scale,
    );
    if (variant > 0.72) {
      addVoxelBox(
        group,
        materials.leafLight,
        x + 3.2 * scale,
        baseY + 24 * scale,
        z - 2.4 * scale,
        8 * scale,
        7 * scale,
        8 * scale,
      );
    }
    if (materials.blossom && variant > 0.84) {
      addVoxelBox(
        group,
        materials.blossom,
        x,
        baseY + 28 * scale,
        z,
        9 * scale,
        5 * scale,
        9 * scale,
      );
    }
  }

  function createRetroSkyTexture(palette: RetroSkyPalette): CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    if (context) {
      const width = canvas.width;
      const height = canvas.height;
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, palette.top);
      gradient.addColorStop(0.34, palette.mid);
      gradient.addColorStop(0.72, palette.bottom);
      gradient.addColorStop(1, palette.bottom);
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);

      context.globalAlpha = 0.16;
      context.fillStyle = palette.band;
      context.fillRect(0, Math.floor(height * 0.58), width, 10);
      context.globalAlpha = 0.12;
      context.fillRect(0, Math.floor(height * 0.66), width, 5);
      context.globalAlpha = 0.1;
      context.fillStyle = palette.line;
      for (let y = Math.floor(height * 0.42); y < height; y += 14) {
        context.fillRect(0, y, width, 1);
      }
      context.globalAlpha = 1;
    }

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
  }

  function createSkyMaterial(palette: RetroSkyPalette): MeshBasicMaterial {
    const material = new MeshBasicMaterial({
      map: createRetroSkyTexture(palette),
      fog: false,
      side: BackSide,
      depthWrite: false,
    });
    material.depthTest = false;
    return material;
  }

  function createSkyDome(radius: number, palette: RetroSkyPalette): Mesh {
    const geometry = new SphereGeometry(radius * 3.6, 40, 24);
    const material = createSkyMaterial(palette);
    const dome = new Mesh(geometry, material);
    dome.renderOrder = -20;
    return dome;
  }

  function createOfficeAccentLights(
    group: Group,
    room: OfficeRoom,
    baseY: number,
    officeWidth: number,
    officeDepth: number,
    accentColor: string,
  ): void {
    if (!cubeGeometry) return;
    const warmLight = new MeshBasicMaterial({
      color: accentColor,
      transparent: true,
      opacity: 0.78,
      fog: false,
      depthWrite: false,
    });
    const windowGlow = new MeshBasicMaterial({
      color: mixHexColor(accentColor, "#9ee8ff", 0.42),
      transparent: true,
      opacity: 0.52,
      fog: false,
      depthWrite: false,
    });
    const ceilingY = baseY + 44.5;
    const lightSpan = officeWidth * 0.22;
    for (let index = -1; index <= 1; index += 1) {
      const mesh = new Mesh(cubeGeometry, warmLight);
      mesh.position.set(
        room.center.x + index * lightSpan,
        ceilingY,
        room.center.z - officeDepth / 2 + 8,
      );
      mesh.scale.set(10, 1.2, 4.5);
      group.add(mesh);
    }
    const windowMesh = new Mesh(cubeGeometry, windowGlow);
    windowMesh.position.set(room.center.x, baseY + 24, room.center.z - officeDepth / 2 + 1.2);
    windowMesh.scale.set(officeWidth * 0.62, 18, 1.2);
    group.add(windowMesh);
  }

  function createTerrainIsland(
    group: Group,
    room: OfficeRoom,
    materials: {
      grass: MeshStandardMaterial;
      grassEdge: MeshStandardMaterial;
      grassDark: MeshStandardMaterial;
      sand: MeshStandardMaterial;
      sandEdge: MeshStandardMaterial;
      dirt: MeshStandardMaterial;
      dirtDark: MeshStandardMaterial;
      path: MeshStandardMaterial;
      water: MeshStandardMaterial;
      foam: MeshBasicMaterial;
      flower: MeshStandardMaterial;
      wood?: MeshStandardMaterial;
      rock: MeshStandardMaterial;
      trunk: MeshStandardMaterial;
      leaf: MeshStandardMaterial;
      leafLight: MeshStandardMaterial;
      blossom?: MeshStandardMaterial;
    },
  ): void {
    const baseY = room.elevation;
    const pad = isCompact() ? 34 : 50;
    const topWidth = room.width + pad * 2;
    const topDepth = room.depth + pad * 2;
    const coreWidth = room.width + pad * (isCompact() ? 0.9 : 1.02);
    const coreDepth = room.depth + pad * (isCompact() ? 0.84 : 0.96);
    const cliffHeight =
      (isCompact() ? 28 : 40) + stableNoise(`${room.name}:height`) * (isCompact() ? 18 : 28);
    const biomeNoise = stableNoise(`${room.name}:biome`);
    let topMaterial = materials.grass;
    if (biomeNoise < 0.16) {
      topMaterial = materials.sand;
    } else if (biomeNoise > 0.78) {
      topMaterial = materials.grassDark;
    }
    const edgeMaterial = biomeNoise < 0.16 ? materials.sandEdge : materials.grassEdge;
    const separatedShelfOffset = (rawOffset: number, key: string) => {
      const minOffset = isCompact() ? 3.2 : 4.8;
      const jitteredOffset =
        rawOffset + (stableNoise(`${key}:depth-jitter`) - 0.5) * (isCompact() ? 0.48 : 0.68);
      if (Math.abs(jitteredOffset) >= minOffset) return jitteredOffset;
      const direction =
        jitteredOffset < 0 || (jitteredOffset === 0 && stableNoise(`${key}:down`) > 0.5) ? -1 : 1;
      return direction * (minOffset + stableNoise(`${key}:lift`) * minOffset * 0.45);
    };
    const addTerrainShelf = (
      x: number,
      z: number,
      width: number,
      depth: number,
      heightOffset: number,
      shelfTopMaterial = topMaterial,
      shelfEdgeMaterial = edgeMaterial,
    ) => {
      const shelfHeight = Math.max(8, cliffHeight + heightOffset);
      const shelfDirtY = baseY - 5 - cliffHeight + shelfHeight / 2;
      const shelfTopY = baseY + heightOffset - 2.5;
      const shelfCurbY = baseY + heightOffset + 1.28;
      const curbThickness = isCompact() ? 5.6 : 6.8;
      const curbHeight = isCompact() ? 2.2 : 2.7;
      addVoxelBox(group, materials.dirt, x, shelfDirtY, z, width, shelfHeight, depth);
      addVoxelBox(group, shelfTopMaterial, x, shelfTopY, z, width, 5, depth);
      addVoxelBox(
        group,
        shelfEdgeMaterial,
        x,
        shelfCurbY,
        z - depth / 2 + curbThickness / 2,
        width * 0.9,
        curbHeight,
        curbThickness,
      );
      addVoxelBox(
        group,
        shelfEdgeMaterial,
        x,
        shelfCurbY,
        z + depth / 2 - curbThickness / 2,
        width * 0.9,
        curbHeight,
        curbThickness,
      );
      addVoxelBox(
        group,
        shelfEdgeMaterial,
        x - width / 2 + curbThickness / 2,
        shelfCurbY,
        z,
        curbThickness,
        curbHeight,
        depth * 0.9,
      );
      addVoxelBox(
        group,
        shelfEdgeMaterial,
        x + width / 2 - curbThickness / 2,
        shelfCurbY,
        z,
        curbThickness,
        curbHeight,
        depth * 0.9,
      );
    };

    addTerrainShelf(room.center.x, room.center.z, coreWidth, coreDepth, 0);

    const inletCount = 2 + Math.floor(stableNoise(`${room.name}:inlets`) * 3);
    for (let index = 0; index < inletCount; index += 1) {
      const side = Math.floor(stableNoise(`${room.name}:inlet:side:${index}`) * 4);
      const width = topWidth * (0.12 + stableNoise(`${room.name}:inlet:w:${index}`) * 0.16);
      const depth = topDepth * (0.1 + stableNoise(`${room.name}:inlet:d:${index}`) * 0.16);
      const along = stableNoise(`${room.name}:inlet:a:${index}`) * 0.58 - 0.29;
      const x =
        side < 2
          ? room.center.x + (side === 0 ? -1 : 1) * topWidth * 0.48
          : room.center.x + along * topWidth;
      const z =
        side < 2
          ? room.center.z + along * topDepth
          : room.center.z + (side === 2 ? -1 : 1) * topDepth * 0.48;
      addVoxelBox(
        group,
        materials.water,
        x,
        baseY + 0.62,
        z,
        side < 2 ? width * 0.78 : width,
        0.8,
        side < 2 ? depth : depth * 0.78,
      );
      addVoxelBox(
        group,
        materials.foam,
        x,
        baseY + 1.1,
        z,
        side < 2 ? width * 0.62 : width * 0.78,
        0.28,
        1.4,
      );
      addVoxelBox(group, materials.rock, x, baseY + 1.35, z, width * 0.22, 1.4, depth * 0.18);
    }

    const lobeSpecs = [
      { key: "nw", ox: -0.42, oz: -0.38, sx: 0.24, sz: 0.2 },
      { key: "ne", ox: 0.42, oz: -0.36, sx: 0.2, sz: 0.22 },
      { key: "sw", ox: -0.4, oz: 0.38, sx: 0.22, sz: 0.18 },
      { key: "se", ox: 0.38, oz: 0.42, sx: 0.22, sz: 0.2 },
    ];

    for (const lobe of lobeSpecs) {
      if (stableNoise(`${room.name}:lobe:${lobe.key}`) < 0.34) continue;
      const lobeWidth = topWidth * lobe.sx;
      const lobeDepth = topDepth * lobe.sz;
      const x = room.center.x + topWidth * lobe.ox;
      const z = room.center.z + topDepth * lobe.oz;
      const lobeHeight = separatedShelfOffset(
        (stableNoise(`${room.name}:lobe:h:${lobe.key}`) * 2 - 0.6) * (isCompact() ? 6 : 9),
        `${room.name}:lobe:${lobe.key}`,
      );
      addTerrainShelf(x, z, lobeWidth, lobeDepth, lobeHeight);
    }

    const terraceCount = isCompact() ? 5 : 8;
    for (let index = 0; index < terraceCount; index += 1) {
      const side = Math.floor(stableNoise(`${room.name}:terrace:side:${index}`) * 4);
      const shelfWidth = topWidth * (0.18 + stableNoise(`${room.name}:terrace:w:${index}`) * 0.18);
      const shelfDepth = topDepth * (0.16 + stableNoise(`${room.name}:terrace:d:${index}`) * 0.2);
      const along = stableNoise(`${room.name}:terrace:a:${index}`) * 0.78 - 0.39;
      const heightOffset = separatedShelfOffset(
        (index % 4) * (isCompact() ? 3.4 : 5.2) +
          (stableNoise(`${room.name}:terrace:h:${index}`) * 2 - 0.7) * (isCompact() ? 6 : 9),
        `${room.name}:terrace:${index}`,
      );
      const x =
        side < 2
          ? room.center.x + (side === 0 ? -1 : 1) * (coreWidth / 2 + shelfWidth * 0.38)
          : room.center.x + along * coreWidth;
      const z =
        side < 2
          ? room.center.z + along * coreDepth
          : room.center.z + (side === 2 ? -1 : 1) * (coreDepth / 2 + shelfDepth * 0.38);
      addTerrainShelf(x, z, shelfWidth, shelfDepth, heightOffset);
      if (index % 3 === 0 && biomeNoise >= 0.16) {
        createVoxelTree(group, x, z, isCompact() ? 0.42 : 0.55, baseY + heightOffset, materials);
      } else if (index % 3 === 1) {
        addVoxelBox(group, materials.rock, x, baseY + heightOffset + 1.8, z, 5.5, 3.4, 4.8);
      }
    }

    const miniIslandCount =
      (isCompact() ? 1 : 2) + Math.floor(stableNoise(`${room.name}:mini-islands`) * 2);
    for (let index = 0; index < miniIslandCount; index += 1) {
      const angle = stableNoise(`${room.name}:mini:angle:${index}`) * TAU;
      const distanceX = topWidth * (0.56 + stableNoise(`${room.name}:mini:dx:${index}`) * 0.22);
      const distanceZ = topDepth * (0.56 + stableNoise(`${room.name}:mini:dz:${index}`) * 0.22);
      const x = room.center.x + Math.cos(angle) * distanceX;
      const z = room.center.z + Math.sin(angle) * distanceZ;
      const islandWidth = topWidth * (0.12 + stableNoise(`${room.name}:mini:w:${index}`) * 0.1);
      const islandDepth = topDepth * (0.11 + stableNoise(`${room.name}:mini:d:${index}`) * 0.1);
      const heightOffset = separatedShelfOffset(
        (stableNoise(`${room.name}:mini:h:${index}`) * 2 - 1.25) * (isCompact() ? 9 : 14),
        `${room.name}:mini:${index}`,
      );
      addTerrainShelf(x, z, islandWidth, islandDepth, heightOffset);
      if (stableNoise(`${room.name}:mini:tree:${index}`) > 0.36 && biomeNoise >= 0.16) {
        createVoxelTree(group, x, z, isCompact() ? 0.36 : 0.46, baseY + heightOffset, materials);
      }

      const woodMaterial = materials.wood ?? materials.path;
      const bridgeY = baseY + Math.max(0, heightOffset) + 2.2;
      if (Math.abs(x - room.center.x) > Math.abs(z - room.center.z)) {
        const sign = Math.sign(x - room.center.x) || 1;
        const start = room.center.x + sign * (coreWidth / 2 + 4);
        const end = x - sign * (islandWidth / 2 + 3);
        const length = Math.abs(end - start);
        if (length > 16) {
          addVoxelBox(
            group,
            woodMaterial,
            (start + end) / 2,
            bridgeY,
            (room.center.z + z) / 2,
            length,
            1.7,
            6.2,
          );
        }
      } else {
        const sign = Math.sign(z - room.center.z) || 1;
        const start = room.center.z + sign * (coreDepth / 2 + 4);
        const end = z - sign * (islandDepth / 2 + 3);
        const length = Math.abs(end - start);
        if (length > 16) {
          addVoxelBox(
            group,
            woodMaterial,
            (room.center.x + x) / 2,
            bridgeY,
            (start + end) / 2,
            6.2,
            1.7,
            length,
          );
        }
      }
    }

    const plateauNoise = stableNoise(`${room.name}:plateau`);
    if (plateauNoise > 0.2) {
      const plateauHeight = (isCompact() ? 10 : 16) + plateauNoise * (isCompact() ? 10 : 16);
      const plateauWidth = topWidth * (0.16 + stableNoise(`${room.name}:plateau:w`) * 0.14);
      const plateauDepth = topDepth * (0.14 + stableNoise(`${room.name}:plateau:d`) * 0.14);
      const plateauX =
        room.center.x + (stableNoise(`${room.name}:plateau:x`) > 0.5 ? 1 : -1) * topWidth * 0.32;
      const plateauZ =
        room.center.z + (stableNoise(`${room.name}:plateau:z`) > 0.5 ? 1 : -1) * topDepth * 0.34;
      addTerrainShelf(plateauX, plateauZ, plateauWidth, plateauDepth, plateauHeight);
      if (biomeNoise >= 0.16) {
        createVoxelTree(
          group,
          plateauX,
          plateauZ,
          isCompact() ? 0.5 : 0.62,
          baseY + plateauHeight,
          materials,
        );
      } else {
        addVoxelBox(group, materials.rock, plateauX, baseY + plateauHeight + 2, plateauZ, 9, 4, 7);
      }
    }

    const pathY = baseY + 0.74;
    addVoxelBox(
      group,
      materials.path,
      room.center.x,
      pathY,
      room.center.z + room.depth / 2 + pad * 0.48,
      topWidth * 0.48,
      1.05,
      7.5,
    );
    addVoxelBox(
      group,
      materials.path,
      room.center.x - room.width * 0.2,
      pathY,
      room.center.z,
      7.5,
      1.05,
      room.depth * 0.78,
    );
    addVoxelBox(
      group,
      materials.wood ?? materials.path,
      room.center.x + room.width * 0.18,
      pathY + 0.55,
      room.center.z + room.depth / 2 + pad * 0.18,
      28,
      1.2,
      6.2,
    );

    const fleckCount = isCompact() ? 5 : 9;
    for (let index = 0; index < fleckCount; index += 1) {
      const x =
        room.center.x + (stableNoise(`${room.name}:fleck:x:${index}`) * 2 - 1) * topWidth * 0.36;
      const z =
        room.center.z + (stableNoise(`${room.name}:fleck:z:${index}`) * 2 - 1) * topDepth * 0.34;
      const size = 1.5 + stableNoise(`${room.name}:fleck:s:${index}`) * 2.4;
      const material =
        stableNoise(`${room.name}:fleck:m:${index}`) > 0.82 ? materials.flower : edgeMaterial;
      addVoxelBox(group, material, x, baseY + 1.04, z, size, 0.55, size);
    }

    let treeCount = 1;
    if (biomeNoise > 0.78) {
      treeCount = 5;
    } else if (room.nodeCount > 18) {
      treeCount = 3;
    } else if (room.nodeCount > 5) {
      treeCount = 2;
    }
    for (let index = 0; index < treeCount; index++) {
      const side = stableNoise(`${room.name}:tree:side:${index}`);
      const x =
        room.center.x +
        (side > 0.5 ? 1 : -1) *
          (room.width / 2 + pad * (0.36 + stableNoise(`${room.name}:tree:x:${index}`) * 0.4));
      const z =
        room.center.z -
        room.depth / 2 +
        pad +
        stableNoise(`${room.name}:tree:z:${index}`) * (room.depth + pad * 0.4);
      createVoxelTree(group, x, z, isCompact() ? 0.58 : 0.72, baseY, materials);
    }

    if (stableNoise(`${room.name}:rocks`) > 0.48) {
      for (let index = 0; index < 3; index++) {
        const x =
          room.center.x + (stableNoise(`${room.name}:rock:x:${index}`) * 2 - 1) * topWidth * 0.42;
        const z =
          room.center.z + (stableNoise(`${room.name}:rock:z:${index}`) * 2 - 1) * topDepth * 0.42;
        addVoxelBox(
          group,
          materials.rock,
          x,
          baseY + 1.2,
          z,
          5 + stableNoise(`${room.name}:rock:s:${index}`) * 5,
          3.2,
          4.5,
        );
      }
    }
  }

  function createTerrainBridge(
    group: Group,
    source: OfficeRoom,
    target: OfficeRoom,
    material: MeshStandardMaterial,
  ): void {
    const pad = isCompact() ? 34 : 50;
    const dx = target.center.x - source.center.x;
    const dz = target.center.z - source.center.z;
    const y = Math.max(source.elevation, target.elevation) + 2.6;

    if (Math.abs(dx) > Math.abs(dz)) {
      const sign = Math.sign(dx) || 1;
      const start = source.center.x + sign * (source.width / 2 + pad * 0.74);
      const end = target.center.x - sign * (target.width / 2 + pad * 0.74);
      const length = Math.abs(end - start);
      if (length < 14 || length > 220) return;
      const x = (start + end) / 2;
      const z = (source.center.z + target.center.z) / 2;
      addVoxelBox(group, material, x, y, z, length, 2.2, 9);
      addVoxelBox(group, material, x, y + 2.8, z - 6.2, length, 2, 1.5);
      addVoxelBox(group, material, x, y + 2.8, z + 6.2, length, 2, 1.5);
      for (let offset = -length / 2 + 8; offset < length / 2; offset += 14) {
        addVoxelBox(group, material, x + offset, y + 1.6, z, 2.6, 1.4, 12);
      }
      return;
    }

    const sign = Math.sign(dz) || 1;
    const start = source.center.z + sign * (source.depth / 2 + pad * 0.74);
    const end = target.center.z - sign * (target.depth / 2 + pad * 0.74);
    const length = Math.abs(end - start);
    if (length < 14 || length > 220) return;
    const x = (source.center.x + target.center.x) / 2;
    const z = (start + end) / 2;
    addVoxelBox(group, material, x, y, z, 9, 2.2, length);
    addVoxelBox(group, material, x - 6.2, y + 2.8, z, 1.5, 2, length);
    addVoxelBox(group, material, x + 6.2, y + 2.8, z, 1.5, 2, length);
    for (let offset = -length / 2 + 8; offset < length / 2; offset += 14) {
      addVoxelBox(group, material, x, y + 1.6, z + offset, 12, 1.4, 2.6);
    }
  }

  function createPlant(
    group: Group,
    x: number,
    z: number,
    baseY: number,
    materials: {
      plantPot: MeshStandardMaterial;
      plantTrunk: MeshStandardMaterial;
      plantLeaf: MeshStandardMaterial;
    },
  ): void {
    if (!cubeGeometry) throw new Error("Voxel geometry is not ready");
    addVoxelBox(group, materials.plantPot, x, baseY + 4, z, 8, 8, 8);
    addVoxelBox(group, materials.plantTrunk, x, baseY + 14, z, 2, 13, 2);
    addVoxelBox(group, materials.plantLeaf, x, baseY + 25, z, 10, 14, 9);
  }

  function createServerRack(
    group: Group,
    x: number,
    z: number,
    baseY: number,
    materials: {
      rack: MeshStandardMaterial;
      rackStripe: MeshBasicMaterial;
    },
  ): void {
    if (!cubeGeometry) throw new Error("Voxel geometry is not ready");
    addVoxelBox(group, materials.rack, x, baseY + 17, z, 12, 34, 9);
    addVoxelBox(group, materials.rackStripe, x, baseY + 23, z + 0.1, 10, 1.2, 9.3);
  }

  function createArchiveShelf(
    group: Group,
    x: number,
    z: number,
    baseY: number,
    levels: number,
    materials: {
      shelf: MeshStandardMaterial;
      bookBlue: MeshStandardMaterial;
      bookRed: MeshStandardMaterial;
      bookYellow: MeshStandardMaterial;
      paper: MeshStandardMaterial;
    },
  ): void {
    addVoxelBox(group, materials.shelf, x, baseY + 15, z, 18, 30, 4.5);
    for (let level = 0; level < levels; level += 1) {
      const y = baseY + 7 + level * 7.2;
      addVoxelBox(group, materials.shelf, x, y, z - 2.7, 18.8, 1.4, 2.2);
      for (let slot = 0; slot < 5; slot += 1) {
        const bookMaterial = bookMaterialForSlot(slot, materials);
        const height = 4.4 + stableNoise(`archive:${x}:${z}:${level}:${slot}`) * 3.4;
        addVoxelBox(
          group,
          bookMaterial,
          x - 7.2 + slot * 3.4,
          y + height / 2 + 0.8,
          z - 4.2,
          1.8,
          height,
          1.7,
        );
      }
    }
    addVoxelBox(group, materials.paper, x + 6.6, baseY + 29.4, z - 4.6, 4.6, 1.2, 3.2);
  }

  function createSignalBeacon(
    group: Group,
    x: number,
    z: number,
    baseY: number,
    power: number,
    materials: {
      beacon: MeshStandardMaterial;
      beaconGlow: MeshBasicMaterial;
      cable: MeshStandardMaterial;
    },
  ): void {
    const height = 18 + power * 7;
    addVoxelBox(group, materials.beacon, x, baseY + 2.4, z, 10, 4.8, 10);
    addVoxelBox(group, materials.beacon, x, baseY + height / 2 + 4, z, 2.4, height, 2.4);
    addVoxelBox(
      group,
      materials.beaconGlow,
      x,
      baseY + height + 9,
      z,
      8 + power * 2,
      5,
      8 + power * 2,
    );
    addVoxelBox(
      group,
      materials.beaconGlow,
      x,
      baseY + height + 15 + power * 2,
      z,
      12 + power * 3,
      1.2,
      12 + power * 3,
    );
    addVoxelBox(group, materials.cable, x - 7, baseY + 4.2, z, 12, 1.3, 2);
  }

  function createArchiveMonument(
    group: Group,
    x: number,
    z: number,
    baseY: number,
    power: number,
    materials: {
      shelf: MeshStandardMaterial;
      bookBlue: MeshStandardMaterial;
      bookRed: MeshStandardMaterial;
      bookYellow: MeshStandardMaterial;
      paper: MeshStandardMaterial;
    },
  ): void {
    const levels = clamp(Math.floor(power), 1, 5);
    addVoxelBox(group, materials.shelf, x, baseY + 2.2, z, 24, 4.4, 18);
    for (let level = 0; level < levels; level += 1) {
      const y = baseY + 7 + level * 8.2;
      const width = 22 - level * 2.1;
      const depth = 15 - level * 1.1;
      addVoxelBox(group, materials.paper, x, y, z, width, 2.1, depth);
      addVoxelBox(group, materials.shelf, x, y + 2.15, z - depth / 2 - 0.7, width + 2.4, 1.6, 1.8);
      for (let slot = 0; slot < 4; slot += 1) {
        const material = bookMaterialForSlot(slot, materials);
        addVoxelBox(
          group,
          material,
          x - width * 0.34 + slot * (width * 0.22),
          y + 5.1,
          z - depth / 2 - 2.1,
          2.2,
          6.2,
          2.1,
        );
      }
    }
    addVoxelBox(group, materials.bookYellow, x, baseY + 9 + levels * 8.2, z, 8, 3.4, 8);
  }

  function createNetworkSpire(
    group: Group,
    x: number,
    z: number,
    baseY: number,
    power: number,
    materials: {
      beacon: MeshStandardMaterial;
      beaconGlow: MeshBasicMaterial;
      cable: MeshStandardMaterial;
    },
  ): void {
    const height = 24 + power * 8;
    addVoxelBox(group, materials.beacon, x, baseY + 3, z, 13, 6, 13);
    addVoxelBox(group, materials.beacon, x, baseY + height / 2 + 5, z, 3, height, 3);
    addVoxelBox(
      group,
      materials.beaconGlow,
      x,
      baseY + height * 0.52 + 8,
      z,
      18 + power * 3,
      1.6,
      3.2,
    );
    addVoxelBox(
      group,
      materials.beaconGlow,
      x,
      baseY + height * 0.52 + 8,
      z,
      3.2,
      1.6,
      18 + power * 3,
    );
    addVoxelBox(
      group,
      materials.beaconGlow,
      x,
      baseY + height + 11,
      z,
      11 + power * 2,
      6.2,
      11 + power * 2,
    );
    addVoxelBox(group, materials.cable, x - 14, baseY + 4.6, z, 20, 1.2, 2.2);
    addVoxelBox(group, materials.cable, x, baseY + 4.8, z + 12, 2.2, 1.2, 18);
  }

  function createCommonsCanopy(
    group: Group,
    x: number,
    z: number,
    baseY: number,
    scale: number,
    materials: {
      wood?: MeshStandardMaterial;
      path: MeshStandardMaterial;
      paper: MeshStandardMaterial;
      bookBlue: MeshStandardMaterial;
      bookRed: MeshStandardMaterial;
    },
  ): void {
    const wood = materials.wood ?? materials.path;
    addVoxelBox(
      group,
      wood,
      x - 13 * scale,
      baseY + 8 * scale,
      z - 9 * scale,
      2.2 * scale,
      16 * scale,
      2.2 * scale,
    );
    addVoxelBox(
      group,
      wood,
      x + 13 * scale,
      baseY + 8 * scale,
      z - 9 * scale,
      2.2 * scale,
      16 * scale,
      2.2 * scale,
    );
    addVoxelBox(
      group,
      wood,
      x - 13 * scale,
      baseY + 8 * scale,
      z + 9 * scale,
      2.2 * scale,
      16 * scale,
      2.2 * scale,
    );
    addVoxelBox(
      group,
      wood,
      x + 13 * scale,
      baseY + 8 * scale,
      z + 9 * scale,
      2.2 * scale,
      16 * scale,
      2.2 * scale,
    );
    addVoxelBox(
      group,
      materials.paper,
      x,
      baseY + 17.4 * scale,
      z,
      32 * scale,
      2.4 * scale,
      24 * scale,
    );
    addVoxelBox(
      group,
      materials.bookBlue,
      x - 7 * scale,
      baseY + 20 * scale,
      z,
      9 * scale,
      2.2 * scale,
      6 * scale,
    );
    addVoxelBox(
      group,
      materials.bookRed,
      x + 7 * scale,
      baseY + 20 * scale,
      z + 1.8 * scale,
      8 * scale,
      2.2 * scale,
      5.6 * scale,
    );
    addVoxelBox(group, wood, x, baseY + 5.6 * scale, z, 22 * scale, 2.6 * scale, 9 * scale);
    addVoxelBox(
      group,
      materials.path,
      x,
      baseY + 1.1 * scale,
      z,
      38 * scale,
      1.1 * scale,
      26 * scale,
    );
  }

  function createEnvironment(nodes: readonly GraphNode[] = []): void {
    if (!scene || !cubeGeometry) return;
    if (environmentGroup) {
      scene.remove(environmentGroup);
      disposeObject(environmentGroup, {
        preserveGeometry: (geometry) => geometry === cubeGeometry,
      });
    }
    if (environmentAnim.skyDome) {
      scene.remove(environmentAnim.skyDome);
      environmentAnim.skyDome.geometry.dispose();
      disposeMaterial(environmentAnim.skyDome.material);
      environmentAnim.skyDome = undefined;
    }
    environmentAnim = { waterMaterials: [] };

    const state = graphState();
    rooms = createOfficeRooms(nodes, state?.clusters ?? [], isCompact());
    const group = new Group();
    const radius = environmentRadius();
    const floorMaterial = createEnvironmentMaterial(
      cssVar("--color-voxel-office-floor", "#f9f4e6"),
      {
        roughness: 0.88,
      },
    );
    const floorTrimMaterial = createEnvironmentMaterial(
      cssVar("--color-voxel-office-trim", "#d8c79b"),
      {
        roughness: 0.84,
      },
    );
    const wallMaterial = createEnvironmentMaterial(cssVar("--color-voxel-office-wall", "#c4c3b7"), {
      roughness: 0.86,
    });
    const wallPanelMaterial = createEnvironmentMaterial("#aeb3ad", { roughness: 0.82 });
    const wallRailMaterial = createEnvironmentMaterial("#526a73", {
      roughness: 0.76,
      metalness: 0.04,
    });
    const lowWallMaterial = createEnvironmentMaterial(
      cssVar("--color-voxel-office-low-wall", "#526a73"),
      { roughness: 0.8 },
    );
    const boardMaterial = createEnvironmentMaterial("#e6dcc0", {
      roughness: 0.42,
      emissive: "#e6dcc0",
      emissiveIntensity: 0.08,
    });
    const boardFrameMaterial = createEnvironmentMaterial(RETRO_SLATE, {
      roughness: 0.62,
      metalness: 0.06,
    });
    const boardInkMaterial = createEnvironmentMaterial(RETRO_BLUE, {
      roughness: 0.5,
      emissive: RETRO_BLUE,
      emissiveIntensity: 0.06,
    });
    const posterWarmMaterial = createEnvironmentMaterial(RETRO_ORANGE, {
      roughness: 0.6,
      emissive: RETRO_ORANGE,
      emissiveIntensity: 0.08,
    });
    const posterCoolMaterial = createEnvironmentMaterial(RETRO_CYAN, {
      roughness: 0.6,
      emissive: RETRO_CYAN,
      emissiveIntensity: 0.08,
    });
    const rugMaterial = createEnvironmentMaterial("#9aaa65", { roughness: 0.84 });
    const cableMaterial = createEnvironmentMaterial(RETRO_BLUE, {
      roughness: 0.64,
      emissive: RETRO_BLUE,
      emissiveIntensity: 0.04,
    });
    const cabinetMaterial = createEnvironmentMaterial("#8b9692", {
      roughness: 0.68,
      metalness: 0.04,
    });
    const cabinetHandleMaterial = createEnvironmentMaterial(RETRO_SLATE, {
      roughness: 0.62,
      metalness: 0.08,
    });
    const terrainMaterials = {
      grass: createEnvironmentMaterial(cssVar("--color-voxel-world-grass", "#6ec442"), {
        roughness: 0.76,
      }),
      grassEdge: createEnvironmentMaterial(cssVar("--color-voxel-world-grass-edge", "#8cdb45"), {
        roughness: 0.72,
      }),
      grassDark: createEnvironmentMaterial(cssVar("--color-voxel-world-grass-dark", "#2e8c69"), {
        roughness: 0.78,
      }),
      sand: createEnvironmentMaterial(cssVar("--color-voxel-world-sand", "#d9ba79"), {
        roughness: 0.88,
      }),
      sandEdge: createEnvironmentMaterial(cssVar("--color-voxel-world-sand-edge", "#efcf8d"), {
        roughness: 0.84,
      }),
      dirt: createEnvironmentMaterial(cssVar("--color-voxel-world-dirt", "#d89464"), {
        roughness: 0.88,
      }),
      dirtDark: createEnvironmentMaterial(cssVar("--color-voxel-world-dirt-dark", "#aa724e"), {
        roughness: 0.9,
      }),
      path: createEnvironmentMaterial(cssVar("--color-voxel-world-path", "#e8cf91"), {
        roughness: 0.84,
      }),
      water: createEnvironmentMaterial(cssVar("--color-voxel-world-water", "#2a9fd4"), {
        roughness: 0.28,
        metalness: 0.06,
        emissive: cssVar("--color-voxel-world-water-emissive", "#2caee0"),
        emissiveIntensity: 0.18,
      }),
      foam: new MeshBasicMaterial({ color: "#e4d9b8", transparent: true, opacity: 0.92 }),
      flower: createEnvironmentMaterial(cssVar("--color-voxel-world-flower", "#f4c94a"), {
        roughness: 0.68,
        emissive: cssVar("--color-voxel-world-flower", "#f4c94a"),
        emissiveIntensity: 0.14,
      }),
      blossom: createEnvironmentMaterial("#c65b4a", {
        roughness: 0.68,
        emissive: "#c65b4a",
        emissiveIntensity: 0.12,
      }),
      wood: createEnvironmentMaterial(cssVar("--color-voxel-world-wood", "#8a5c34"), {
        roughness: 0.86,
      }),
      rock: createEnvironmentMaterial(cssVar("--color-voxel-world-rock", "#6a7f92"), {
        roughness: 0.9,
      }),
      trunk: createEnvironmentMaterial(cssVar("--color-voxel-world-wood", "#8a5c34"), {
        roughness: 0.88,
      }),
      leaf: createEnvironmentMaterial(cssVar("--color-voxel-world-leaf", "#2f8f6a"), {
        roughness: 0.78,
      }),
      leafLight: createEnvironmentMaterial(cssVar("--color-voxel-world-leaf-light", "#5ecf8f"), {
        roughness: 0.72,
      }),
      plantPot: createEnvironmentMaterial("#d7b56d", { roughness: 0.75 }),
      plantTrunk: createEnvironmentMaterial("#7b4a2d", { roughness: 0.8 }),
      plantLeaf: createEnvironmentMaterial("#286f49", { roughness: 0.7, flatShading: true }),
      rack: createEnvironmentMaterial("#526a73", { roughness: 0.56, metalness: 0.08 }),
      rackStripe: new MeshBasicMaterial({ color: "#e0bc2f" }),
      shelf: createEnvironmentMaterial("#646f67", { roughness: 0.72, metalness: 0.04 }),
      cable: cableMaterial,
      bookBlue: createEnvironmentMaterial(RETRO_BLUE, {
        roughness: 0.58,
        emissive: RETRO_BLUE,
        emissiveIntensity: 0.08,
      }),
      bookRed: createEnvironmentMaterial(RETRO_RED, {
        roughness: 0.58,
        emissive: RETRO_RED,
        emissiveIntensity: 0.08,
      }),
      bookYellow: createEnvironmentMaterial(RETRO_YELLOW, {
        roughness: 0.6,
        emissive: RETRO_YELLOW,
        emissiveIntensity: 0.08,
      }),
      paper: createEnvironmentMaterial(RETRO_PAPER, { roughness: 0.72 }),
      beacon: createEnvironmentMaterial(RETRO_SLATE, { roughness: 0.52, metalness: 0.12 }),
      beaconGlow: new MeshBasicMaterial({
        color: "#19a9d0",
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
      }),
    };
    environmentAnim.waterMaterials.push(terrainMaterials.water);

    const skyPalette = retroSkyPalette();

    const voxelBatch = createVoxelBoxBatch(group);
    environmentVoxelBatch = voxelBatch;

    try {
      updateCameraClipPlanes(radius);
      rooms.forEach((room, index) => {
        if (index === 0) return;
        let nearest: OfficeRoom | null = null;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const previous of rooms.slice(0, index)) {
          const distance = room.center.distanceTo(previous.center);
          if (distance >= nearestDistance) continue;
          nearest = previous;
          nearestDistance = distance;
        }
        if (nearest) createTerrainBridge(group, nearest, room, terrainMaterials.wood);
      });

      for (const room of rooms) {
        createTerrainIsland(group, room, terrainMaterials);

        const baseY = room.elevation;
        const officeInset = isCompact() ? 30 : 44;
        const officeWidth = Math.max(42, room.width - officeInset * 2);
        const officeDepth = Math.max(38, room.depth - officeInset * 2);
        const wallThickness = isCompact() ? 6.5 : 9;
        const wallHeight = isCompact() ? 42 : 52;
        const wallTopY = baseY + wallHeight + 1.4;
        const wallCenterY = baseY + wallHeight / 2;

        const gridWidth = (room.columns - 1) * room.cellWidth + (isCompact() ? 32 : 42);
        const gridDepth = (room.rows - 1) * room.cellDepth + (isCompact() ? 32 : 42);
        const rowMatDepth = isCompact() ? 29 : 36;
        const xStart = room.center.x - ((room.columns - 1) * room.cellWidth) / 2;
        const zStart = room.center.z - ((room.rows - 1) * room.cellDepth) / 2;
        addVoxelBox(
          group,
          floorTrimMaterial,
          room.center.x,
          baseY - 0.92,
          room.center.z,
          gridWidth + 16,
          1.05,
          gridDepth + 16,
        );
        addVoxelBox(
          group,
          floorMaterial,
          room.center.x,
          baseY - 0.34,
          room.center.z,
          gridWidth + 10,
          1.05,
          gridDepth + 10,
        );
        for (let row = 0; row < room.rows; row += 1) {
          const usedColumns = Math.min(
            room.columns,
            Math.max(1, room.nodeCount - row * room.columns),
          );
          const rowWidth = Math.min(
            officeWidth,
            (usedColumns - 1) * room.cellWidth + (isCompact() ? 35 : 46),
          );
          const rowX = xStart + ((usedColumns - 1) * room.cellWidth) / 2;
          const rowZ = zStart + row * room.cellDepth + 3;
          addVoxelBox(
            group,
            floorTrimMaterial,
            rowX,
            baseY - 0.68,
            rowZ,
            rowWidth + 7,
            1,
            rowMatDepth + 6,
          );
          addVoxelBox(group, floorMaterial, rowX, baseY - 0.12, rowZ, rowWidth, 1, rowMatDepth);
        }

        addVoxelBox(
          group,
          terrainMaterials.path,
          room.center.x,
          baseY + 0.12,
          room.center.z,
          7.5,
          1.1,
          officeDepth * 0.92,
        );
        addVoxelBox(
          group,
          terrainMaterials.path,
          room.center.x,
          baseY + 0.12,
          room.center.z + officeDepth * 0.42,
          officeWidth * 0.74,
          1.1,
          7.5,
        );

        const backWallZ = room.center.z - officeDepth / 2 - wallThickness / 2;
        const leftWallX = room.center.x - officeWidth / 2 - wallThickness / 2;
        const rightReturnX = room.center.x + officeWidth / 2 - wallThickness / 2;
        const frontDividerZ = room.center.z + officeDepth / 2 - wallThickness / 2;
        const leftWallDepth = officeDepth;
        const leftRailDepth = Math.max(18, officeDepth - wallThickness * 2.2);
        const leftRailZ = room.center.z + wallThickness * 1.1;
        const panelThickness = 1.6;
        const panelLift = 0.7;
        const backOuterPanelZ = backWallZ - wallThickness / 2 - panelThickness / 2 - panelLift;
        const leftOuterPanelX = leftWallX - wallThickness / 2 - panelThickness / 2 - panelLift;
        addVoxelBox(
          group,
          wallRailMaterial,
          room.center.x,
          baseY + 1.8,
          backWallZ - 0.4,
          officeWidth + wallThickness * 2,
          3.6,
          wallThickness + 1.6,
        );
        addVoxelBox(
          group,
          wallMaterial,
          room.center.x,
          wallCenterY,
          backWallZ,
          officeWidth + wallThickness * 2,
          wallHeight,
          wallThickness,
        );
        addVoxelBox(
          group,
          wallRailMaterial,
          room.center.x,
          wallTopY,
          backWallZ - 0.2,
          officeWidth + wallThickness * 2.2,
          4.4,
          wallThickness + 2.2,
        );
        addVoxelBox(
          group,
          wallPanelMaterial,
          room.center.x - officeWidth * 0.26,
          baseY + 25,
          backOuterPanelZ,
          officeWidth * 0.28,
          wallHeight - 13,
          panelThickness,
        );
        addVoxelBox(
          group,
          wallPanelMaterial,
          room.center.x + officeWidth * 0.22,
          baseY + 25,
          backOuterPanelZ,
          officeWidth * 0.24,
          wallHeight - 13,
          panelThickness,
        );

        addVoxelBox(
          group,
          wallRailMaterial,
          leftWallX - 0.4,
          baseY + 1.8,
          leftRailZ,
          wallThickness + 1.6,
          3.6,
          leftRailDepth,
        );
        addVoxelBox(
          group,
          wallMaterial,
          leftWallX,
          wallCenterY - 1,
          room.center.z,
          wallThickness,
          wallHeight - 2,
          leftWallDepth,
        );
        addVoxelBox(
          group,
          wallRailMaterial,
          leftWallX - 0.2,
          wallTopY - 1,
          leftRailZ,
          wallThickness + 2.2,
          4.4,
          leftRailDepth,
        );
        addVoxelBox(
          group,
          wallPanelMaterial,
          leftOuterPanelX,
          baseY + 24,
          room.center.z - officeDepth * 0.18,
          panelThickness,
          wallHeight - 14,
          officeDepth * 0.34,
        );
        addVoxelBox(
          group,
          wallRailMaterial,
          leftWallX,
          wallCenterY,
          backWallZ,
          wallThickness + 4.2,
          wallHeight + 3.8,
          wallThickness + 4.2,
        );
        addVoxelBox(
          group,
          wallRailMaterial,
          room.center.x + officeWidth / 2 + wallThickness / 2,
          wallCenterY,
          backWallZ,
          wallThickness + 4.2,
          wallHeight + 3.8,
          wallThickness + 4.2,
        );
        addVoxelBox(
          group,
          wallRailMaterial,
          leftWallX,
          baseY + 14.5,
          room.center.z + officeDepth / 2 - wallThickness / 2,
          wallThickness + 3.4,
          29,
          wallThickness + 3.4,
        );

        addVoxelBox(
          group,
          lowWallMaterial,
          rightReturnX,
          baseY + 13,
          room.center.z - officeDepth * 0.08,
          wallThickness,
          26,
          officeDepth * 0.54,
        );
        addVoxelBox(
          group,
          wallRailMaterial,
          rightReturnX,
          baseY + 27.5,
          room.center.z - officeDepth * 0.08,
          wallThickness + 2.5,
          3,
          officeDepth * 0.56,
        );
        addVoxelBox(
          group,
          lowWallMaterial,
          room.center.x + officeWidth * 0.12,
          baseY + 9,
          frontDividerZ,
          officeWidth * 0.54,
          18,
          wallThickness,
        );
        addVoxelBox(
          group,
          wallRailMaterial,
          room.center.x + officeWidth * 0.12,
          baseY + 19.2,
          frontDividerZ,
          officeWidth * 0.56,
          2.8,
          wallThickness + 2,
        );

        const boardX = room.center.x - officeWidth * 0.16;
        const boardZ = room.center.z - officeDepth / 2 + 1.45;
        const boardWidth = Math.min(officeWidth * 0.42, isCompact() ? 42 : 64);
        addVoxelBox(
          group,
          boardFrameMaterial,
          boardX,
          baseY + 31,
          boardZ,
          boardWidth + 4.8,
          17.5,
          2.8,
        );
        addVoxelBox(group, boardMaterial, boardX, baseY + 31, boardZ + 1.7, boardWidth, 12.8, 2.2);
        addVoxelBox(
          group,
          boardInkMaterial,
          boardX - boardWidth * 0.24,
          baseY + 33.4,
          boardZ + 3.1,
          boardWidth * 0.25,
          1.25,
          2.6,
        );
        addVoxelBox(
          group,
          boardInkMaterial,
          boardX + boardWidth * 0.12,
          baseY + 30.4,
          boardZ + 3.1,
          boardWidth * 0.34,
          1.25,
          2.6,
        );
        addVoxelBox(
          group,
          posterWarmMaterial,
          room.center.x + officeWidth * 0.24,
          baseY + 31,
          boardZ + 1.8,
          10,
          13,
          2.4,
        );
        addVoxelBox(
          group,
          posterCoolMaterial,
          room.center.x + officeWidth * 0.34,
          baseY + 30.2,
          boardZ + 2,
          8.5,
          10.5,
          2.4,
        );

        addVoxelBox(
          group,
          rugMaterial,
          room.center.x,
          baseY + 0.72,
          room.center.z + officeDepth * 0.06,
          Math.min(officeWidth * 0.7, gridWidth + 18),
          0.9,
          Math.min(officeDepth * 0.36, gridDepth + 16),
        );
        addVoxelBox(
          group,
          cableMaterial,
          room.center.x,
          baseY + 1.24,
          room.center.z + officeDepth * 0.08,
          Math.min(officeWidth * 0.68, gridWidth + 12),
          0.75,
          1.6,
        );
        addVoxelBox(
          group,
          cableMaterial,
          room.center.x + officeWidth * 0.23,
          baseY + 1.26,
          room.center.z,
          1.6,
          0.75,
          Math.min(officeDepth * 0.44, gridDepth + 6),
        );

        const cabinetX = room.center.x + officeWidth / 2 - 14;
        const cabinetZ = room.center.z - officeDepth / 2 + 35;
        addVoxelBox(group, cabinetMaterial, cabinetX, baseY + 10, cabinetZ, 12, 20, 10);
        addVoxelBox(group, cabinetMaterial, cabinetX, baseY + 24, cabinetZ, 12, 8, 10);
        addVoxelBox(
          group,
          cabinetHandleMaterial,
          cabinetX - 0.1,
          baseY + 14,
          cabinetZ - 5.2,
          7,
          0.9,
          0.6,
        );
        addVoxelBox(
          group,
          cabinetHandleMaterial,
          cabinetX - 0.1,
          baseY + 24,
          cabinetZ - 5.2,
          7,
          0.9,
          0.6,
        );

        const roomLabel = new SpriteText(
          roomLabelText(room.name),
          isCompact() ? 4.6 : 5.4,
          cssVar("--color-voxel-label-text", "#344239"),
        );
        roomLabel.fontFace = "Goorm Sans, -apple-system, BlinkMacSystemFont, sans-serif";
        roomLabel.fontWeight = "800";
        roomLabel.backgroundColor = cssVar("--color-voxel-label-bg", "rgba(255,250,238,0.94)");
        roomLabel.borderColor = officeClusterColor(room.clusterIndex);
        roomLabel.borderWidth = 0.12;
        roomLabel.borderRadius = 1.2;
        roomLabel.padding = [1.35, 0.72];
        roomLabel.position.set(room.center.x, baseY + 46, room.center.z - officeDepth / 2 + 14);
        roomLabel.material.depthTest = false;
        roomLabel.material.depthWrite = false;
        group.add(roomLabel);

        createPlant(
          group,
          room.center.x - officeWidth / 2 + 18,
          room.center.z - officeDepth / 2 + 24,
          baseY,
          terrainMaterials,
        );
        if (room.nodeCount >= 10 || stableNoise(`${room.name}:rack`) > 0.62) {
          createServerRack(
            group,
            room.center.x + officeWidth / 2 - 18,
            room.center.z - officeDepth / 2 + 24,
            baseY,
            terrainMaterials,
          );
        }
        if (room.averageDocumentLength >= 900 || room.maxDocumentLength >= 1_800) {
          createArchiveShelf(
            group,
            room.center.x + officeWidth / 2 - 16,
            room.center.z - officeDepth / 2 + 52,
            baseY,
            clamp(Math.ceil(room.maxDocumentLength / 1_800), 2, 4),
            terrainMaterials,
          );
        }
        if (room.maxLinkCount >= 5 || room.averageLinkCount >= 2.2) {
          createSignalBeacon(
            group,
            room.center.x - officeWidth / 2 + 28,
            room.center.z + officeDepth / 2 - 22,
            baseY,
            clamp(Math.ceil(room.maxLinkCount / 4), 1, 4),
            terrainMaterials,
          );
        }
        if (room.maxDocumentLength >= 2_400 || room.averageDocumentLength >= 1_200) {
          createArchiveMonument(
            group,
            room.center.x + officeWidth / 2 + (isCompact() ? 10 : 16),
            room.center.z + officeDepth / 2 - (isCompact() ? 24 : 34),
            baseY,
            clamp(Math.ceil(room.maxDocumentLength / 1_400), 1, 5),
            terrainMaterials,
          );
        }
        if (room.maxLinkCount >= 6 || room.averageLinkCount >= 2.4) {
          createNetworkSpire(
            group,
            room.center.x - officeWidth / 2 - (isCompact() ? 10 : 16),
            room.center.z + officeDepth / 2 - (isCompact() ? 20 : 30),
            baseY,
            clamp(Math.ceil(Math.max(room.maxLinkCount, room.averageLinkCount * 2) / 3), 1, 5),
            terrainMaterials,
          );
        }
        if (room.nodeCount >= (isCompact() ? 16 : 24)) {
          createCommonsCanopy(
            group,
            room.center.x,
            room.center.z + officeDepth / 2 + (isCompact() ? 12 : 18),
            baseY,
            isCompact() ? 0.68 : 0.88,
            terrainMaterials,
          );
        }
        createOfficeAccentLights(
          group,
          room,
          baseY,
          officeWidth,
          officeDepth,
          officeClusterColor(room.clusterIndex),
        );
      }
    } finally {
      environmentVoxelBatch = undefined;
    }
    voxelBatch.flush();

    environmentAnim.skyDome = createSkyDome(radius, skyPalette);
    scene.add(environmentAnim.skyDome);

    environmentGroup = group;
    scene.add(group);
    applyVoxelWorldTheme();
  }

  function clearActiveLabels(): void {
    if (!labelGroup) return;
    while (labelGroup.children.length > 0) {
      const child = labelGroup.children[0];
      labelGroup.remove(child);
      disposeObject(child);
    }
  }

  function nodeLabelBorderColor(
    runtime: VoxelRuntimeNode,
    kind: "hover" | "selected" | "current",
  ): string {
    if (kind === "selected") return "#f0ad35";
    if (kind === "current") return "#28b99b";
    return nodeColor(runtime.node);
  }

  function addNodeLabel(runtime: VoxelRuntimeNode, kind: "hover" | "selected" | "current"): void {
    if (!labelGroup) return;
    const color = nodeLabelBorderColor(runtime, kind);
    const label = new SpriteText(
      shortLabel(runtime.node.name),
      isCompact() ? 6.5 : 8.2,
      cssVar("--color-voxel-label-text", "#2f3d35"),
    );
    label.fontFace = "Goorm Sans, -apple-system, BlinkMacSystemFont, sans-serif";
    label.fontWeight = "800";
    label.backgroundColor = cssVar("--color-voxel-label-bg", "rgba(255,250,236,0.96)");
    label.borderColor = color;
    label.borderWidth = 0.22;
    label.borderRadius = 2;
    label.padding = [2.4, 1.4];
    label.position.copy(runtime.position).add(new Vector3(0, 35 * runtime.size, 0));
    label.material.depthTest = false;
    label.material.depthWrite = false;
    label.material.depthFunc = AlwaysDepth;
    label.renderOrder = 10_000;
    labelGroup.add(label);
  }

  function clearGraphObjects(): void {
    if (workstationGroup) {
      scene?.remove(workstationGroup);
      disposeObject(workstationGroup, {
        preserveGeometry: (geometry) => geometry === cubeGeometry,
      });
      workstationGroup = undefined;
    }
    if (linkGroup) {
      scene?.remove(linkGroup);
      disposeObject(linkGroup, { preserveGeometry: (geometry) => geometry === cubeGeometry });
      linkGroup = undefined;
    }
    clearActiveLabels();
    meshes = undefined;
    linkMesh = undefined;
    highlightLinkMesh = undefined;
    runtimeNodes.clear();
    runtimeNodeList.length = 0;
    runtimeLinks.length = 0;
    pickableMeshes.length = 0;
    idleCursor = 0;
    lastVisualRuntimePaths = new Set();
    lastVisualFocusPath = undefined;
    setVisibleStats({ nodes: 0, links: 0 });
    setHoveredNode(null);
  }

  function rebuildGraphScene(): void {
    if (!scene || !cubeGeometry) return;
    const state = graphState();
    clearGraphObjects();

    const nodes = state?.nodes ?? [];
    createEnvironment(nodes);
    if (!state || nodes.length === 0) return;

    meshes = createOfficeMeshes(nodes.length);
    const roomIndexes = new Map<number, number>();

    for (const node of nodes) {
      const room = roomForNode(node, rooms);
      const roomIndex = roomIndexes.get(node.clusterIndex) ?? 0;
      roomIndexes.set(node.clusterIndex, roomIndex + 1);
      const instanceIndex = runtimeNodeList.length;
      const position = roomStationPosition(node, room, roomIndex, isCompact());
      const heading = stableNoise(`${node.id}:heading`) > 0.5 ? 0 : Math.PI;
      const characterType = characterTypeForNode(node);
      const hairColor = hairColorForNode(node);
      const baseShirtColor = paletteColorForNode(node, IDLE_SHIRT_COLORS, "shirt");
      const shirtColor = shirtColorForCharacter(node, characterType, baseShirtColor);
      const nodeSkinColor = skinColorForCharacter(node, characterType, skinColorForNode(node));
      const headTopColor = mixHexColor(nodeSkinColor, hairColor, 0.1);
      const faceShadowColor = mixHexColor(nodeSkinColor, "#8f5f45", 0.16);
      const runtime: VoxelRuntimeNode = {
        node,
        instanceIndex,
        position,
        room,
        size: agentScale(node, isCompact()),
        heading,
        characterType,
        skinColor: nodeSkinColor,
        hairColor,
        headTopColor,
        faceShadowColor,
        accessoryColor: paletteColorForNode(node, ACCESSORY_COLORS, "accessory"),
        secondaryColor: paletteColorForNode(node, SECONDARY_COLORS, "secondary"),
        visorColor: paletteColorForNode(node, VISOR_COLORS, "visor"),
        trimColor: paletteColorForNode(
          node,
          TRIM_COLORS,
          `trim:${documentLengthTier(node)}:${linkCountTier(node)}`,
        ),
        patternColor: paletteColorForNode(
          node,
          PATTERN_COLORS,
          `pattern:${outfitVariantForNode(node)}:${node.clusterIndex}`,
        ),
        outfitVariant: outfitVariantForNode(node),
        headsetColor: paletteColorForNode(node, HEADSET_COLORS, "headset"),
        chairColor: paletteColorForNode(node, CHAIR_COLORS, "chair"),
        deskColor: paletteColorForNode(node, DESK_COLORS, "desk"),
        deskAccentColor: paletteColorForNode(
          node,
          [RETRO_YELLOW, RETRO_BLUE, RETRO_RED, RETRO_GREEN],
          "desk-accessory",
        ),
        shirtColor,
        pantsColor: pantsColorForCharacter(node, characterType),
        shoeColor: paletteColorForNode(node, SHOE_COLORS, "shoes"),
        idlePhase: stableNoise(`${node.id}:idle:phase`) * TAU,
        idleSpeed: 0.72 + stableNoise(`${node.id}:idle:speed`) * 0.62,
        typingPhase: stableNoise(`${node.id}:typing:phase`) * TAU,
        clickPulseUntil: 0,
      };
      runtimeNodes.set(node.filePath, runtime);
      runtimeNodeList.push(runtime);
      writeStationInstances(runtime, 0);
    }

    linkGroup = new Group();
    scene.add(linkGroup);
    const visibleLinks = state.links.filter(
      (link) => runtimeNodes.has(link.source) && runtimeNodes.has(link.target),
    );
    linkMesh = createInstancedMesh(
      basicMaterial("#7ee0ff", { opacity: isCompact() ? 0.07 : 0.1 }),
      visibleLinks.length * 3,
    );
    highlightLinkMesh = createInstancedMesh(
      basicMaterial("#fff4a8", { opacity: 0.48 }),
      Math.max(1, visibleLinks.length * 3),
    );
    highlightLinkMesh.count = 0;
    linkGroup.add(linkMesh);
    linkGroup.add(highlightLinkMesh);

    let linkSegmentIndex = 0;
    visibleLinks.forEach((link, index) => {
      const source = runtimeNodes.get(link.source);
      const target = runtimeNodes.get(link.target);
      if (!source || !target || !linkMesh) return;
      runtimeLinks.push({ source, target, link });
      tmpSource.copy(agentLinkPoint(source));
      tmpSource.y = source.position.y + 10;
      tmpTarget.copy(agentLinkPoint(target));
      tmpTarget.y = target.position.y + 10;
      let color = "#8ee8ff";
      if (index % 5 === 0) {
        color = "#b8d4e8";
      } else if (index % 3 === 0) {
        color = "#2a9fd4";
      }
      linkSegmentIndex = setArcBeamInstances(
        linkMesh,
        linkSegmentIndex,
        tmpSource,
        tmpTarget,
        isCompact() ? 0.16 : 0.22,
        color,
        isCompact() ? 1 : 4,
      );
    });
    linkMesh.count = linkSegmentIndex;

    setVisibleStats({ nodes: runtimeNodeList.length, links: runtimeLinks.length });
    updateVisuals();
    markMeshUpdates();

    const focusedPath = currentFilePath();
    if (followMode() && focusedPath && runtimeNodes.has(focusedPath)) {
      locateNode(focusedPath);
    } else {
      fitView(0);
    }
  }

  function updateZoomFromCamera(): void {
    if (!camera || !controls) return;
    const dist = camera.position.distanceTo(controls.target);
    if (!Number.isFinite(dist) || dist <= 0) {
      setZoomLevel(1);
      return;
    }
    setZoomLevel(Math.max(0.1, Math.min(8, 520 / Math.max(1, dist))));
  }

  function clampCameraPolarAngle(): void {
    if (!camera || !controls) return;
    const offset = camera.position.clone().sub(controls.target);
    const radius = Math.max(1, offset.length());
    const polar = Math.acos(clamp(offset.y / radius, -1, 1));
    const clampedPolar = clamp(polar, CAMERA_MIN_POLAR_ANGLE, CAMERA_MAX_POLAR_ANGLE);
    if (Math.abs(clampedPolar - polar) < 0.001) return;
    const azimuth = Math.atan2(offset.x, offset.z);
    offset.set(
      Math.sin(clampedPolar) * Math.sin(azimuth) * radius,
      Math.cos(clampedPolar) * radius,
      Math.sin(clampedPolar) * Math.cos(azimuth) * radius,
    );
    camera.position.copy(controls.target.clone().add(offset));
  }

  function handleControlsChange(): void {
    clampCameraPolarAngle();
    smoothCameraUntil = Math.max(smoothCameraUntil, performance.now() + 180);
    updateZoomFromCamera();
  }

  function moveCameraTo(position: Vector3, target: Vector3, duration = 520): void {
    if (!camera || !controls) return;
    const now = performance.now();
    if (cameraTween) updateCameraTween(now);
    if (duration <= 0) {
      cameraTween = null;
      camera.position.copy(position);
      controls.target.copy(target);
      controls.update();
      updateZoomFromCamera();
      return;
    }
    smoothCameraUntil = Math.max(smoothCameraUntil, now + duration + 180);
    cameraTween = {
      fromPosition: camera.position.clone(),
      toPosition: position,
      fromTarget: controls.target.clone(),
      toTarget: target,
      startedAt: now,
      duration,
    };
  }

  function zoomBy(scale: number): void {
    if (!camera || !controls) return;
    if (cameraTween) updateCameraTween(performance.now());
    const offset = camera.position.clone().sub(controls.target).multiplyScalar(scale);
    offset.setLength(clamp(offset.length(), controls.minDistance, controls.maxDistance));
    moveCameraTo(controls.target.clone().add(offset), controls.target.clone(), 220);
  }

  function zoomIn(): void {
    zoomBy(0.72);
  }

  function zoomOut(): void {
    zoomBy(1.32);
  }

  function fitView(duration = 520): void {
    const radius = environmentRadius();
    updateCameraClipPlanes(radius);
    moveCameraTo(isometricCameraPosition(radius), isometricCameraTarget(), duration);
  }

  function resetView(): void {
    setSelectedNode(null);
    setHoveredNode(null);
    updateVisuals();
    fitView();
  }

  function locateNode(filePath: string): void {
    const runtime = runtimeNodes.get(filePath);
    if (!runtime) return;
    const now = performance.now();
    if (cameraTween) updateCameraTween(now);
    setSelectedNode(filePath);
    setHoveredNode(null);
    runtime.clickPulseUntil = now + 780;
    updateVisuals();

    const target = runtime.position.clone().add(new Vector3(0, 18 * runtime.size, 0));
    const offset =
      camera && controls
        ? camera.position.clone().sub(controls.target)
        : isometricCameraPosition(environmentRadius()).sub(isometricCameraTarget());
    if (controls)
      offset.setLength(clamp(offset.length(), controls.minDistance, controls.maxDistance));
    moveCameraTo(target.clone().add(offset), target, 560);
  }

  function locateCurrent(): void {
    const fp = currentFilePath();
    if (fp) locateNode(fp);
  }

  function pickNode(event: PointerEvent): VoxelRuntimeNode | null {
    if (!hostEl || !camera) return null;
    const rect = hostEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickableMeshes, false);
    const instanceId = hits[0]?.instanceId;
    return typeof instanceId === "number" ? (runtimeNodeList[instanceId] ?? null) : null;
  }

  function handlePointerMove(event: PointerEvent): void {
    const now = performance.now();
    if (now - lastPointerPickAt < 70) return;
    lastPointerPickAt = now;
    const next = pickNode(event);
    if (hoveredNode()?.node.filePath !== next?.node.filePath) {
      setHoveredNode(next);
    }
    if (hostEl) hostEl.style.cursor = next ? "pointer" : "grab";
  }

  function handlePointerLeave(): void {
    setHoveredNode(null);
    if (hostEl) hostEl.style.cursor = "grab";
  }

  function handlePointerDown(event: PointerEvent): void {
    const now = performance.now();
    if (cameraTween) updateCameraTween(now);
    cameraTween = null;
    smoothCameraUntil = Math.max(smoothCameraUntil, now + 240);
    pointerDown = { x: event.clientX, y: event.clientY };
  }

  function handlePointerUp(event: PointerEvent): void {
    const down = pointerDown;
    pointerDown = null;
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;

    const runtime = pickNode(event);
    if (!runtime) return;
    locateNode(runtime.node.filePath);
    props.onNodeClick?.(runtime.node);
  }

  function updateVisuals(): void {
    if (!meshes) return;
    const focus = focusedFilePath();
    const connected = connectedToFocus();
    clearActiveLabels();

    const highlighted = new Set<string>();
    const hover = hoveredNode();
    const selected = selectedNode();
    const current = currentFilePath();
    const shouldRefreshFocusVisuals = lastVisualFocusPath !== selected;
    if (hover) {
      highlighted.add(hover.node.filePath);
      addNodeLabel(hover, "hover");
    }
    const selectedRuntime = selected ? runtimeNodes.get(selected) : undefined;
    if (selectedRuntime) {
      highlighted.add(selectedRuntime.node.filePath);
      addNodeLabel(selectedRuntime, "selected");
    }
    const currentRuntime = current ? runtimeNodes.get(current) : undefined;
    if (!selected && currentRuntime && !highlighted.has(currentRuntime.node.filePath)) {
      addNodeLabel(currentRuntime, "current");
    }

    const nextVisualRuntimePaths = new Set<string>();
    if (hover) nextVisualRuntimePaths.add(hover.node.filePath);
    if (selected) nextVisualRuntimePaths.add(selected);
    if (current) nextVisualRuntimePaths.add(current);
    if (shouldRefreshFocusVisuals) {
      for (const runtime of runtimeNodeList) {
        writeStationInstances(runtime);
      }
    } else {
      for (const filePath of new Set([...lastVisualRuntimePaths, ...nextVisualRuntimePaths])) {
        const runtime = runtimeNodes.get(filePath);
        if (runtime) writeStationInstances(runtime);
      }
    }
    lastVisualRuntimePaths = nextVisualRuntimePaths;
    lastVisualFocusPath = selected;

    if (highlightLinkMesh) {
      let highlightCount = 0;
      if (focus) {
        for (const runtime of runtimeLinks) {
          if (runtime.source.node.filePath !== focus && runtime.target.node.filePath !== focus) {
            continue;
          }
          const isNeighbor =
            connected.has(runtime.source.node.filePath) ||
            connected.has(runtime.target.node.filePath);
          const color = isNeighbor ? RETRO_YELLOW : RETRO_PAPER;
          tmpSource.copy(agentLinkPoint(runtime.source));
          tmpSource.y = runtime.source.position.y + 14;
          tmpTarget.copy(agentLinkPoint(runtime.target));
          tmpTarget.y = runtime.target.position.y + 14;
          highlightCount = setArcBeamInstances(
            highlightLinkMesh,
            highlightCount,
            tmpSource,
            tmpTarget,
            isCompact() ? 0.36 : 0.52,
            color,
            isCompact() ? 10 : 16,
          );
        }
      }
      highlightLinkMesh.count = highlightCount;
    }

    if (shouldRefreshFocusVisuals) {
      markOfficeMeshUpdates();
    } else {
      markAnimatedAgentMeshUpdates();
    }
    markHighlightLinkMeshUpdates();
  }

  function animationBudget(): { renderFrameMs: number; agentFrameMs: number; chunkSize: number } {
    const nodeCount = runtimeNodeList.length;
    const zoom = zoomLevel();
    if (nodeCount >= 800 || zoom < 0.45) {
      return {
        renderFrameMs: 1000 / 16,
        agentFrameMs: 1000 / 10,
        chunkSize: isCompact() ? 64 : 96,
      };
    }
    if (nodeCount >= 350 || zoom < 0.75) {
      return {
        renderFrameMs: 1000 / 20,
        agentFrameMs: 1000 / 14,
        chunkSize: isCompact() ? 96 : 160,
      };
    }
    return {
      renderFrameMs: isCompact() ? 1000 / 20 : 1000 / 24,
      agentFrameMs: isCompact() ? 1000 / 18 : 1000 / 22,
      chunkSize: isCompact() ? 140 : 260,
    };
  }

  function updateAgentAnimations(now: number): void {
    if (!meshes || runtimeNodeList.length === 0) return;
    let changed = false;
    const updated = new Set<number>();
    const budget = animationBudget();

    for (const runtime of runtimeNodeList) {
      if (runtime.clickPulseUntil <= now) continue;
      writeStationInstances(runtime, now, "motion");
      updated.add(runtime.instanceIndex);
      changed = true;
    }

    if (idleEnabled()) {
      const chunkSize = Math.min(runtimeNodeList.length, budget.chunkSize);
      for (let offset = 0; offset < chunkSize; offset += 1) {
        const runtime = runtimeNodeList[(idleCursor + offset) % runtimeNodeList.length];
        if (!runtime || updated.has(runtime.instanceIndex)) continue;
        writeStationInstances(runtime, now, "motion");
        changed = true;
      }
      idleCursor = (idleCursor + chunkSize) % runtimeNodeList.length;
    }

    if (changed) markAnimatedAgentMeshUpdates();
  }

  function updateCameraTween(now: number): void {
    if (!cameraTween || !camera || !controls) return;
    const progress = Math.min(1, (now - cameraTween.startedAt) / Math.max(1, cameraTween.duration));
    const eased = easeInOutCubic(progress);
    camera.position.lerpVectors(cameraTween.fromPosition, cameraTween.toPosition, eased);
    controls.target.lerpVectors(cameraTween.fromTarget, cameraTween.toTarget, eased);
    controls.update();
    updateZoomFromCamera();
    if (progress >= 1) cameraTween = null;
  }

  function animate(now: number): void {
    if (!renderer || !scene || !camera) return;
    const shouldSmoothCamera = cameraTween !== null || now < smoothCameraUntil;
    const budget = animationBudget();
    const targetFrameMs = shouldSmoothCamera ? 1000 / 60 : budget.renderFrameMs;
    if (lastFrameAt !== 0 && now - lastFrameAt < targetFrameMs) {
      animationFrame = requestAnimationFrame(animate);
      return;
    }
    updateEnvironmentAnimations(now);
    updateCameraTween(now);
    if (lastAgentFrameAt === 0 || now - lastAgentFrameAt >= budget.agentFrameMs) {
      updateAgentAnimations(now);
      lastAgentFrameAt = now;
    }
    controls?.update();
    renderer.render(scene, camera);
    lastFrameAt = now;
    animationFrame = requestAnimationFrame(animate);
  }

  onMount(() => {
    if (!hostEl) return;

    try {
      const rect = hostEl.getBoundingClientRect();
      scene = new Scene();
      const darkTheme = getEffectiveTheme() === "dark";
      const skyPalette = retroSkyPalette();
      scene.fog = new FogExp2(
        new Color(cssVar("--color-voxel-world-fog", darkTheme ? "#0f3150" : "#9b9586")),
        darkTheme ? 0.000014 : 0.000009,
      );

      camera = new PerspectiveCamera(
        28,
        Math.max(1, rect.width) / Math.max(1, rect.height),
        CAMERA_NEAR_PLANE,
        CAMERA_FAR_MIN,
      );
      camera.position.copy(isometricCameraPosition(420));

      renderer = new WebGLRenderer({
        alpha: false,
        antialias: !isCompact(),
        powerPreference: "high-performance",
      });
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.toneMapping = ACESFilmicToneMapping;
      renderer.toneMappingExposure = darkTheme ? 1.04 : 0.96;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isCompact() ? 1 : 1.5));
      renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height));
      renderer.setClearColor(new Color(skyPalette.bottom), 1);
      hostEl.appendChild(renderer.domElement);

      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.rotateSpeed = 0.46;
      controls.zoomSpeed = 0.72;
      controls.panSpeed = 0.58;
      controls.minDistance = 95;
      controls.maxDistance = 4_500;
      controls.minPolarAngle = CAMERA_MIN_POLAR_ANGLE;
      controls.maxPolarAngle = CAMERA_MAX_POLAR_ANGLE;
      controls.addEventListener("change", handleControlsChange);

      scene.add(new AmbientLight("#FFD28A", darkTheme ? 2.45 : 2.55));
      const hemiLight = new HemisphereLight(
        cssVar("--color-voxel-world-sky-top", darkTheme ? RETRO_BLUE : "#2a78a6"),
        cssVar("--color-voxel-world-grass-dark", darkTheme ? "#145f47" : "#2d7145"),
        darkTheme ? 1.95 : 2.05,
      );
      scene.add(hemiLight);
      const keyLight = new DirectionalLight("#FFD08A", darkTheme ? 3.7 : 3.75);
      keyLight.position.set(280, 460, 220);
      scene.add(keyLight);
      const fillLight = new DirectionalLight("#3D91B0", darkTheme ? 1.05 : 1.12);
      fillLight.position.set(-220, 240, 280);
      scene.add(fillLight);
      const rimLight = new DirectionalLight("#D4A520", darkTheme ? 1.5 : 1.16);
      rimLight.position.set(-300, 160, -340);
      scene.add(rimLight);

      cubeGeometry = new BoxGeometry(1, 1, 1);
      labelGroup = new Group();
      scene.add(labelGroup);

      rebuildGraphScene();
      fitView(0);

      hostEl.addEventListener("pointermove", handlePointerMove);
      hostEl.addEventListener("pointerleave", handlePointerLeave);
      hostEl.addEventListener("pointerdown", handlePointerDown);
      hostEl.addEventListener("pointerup", handlePointerUp);
      hostEl.style.cursor = "grab";

      resizeObs = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (!renderer || !camera) return;
          const { width, height } = entry.contentRect;
          camera.aspect = Math.max(1, width) / Math.max(1, height);
          camera.updateProjectionMatrix();
          renderer.setSize(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
        }
      });
      resizeObs.observe(hostEl);

      animationFrame = requestAnimationFrame(animate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error("[VoxelCanvas] Init failed:", error);
      setInitError(message);
    }
  });

  createEffect(
    on(
      () => {
        const state = graphState();
        return [
          state?.lastIndexedAt,
          state?.nodes.length ?? 0,
          state?.links.length ?? 0,
          state?.clusters.length ?? 0,
        ] as const;
      },
      () => {
        rebuildGraphScene();
      },
    ),
  );

  createEffect(
    on(
      () => [hoveredNode()?.node.filePath, selectedNode(), currentFilePath()] as const,
      () => updateVisuals(),
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => getEffectiveTheme(),
      () => {
        applyVoxelWorldTheme();
        createEnvironment(graphState()?.nodes ?? []);
        updateVisuals();
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (!followMode()) return;
    const fp = currentFilePath();
    if (fp) locateNode(fp);
  });

  onCleanup(() => {
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
    resizeObs?.disconnect();
    resizeObs = undefined;
    if (hostEl) {
      hostEl.removeEventListener("pointermove", handlePointerMove);
      hostEl.removeEventListener("pointerleave", handlePointerLeave);
      hostEl.removeEventListener("pointerdown", handlePointerDown);
      hostEl.removeEventListener("pointerup", handlePointerUp);
    }
    controls?.removeEventListener("change", handleControlsChange);
    controls?.dispose();
    clearGraphObjects();
    if (environmentGroup) {
      scene?.remove(environmentGroup);
      disposeObject(environmentGroup, {
        preserveGeometry: (geometry) => geometry === cubeGeometry,
      });
      environmentGroup = undefined;
    }
    if (environmentAnim.skyDome) {
      scene?.remove(environmentAnim.skyDome);
      environmentAnim.skyDome.geometry.dispose();
      disposeMaterial(environmentAnim.skyDome.material);
      environmentAnim.skyDome = undefined;
    }
    environmentAnim = { waterMaterials: [] };
    if (labelGroup) {
      scene?.remove(labelGroup);
      disposeObject(labelGroup, { preserveGeometry: (geometry) => geometry === cubeGeometry });
      labelGroup = undefined;
    }
    cubeGeometry?.dispose();
    renderer?.dispose();
    if (hostEl) {
      while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);
    }
  });

  return (
    <div
      class={`relative min-h-0 min-w-0 flex-1 overflow-hidden bg-bg-primary ${props.class ?? ""}`}
    >
      <div ref={hostEl} class="absolute inset-0" />

      <Show when={status() !== "ready" || initError()}>
        <div class="absolute inset-0 flex items-center justify-center p-6">
          <div class="max-w-sm rounded-xs border border-border/70 bg-bg-elevated/90 px-5 py-4 text-center shadow-popover backdrop-blur-sm">
            <Show when={initError()}>
              <p class="text-sm text-text-secondary">{initError()}</p>
            </Show>

            <Show when={!initError() && status() === "loading"}>
              <div class="space-y-2">
                <div class="mx-auto h-2.5 w-24 animate-pulse rounded-xs bg-element-selected" />
                <p class="text-sm text-text-secondary">{t("voxel_graph.status.indexing")}</p>
              </div>
            </Show>

            <Show when={!initError() && status() === "error"}>
              <p class="text-sm text-text-secondary">
                {store()?.state.error ?? t("voxel_graph.status.unknown_error")}
              </p>
            </Show>

            <Show when={!initError() && status() === "empty"}>
              <div class="space-y-2">
                <p class="text-sm text-text-secondary">{t("voxel_graph.status.empty")}</p>
                <p class="text-xs text-text-muted">{t("voxel_graph.status.empty_hint")}</p>
              </div>
            </Show>

            <div class="mt-4 flex items-center justify-center gap-3 text-[0.6875rem] text-text-muted">
              <span>{tf("graph.tab.metric.nodes", { count: summary().nodeCount })}</span>
              <span>{tf("graph.tab.metric.links", { count: summary().linkCount })}</span>
            </div>
          </div>
        </div>
      </Show>

      <Show when={status() === "ready"}>
        <div
          class="absolute top-3 left-3 rounded-xs border border-border/70 bg-bg-elevated/85 px-3 py-2 font-mono text-[0.6875rem] text-text-muted tabular-nums shadow-soft-2 backdrop-blur-sm"
          classList={{ "top-2 left-2 px-2 py-1 text-[0.625rem]": isCompact() }}
        >
          {tf("voxel_graph.metric.visible", {
            nodes: visibleStats().nodes,
            links: visibleStats().links,
          })}
        </div>

        <div
          class="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-xs border border-border/70 bg-bg-elevated/85 p-1 shadow-soft-2 backdrop-blur-sm"
          classList={{ "right-2! bottom-2! gap-0! p-0.5!": isCompact() }}
        >
          <CtrlBtn title={t("graph.ctrl.zoom_in")} onClick={zoomIn} compact={isCompact()}>
            <ZoomInIcon />
          </CtrlBtn>
          <CtrlBtn title={t("graph.ctrl.zoom_out")} onClick={zoomOut} compact={isCompact()}>
            <ZoomOutIcon />
          </CtrlBtn>
          <CtrlBtn title={t("graph.ctrl.fit_all")} onClick={() => fitView()} compact={isCompact()}>
            <FitViewIcon />
          </CtrlBtn>
          <CtrlBtn
            title={followMode() ? t("graph.ctrl.stop_following") : t("graph.ctrl.follow_current")}
            onClick={() => {
              const next = !followMode();
              setFollowMode(next);
              if (next) locateCurrent();
            }}
            active={followMode()}
            compact={isCompact()}
          >
            <LocateIcon />
          </CtrlBtn>
          <CtrlBtn title={t("graph.ctrl.reset_view")} onClick={resetView} compact={isCompact()}>
            <ResetViewIcon />
          </CtrlBtn>
          <div class="mx-1 h-4 w-px bg-border" />
          <span
            class="min-w-11 px-1 text-center font-mono text-[0.6875rem] text-text-muted tabular-nums"
            classList={{ "min-w-8 text-[0.625rem]": isCompact() }}
          >
            {Math.round(zoomLevel() * 100)}%
          </span>
        </div>
      </Show>

      <Show when={hoveredNode()}>
        {(runtime) => (
          <div class="pointer-events-none absolute bottom-14 left-3 max-w-72 rounded-xs border border-border/70 bg-bg-elevated/90 px-3 py-2 shadow-popover backdrop-blur-sm">
            <p
              class="truncate text-[0.8125rem] font-medium"
              style={{ color: nodeColor(runtime().node) }}
            >
              {shortLabel(runtime().node.name)}
            </p>
            <div class="mt-1 flex flex-wrap items-center gap-2 text-[0.6875rem] text-text-muted">
              <span>
                {runtime().node.linkCount === 1
                  ? tf("graph.tooltip.connection_one", { count: runtime().node.linkCount })
                  : tf("graph.tooltip.connection_other", { count: runtime().node.linkCount })}
              </span>
              <Show when={connectedToFocus().size > 0}>
                <span>{tf("voxel_graph.tooltip.nearby", { count: connectedToFocus().size })}</span>
              </Show>
              <Show when={runtime().node.isOrphan}>
                <span class="rounded-xs bg-bg-secondary px-1.5 py-0.5 text-[0.625rem] text-text-muted">
                  {t("graph.badge.unlinked")}
                </span>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

function CtrlBtn(props: {
  title: string;
  onClick: () => void;
  active?: boolean;
  compact?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      class="flex cursor-pointer items-center justify-center rounded-xs border-none bg-transparent text-[0.75rem] text-text-muted transition-colors duration-100 hover:bg-ghost-hover hover:text-text-primary"
      classList={{
        "size-7": !props.compact,
        "size-6": props.compact,
        "bg-ghost-active! text-text-accent!": props.active,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
