/** Twenty-five harbor residents, with shared geometry and independent articulated rigs. */
import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshLambertMaterial,
  type Object3D,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { residentProfile } from "./resident_profile";
import type { WorldPalette } from "./palette";

export const HARBOR_RESIDENTS = [
  "Postmaster",
  "Letter runner",
  "Parcel courier",
  "Air mail clerk",
  "Harbor messenger",
  "Archivist",
  "Bookbinder",
  "Map keeper",
  "Research librarian",
  "Story collector",
  "Captain",
  "Deckhand",
  "Lighthouse keeper",
  "Ferry pilot",
  "Harbor master",
  "Florist",
  "Orchard keeper",
  "Seed collector",
  "Botanist",
  "Garden tender",
  "Carpenter",
  "Potter",
  "Watchmaker",
  "Painter",
  "Baker",
] as const;
const COATS = ["#487e86", "#d58b72", "#d3b468", "#819d84", "#7795b5"];
const CREAM = "#efe6ce",
  INK = "#374949",
  LEATHER = "#806047";
interface Template {
  root: Group;
  height: number;
}
let templates: (Template | undefined)[] = [];
let material: MeshLambertMaterial | null = null;

/** Each articulated section is one vertex-colored mesh, regardless of detail. */
class Section {
  private pieces: BufferGeometry[] = [];
  add(
    geometry: BufferGeometry,
    color: string,
    x: number,
    y: number,
    z: number,
    sx = 1,
    sy = 1,
    sz = 1,
    rx = 0,
    ry = 0,
    rz = 0,
  ): void {
    let g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    g.scale(sx, sy, sz);
    g.rotateX(rx);
    g.rotateY(ry);
    g.rotateZ(rz);
    g.translate(x, y, z);
    const c = new Color(color),
      colors = new Float32Array(g.getAttribute("position").count * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = c.r;
      colors[i + 1] = c.g;
      colors[i + 2] = c.b;
    }
    g.setAttribute("color", new Float32BufferAttribute(colors, 3));
    this.pieces.push(g);
  }
  box(
    c: string,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    rz = 0,
  ): void {
    this.add(new BoxGeometry(1, 1, 1), c, x, y, z, sx, sy, sz, 0, 0, rz);
  }
  finish(name: string): Mesh {
    const geometry = mergeGeometries(this.pieces);
    for (const g of this.pieces) g.dispose();
    const mesh = new Mesh(geometry, material!);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = name !== "face" && name !== "eyes";
    return mesh;
  }
}
/** A different working object for every resident, merged into the animated hand. */
function addResidentProp(hand: Section, index: number): void {
  // Local hand space: forward of the palm. Helpers keep small pixel details on-grid.
  const box = (c: string, x: number, y: number, z: number, w: number, h: number, d: number) =>
    hand.box(c, x, y - 0.45, z + 0.42, w, h, d);
  const paper = (color = CREAM) => {
    box(color, 0, 0, 0, 0.625, 0.75, 0.125);
    for (let i = 0; i < 3; i++) box("#a3ad91", -0.06, 0.16 - i * 0.16, 0.069, 0.375, 0.035, 0.02);
  };
  const book = (color: string) => {
    box(color, 0, 0, 0, 0.625, 0.875, 0.25);
    box(CREAM, 0.04, 0, 0.135, 0.48, 0.7, 0.035);
    box("#c5aa72", -0.23, 0, 0.15, 0.125, 0.8, 0.045);
  };
  const handle = () => box(LEATHER, 0, 0, 0, 0.125, 0.875, 0.125);
  const flower = (x: number, color: string, height = 0.6) => {
    box("#678a4d", x, height / 2, 0, 0.0625, height, 0.0625);
    box("#88a265", x - 0.08, height * 0.4, 0, 0.25, 0.1, 0.15);
    box(color, x, height, 0, 0.3125, 0.125, 0.3125);
    box("#e4c76f", x, height + 0.08, 0, 0.125, 0.1, 0.125);
  };
  switch (index) {
    case 0: // Sealed envelope.
      box(CREAM, 0, 0, 0, 0.7, 0.4375, 0.125);
      box("#c47759", 0.23, 0.1, 0.072, 0.125, 0.125, 0.025);
      for (let i = 0; i < 4; i++)
        box(
          "#bda886",
          -0.1875 + i * 0.125,
          0.1 - Math.min(i, 3 - i) * 0.08,
          0.07,
          0.125,
          0.04,
          0.02,
        );
      break;
    case 1: // Rolled route sheet.
      box(CREAM, 0, 0, 0, 0.375, 0.875, 0.375);
      box("#c46e56", 0, 0, 0, 0.4, 0.125, 0.4);
      box("#bbaa83", 0, 0.445, 0, 0.2, 0.025, 0.2);
      break;
    case 2: // Tied parcel.
      box("#b98e59", 0, 0, 0, 0.875, 0.625, 0.625);
      box(CREAM, 0, 0, 0.32, 0.125, 0.625, 0.025);
      box(CREAM, 0, 0.32, 0, 0.9, 0.025, 0.125);
      box("#eddbaf", -0.22, 0.1, 0.33, 0.25, 0.1875, 0.025);
      break;
    case 3: // Robot air-mail sorting tray.
      box("#607e83", 0, 0, 0, 0.875, 0.25, 0.625);
      for (let i = 0; i < 3; i++)
        box(i % 2 ? "#dec58e" : CREAM, 0, 0.17 + i * 0.1, 0, 0.7, 0.08, 0.45);
      break;
    case 4: // Messenger signal pennant.
      handle();
      box("#d69366", 0.25, 0.38, 0, 0.625, 0.375, 0.08);
      box(CREAM, 0.22, 0.38, 0.045, 0.1875, 0.125, 0.025);
      break;
    case 5:
      book("#6b8065");
      break;
    case 6: // Bound book stack.
      for (let i = 0; i < 3; i++) {
        box(["#a47059", "#6e8794", "#83915d"][i], 0, i * 0.2 - 0.2, 0, 0.75, 0.1875, 0.5);
        box(CREAM, 0, i * 0.2 - 0.2, 0.255, 0.625, 0.1, 0.025);
      }
      break;
    case 7: // Folded map with colored land and river pixels.
      paper();
      for (let i = 0; i < 4; i++)
        box("#6b9ea3", -0.1875 + (i % 2) * 0.125, 0.25 - i * 0.16, 0.09, 0.125, 0.18, 0.025);
      box("#9db176", 0.125, 0, 0.09, 0.25, 0.25, 0.025);
      break;
    case 8: // Square magnifier.
      handle();
      box("#9fbfc1", 0, 0.5, 0, 0.375, 0.375, 0.1);
      for (const side of [-1, 1]) {
        box("#bca46b", side * 0.25, 0.5, 0, 0.125, 0.625, 0.15);
        box("#bca46b", 0, 0.5 + side * 0.25, 0, 0.625, 0.125, 0.15);
      }
      break;
    case 9:
      book("#aa7463");
      box("#d6ae66", 0.22, 0.12, 0.2, 0.0625, 0.75, 0.0625);
      break;
    case 10: // Brass telescope.
      box("#ba9257", 0, 0, 0, 0.25, 0.875, 0.25);
      for (const side of [-1, 1]) box(INK, 0, side * 0.4, 0, 0.375, 0.125, 0.375);
      break;
    case 11: // Coiled rope, stepped square loops.
      for (let i = 0; i < 3; i++) {
        for (const side of [-1, 1]) {
          box("#c1a174", side * 0.25, 0, i * 0.1, 0.125, 0.625, 0.1);
          box("#d0b484", 0, side * 0.25, i * 0.1, 0.5, 0.125, 0.1);
        }
      }
      break;
    case 12: // Lighthouse lantern.
      box("#ebcb7d", 0, 0, 0, 0.375, 0.625, 0.375);
      for (const y of [-0.375, 0.375]) box(INK, 0, y, 0, 0.625, 0.125, 0.625);
      for (const x of [-0.25, 0.25])
        for (const z of [-0.25, 0.25]) box(INK, x, 0, z, 0.075, 0.75, 0.075);
      box("#b5a379", 0, 0.56, 0, 0.375, 0.25, 0.125);
      break;
    case 13:
      paper("#d8b66f");
      box("#51818a", 0, 0.15, 0.075, 0.5, 0.125, 0.025);
      break;
    case 14: // Chart compass.
      box("#bda16b", 0, 0, 0, 0.625, 0.625, 0.2);
      box(CREAM, 0, 0, 0.11, 0.5, 0.5, 0.025);
      box("#a85e50", 0, 0.09, 0.13, 0.0625, 0.3, 0.025);
      box(INK, 0, -0.12, 0.13, 0.0625, 0.125, 0.025);
      break;
    case 15:
      box(CREAM, 0, -0.1, 0, 0.5, 0.375, 0.25);
      flower(-0.2, "#cf8091", 0.45);
      flower(0.15, "#e7b16e", 0.65);
      flower(0, "#a6bdd0", 0.8);
      break;
    case 16: // Orchard basket with apples.
      box("#b48757", 0, 0, 0, 0.75, 0.4375, 0.5);
      for (let i = 0; i < 3; i++) box("#855e3d", 0, -0.14 + i * 0.14, 0.26, 0.75, 0.035, 0.025);
      for (let i = 0; i < 3; i++)
        box(i % 2 ? "#98a858" : "#bd6951", -0.23 + i * 0.23, 0.3, 0, 0.25, 0.25, 0.3);
      break;
    case 17: // Seed packets.
      paper("#d7c395");
      box("#80915a", 0, 0, 0.08, 0.3125, 0.375, 0.025);
      break;
    case 18: // Watering can with squared spout and handle.
      box("#769c9c", 0, 0, 0, 0.625, 0.625, 0.5);
      box("#486e76", 0, 0.33, 0, 0.375, 0.05, 0.3);
      box("#769c9c", 0.44, 0.1, 0, 0.375, 0.125, 0.125);
      box("#b3c4b0", 0.64, 0.22, 0, 0.125, 0.375, 0.25);
      for (const y of [-0.2, 0.2]) box("#769c9c", -0.44, y, 0, 0.25, 0.125, 0.125);
      box("#769c9c", -0.56, 0, 0, 0.125, 0.5, 0.125);
      break;
    case 19:
      box("#ae7654", 0, -0.1, 0, 0.5, 0.375, 0.5);
      flower(0, "#8ba65e", 0.5);
      box("#648b56", 0, 0.36, 0, 0.5, 0.25, 0.375);
      break;
    case 20:
      handle();
      box("#8e9892", 0.125, 0.44, 0, 0.625, 0.25, 0.25);
      break;
    case 21: // Stepped pottery vase.
      box("#b87959", 0, -0.08, 0, 0.625, 0.5, 0.5);
      box("#c68c65", 0, 0.22, 0, 0.375, 0.125, 0.375);
      box("#b87959", 0, 0.36, 0, 0.25, 0.25, 0.25);
      box("#714c38", 0, 0.495, 0, 0.16, 0.025, 0.16);
      break;
    case 22:
      box("#aa8d5a", 0, 0, 0, 0.75, 0.875, 0.25);
      box(CREAM, 0, 0.1, 0.135, 0.625, 0.625, 0.025);
      box(INK, 0, 0.2, 0.16, 0.05, 0.25, 0.025);
      box(INK, 0.09, 0.1, 0.16, 0.22, 0.05, 0.025);
      box("#d5b778", 0, -0.3, 0.15, 0.125, 0.125, 0.025);
      break;
    case 23:
      handle();
      box("#acb6a4", 0, 0.38, 0, 0.3125, 0.25, 0.15);
      box("#cb8365", 0, 0.6, 0, 0.3125, 0.25, 0.15);
      break;
    case 24:
      box("#b67d44", 0, 0, 0, 0.75, 0.375, 0.375);
      for (let i = 0; i < 3; i++) box("#e2b777", -0.22 + i * 0.22, 0.2, 0, 0.0625, 0.035, 0.25);
      break;
  }
}

/** Original voxel skins: an eight-pixel head, twelve-pixel body and block limbs. */
function makeTemplate(index: number): Template {
  const role = Math.floor(index / 5),
    look = index % 5;
  const profile = residentProfile(index);
  const coat = COATS[(look + role) % 5],
    skin = profile.skin,
    hair = profile.hairColor;
  const shade = (color: string, amount: number) =>
    `#${new Color(color).multiplyScalar(amount).getHexString()}`;
  const darkCoat = shade(coat, 0.7),
    lightCoat = shade(coat, 1.16);
  const root = new Group();
  root.name = HARBOR_RESIDENTS[index];
  const torso = new Section();
  torso.box(coat, 0, 2.25, 0, 1, 1.5, 0.5);
  // Pixel-sized woven patches are merged into the body, including the back.
  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 8; col++) {
      const pattern = (row * 17 + col * 7 + index * 11) % 13;
      if (pattern > 2) continue;
      for (const side of [-1, 1])
        torso.box(
          pattern === 0 ? lightCoat : darkCoat,
          (col - 3.5) / 8,
          1.6875 + row / 8,
          side * 0.253,
          0.125,
          0.125,
          0.008,
        );
    }
  }
  torso.box(CREAM, -0.1875, 2.875, 0.26, 0.25, 0.25, 0.025);
  torso.box(CREAM, 0.1875, 2.875, 0.26, 0.25, 0.25, 0.025);
  torso.box(darkCoat, 0, 2.625, 0.27, 0.125, 0.375, 0.03);
  torso.box(LEATHER, 0, 1.625, 0, 1.02, 0.125, 0.52);
  torso.box("#dfbe6b", 0, 1.625, 0.273, 0.1875, 0.125, 0.03);
  for (let y = 1.9375; y < 2.7; y += 0.25) torso.box("#e4cd92", 0, y, 0.27, 0.0625, 0.0625, 0.035);
  // Each guild has a readable silhouette and a different garment construction.
  if (role === 0) {
    for (let i = 0; i < 10; i++)
      torso.box(LEATHER, -0.4375 + i * 0.0875, 2.875 - i * 0.125, 0.28, 0.125, 0.1875, 0.055);
    torso.box("#aa7a4d", 0.54, 1.68, -0.08, 0.3, 0.5, 0.6);
    torso.box(LEATHER, 0.55, 1.86, -0.08, 0.32, 0.125, 0.62);
    torso.box("#dec78b", 0.55, 1.7, 0.235, 0.125, 0.125, 0.03);
    torso.box("#d6b16a", -0.28, 2.55, 0.29, 0.25, 0.125, 0.04);
  } else if (role === 1) {
    torso.box("#774e48", 0, 2.125, 0.267, 0.25, 1, 0.03);
    torso.box(CREAM, 0.3125, 2.35, 0.28, 0.25, 0.25, 0.03);
    torso.box(LEATHER, 0, 2.125, -0.4, 0.75, 0.875, 0.3);
    torso.box("#b39465", 0, 2.5, -0.42, 0.77, 0.125, 0.34);
  } else if (role === 2) {
    for (let i = 0; i < 4; i++) torso.box(CREAM, 0, 1.875 + i * 0.25, 0.26, 1.01, 0.125, 0.025);
    torso.box("#355366", 0, 2.75, -0.27, 1.02, 0.5, 0.05);
    torso.box("#d9ae66", 0.32, 2.72, 0.29, 0.125, 0.125, 0.04);
  } else {
    const apron = role === 3 ? "#d8c799" : look === 4 ? CREAM : "#ae7f55";
    torso.box(apron, 0, 2.125, 0.285, 0.75, 1, 0.075);
    torso.box(apron, -0.3125, 2.6875, 0.275, 0.125, 0.375, 0.04);
    torso.box(apron, 0.3125, 2.6875, 0.275, 0.125, 0.375, 0.04);
    torso.box(shade(apron, 0.75), 0, 2.0625, 0.33, 0.5, 0.375, 0.035);
    torso.box(apron, 0, 2.2, 0.355, 0.5, 0.0625, 0.035);
    if (role === 4)
      for (let i = 0; i < 3; i++)
        torso.box(
          ["#e1aa69", "#658b98", "#ab665e"][i],
          -0.18 + i * 0.17,
          2.12,
          0.357,
          0.0625,
          0.25,
          0.04,
        );
  }
  if (profile.robot) {
    torso.box("#344e55", 0, 2.4, 0.35, 0.625, 0.625, 0.125);
    for (let i = 0; i < 3; i++)
      torso.box(
        i === 0 ? "#e8bd68" : "#95d8d0",
        -0.1875 + i * 0.1875,
        2.5,
        0.423,
        0.125,
        0.125,
        0.03,
      );
    for (let i = 0; i < 3; i++)
      torso.box("#93a49e", 0, 2.28 - i * 0.0625, 0.423, 0.375, 0.025, 0.03);
  } else if (look === 1 || look === 4) {
    torso.box(
      ["#c46552", "#c9a154", "#6f829e", "#a47283", "#7c9256"][role],
      0,
      2.84,
      0.31,
      1.05,
      0.1875,
      0.11,
    );
    torso.box(
      ["#c46552", "#c9a154", "#6f829e", "#a47283", "#7c9256"][role],
      -0.25,
      2.53,
      0.33,
      0.25,
      0.5,
      0.08,
    );
  }
  const bodyMesh = torso.finish("torso");
  bodyMesh.geometry
    .translate(0, -1.5, 0)
    .scale(profile.width, profile.torso, profile.depth)
    .translate(0, 1.5 * profile.legs, 0);
  root.add(bodyMesh);

  const headGroup = new Group();
  headGroup.name = "head";
  headGroup.position.y = 1.5 * (profile.legs + profile.torso);
  headGroup.scale.setScalar(profile.head);
  const head = new Section();
  head.box(skin, 0, 0.5, 0, 1, 1, 1);
  if (profile.robot) {
    head.box("#344e55", 0, 0.53, 0.51, 0.875, 0.625, 0.06);
    head.box("#d4c5a1", 0, 1.025, 0, 1.125, 0.18, 1.125);
    head.box("#718889", 0, 1.15, 0, 0.125, 0.375, 0.125);
    head.box(index === 12 ? "#e9bb67" : "#8ee3d7", 0, 1.375, 0, 0.25, 0.125, 0.25);
    for (const side of [-1, 1]) {
      head.box("#47646b", side * 0.55, 0.5, 0, 0.125, 0.375, 0.375);
      head.box("#dac297", side * 0.625, 0.5, 0, 0.0625, 0.1875, 0.1875);
    }
    head.box("#abc5bf", 0, 0.25, 0.55, 0.375, 0.0625, 0.025);
  } else {
    // The hair cap must sit above the skin cube, not share its y=1 face.
    const openCrown = ["none", "bandana", "headphones"].includes(profile.headwear);
    head.box(hair, 0, 1.015, 0, 1.055, 0.15, 1.055);
    head.box(hair, 0, 0.625, -0.45, 1.025, 0.625, 0.125);
    for (const side of [-1, 1]) {
      head.box(hair, side * 0.45, 0.6875, 0, 0.125, 0.5, 1.025);
      head.box(shade(skin, 0.87), side * 0.3125, 0.3125, 0.505, 0.125, 0.125, 0.018);
      head.box(hair, side * 0.25, 0.6875, 0.511, 0.25, 0.0625, 0.025);
    }
    for (let i = 0; i < 8; i++) {
      const fringe = 1 + ((i + look * 2) % 3 === 0 ? 1 : 0);
      head.box(
        i % 3 === 0 ? shade(hair, 1.2) : hair,
        (i - 3.5) / 8,
        1 - fringe / 16,
        0.513,
        0.125,
        fringe / 8,
        0.028,
      );
    }
    head.box(shade(skin, 0.83), 0, 0.375, 0.53, 0.25, 0.125, 0.08);
    head.box("#885444", 0, 0.1875, 0.51, 0.25, 0.0625, 0.025);
    if (profile.hairStyle === "braids")
      for (const side of [-1, 1]) {
        for (let j = 0; j < 4; j++)
          head.box(
            j % 2 ? shade(hair, 1.2) : hair,
            side * (0.49 + (j % 2) * 0.06),
            0.3 - j * 0.18,
            -0.3,
            0.25,
            0.25,
            0.25,
          );
        head.box(coat, side * 0.52, -0.27, -0.3, 0.26, 0.125, 0.26);
      }
    if (profile.hairStyle === "bob" || profile.hairStyle === "long") {
      const length = profile.hairStyle === "long" ? 1.25 : 0.75;
      head.box(hair, 0, 0.85 - length / 2, -0.48, 1.08, length, 0.25);
      for (const side of [-1, 1])
        head.box(hair, side * 0.47, 0.65 - length / 2, -0.1, 0.2, length, 0.65);
    }
    if (profile.hairStyle === "bun") {
      head.box(hair, 0, 0.8, -0.64, 0.625, 0.625, 0.375);
      head.box(coat, 0, 0.85, -0.84, 0.625, 0.125, 0.06);
    }
    if (openCrown && profile.hairStyle === "mohawk") {
      for (let j = 0; j < 4; j++)
        head.box(hair, 0, 1.04 + (j % 2) * 0.08, -0.375 + j * 0.25, 0.25, 0.375, 0.25);
    }
    if (openCrown && profile.hairStyle === "curls")
      for (let x = 0; x < 4; x++)
        for (let z = 0; z < 4; z++)
          head.box(
            (x + z) % 3 ? hair : shade(hair, 1.18),
            (x - 1.5) * 0.3,
            1 + ((x + z) % 2) * 0.1,
            (z - 1.5) * 0.3,
            0.29,
            0.375,
            0.29,
          );
    if (look === 2 || index === 10) {
      head.box(hair, 0, 0.0625, 0.512, 0.5, 0.125, 0.025);
      for (const side of [-1, 1]) head.box(hair, side * 0.3125, 0.1875, 0.512, 0.125, 0.375, 0.025);
    }
    if (role === 1 || look === 4) {
      for (const side of [-1, 1])
        for (const edge of [-1, 1]) {
          head.box(INK, side * 0.25, 0.5 + edge * 0.14, 0.535, 0.375, 0.045, 0.025);
          head.box(INK, side * 0.25 + edge * 0.17, 0.5, 0.535, 0.045, 0.3, 0.025);
        }
      head.box(INK, 0, 0.54, 0.54, 0.125, 0.045, 0.025);
    }
    const hat = profile.headwear;
    if (hat === "cap" || hat === "captain") {
      head.box(hat === "captain" ? CREAM : coat, 0, 1.27, 0, 1.16, 0.3, 1.16);
      head.box(darkCoat, 0, 1.08, 0, 1.2, 0.18, 1.2);
      head.box(darkCoat, 0, 1.025, 0.66, 1, 0.18, 0.5);
      head.box("#e5be6b", 0, 1.28, 0.615, 0.16, 0.16, 0.09);
    } else if (hat === "sunhat") {
      head.box("#d8bb78", 0, 1.065, 0, 1.625, 0.19, 1.625);
      head.box("#ceb06f", 0, 1.32, 0, 1.05, 0.4, 1.05);
      head.box(coat, 0, 1.18, 0, 1.12, 0.16, 1.12);
    } else if (hat === "chef") {
      head.box(CREAM, 0, 1.14, 0, 1.16, 0.27, 1.16);
      head.box("#fff0d6", 0, 1.27, 0, 1.25, 0.25, 1.125);
      head.box(CREAM, -0.25, 1.42, 0, 0.5, 0.125, 1);
    } else if (hat === "beret" || hat === "beanie") {
      head.box(coat, 0, 1.14, 0, 1.18, 0.27, 1.18);
      head.box(lightCoat, hat === "beret" ? -0.1875 : 0, 1.33, -0.0625, 0.875, 0.18, 1);
      if (hat === "beanie") head.box(CREAM, 0, 1.5, 0, 0.25, 0.25, 0.25);
    } else if (hat === "hood" || hat === "headwrap") {
      head.box(coat, 0, 1.02, -0.06, 1.2, 0.25, 1.2);
      head.box(coat, 0, 0.5, -0.57, 1.2, 0.875, 0.2);
      for (const side of [-1, 1]) head.box(coat, side * 0.56, 0.55, -0.05, 0.18, 0.875, 1);
      if (hat === "headwrap") {
        head.box(lightCoat, 0.18, 1.23, -0.1, 0.875, 0.25, 0.875);
        head.box(coat, 0.49, -0.05, -0.45, 0.25, 0.625, 0.25);
      }
    } else if (hat === "bandana") {
      head.box(coat, 0, 0.83, 0, 1.07, 0.25, 1.07);
      head.box(lightCoat, 0.52, 0.7, -0.42, 0.375, 0.25, 0.25);
    } else if (hat === "headphones") {
      head.box(INK, 0, 1.07, 0, 1.24, 0.125, 0.25);
      for (const side of [-1, 1]) {
        head.box(INK, side * 0.57, 0.75, 0, 0.125, 0.625, 0.25);
        head.box("#d6b26f", side * 0.65, 0.5, 0, 0.25, 0.375, 0.375);
      }
    }
  }
  const eyes = new Section();
  for (const side of [-1, 1]) {
    eyes.box(
      profile.robot ? "#92ead8" : CREAM,
      side * 0.25,
      0,
      profile.robot ? 0.553 : 0.515,
      0.25,
      0.125,
      0.022,
    );
    if (!profile.robot) eyes.box(INK, side * 0.1875, 0, 0.53, 0.125, 0.125, 0.02);
  }
  const eyeMesh = eyes.finish("eyes");
  eyeMesh.position.y = 0.5;
  headGroup.add(eyeMesh, head.finish("face"));
  root.add(headGroup);

  for (const side of [-1, 1]) {
    const leg = new Group();
    leg.name = side === -1 ? "leg-left" : "leg-right";
    leg.position.set(side * 0.25 * profile.width, 1.5 * profile.legs, 0);
    leg.scale.set(profile.width, profile.legs, profile.depth);
    const l = new Section();
    l.box(role === 2 ? "#3b5367" : "#56666b", 0, -0.625, 0, 0.49, 1.25, 0.5);
    l.box("#405155", 0, -0.875, 0.253, 0.375, 0.125, 0.015);
    l.box("#68503c", 0, -1.3125, 0.0625, 0.49, 0.375, 0.625);
    l.box("#3f3933", 0, -1.4375, 0.0625, 0.5, 0.125, 0.64);
    l.box("#ac9269", 0, -1.25, 0.383, 0.25, 0.0625, 0.025);
    leg.add(l.finish("leg"));
    root.add(leg);
    const arm = new Group();
    arm.name = side === -1 ? "arm-left" : "arm-right";
    arm.position.set(
      side * (profile.width * 0.5 + 0.3),
      1.5 * profile.legs + 1.44 * profile.torso,
      0,
    );
    arm.scale.set(1, profile.torso, profile.depth);
    const upper = new Section();
    upper.box(coat, 0, -0.315, 0, 0.5, 0.75, 0.5);
    upper.box(darkCoat, side * 0.253, -0.1875, 0, 0.015, 0.125, 0.375);
    upper.box(role === 2 ? "#d8bc75" : lightCoat, side * 0.26, -0.375, 0, 0.02, 0.125, 0.25);
    arm.add(upper.finish("sleeve"));
    const elbow = new Group();
    elbow.name = side === -1 ? "elbow-left" : "elbow-right";
    elbow.position.y = -0.69;
    const hand = new Section();
    hand.box(coat, 0, -0.1875, 0, 0.5, 0.375, 0.5);
    hand.box(CREAM, 0, -0.375, 0, 0.51, 0.125, 0.51);
    hand.box(skin, 0, -0.5625, 0, 0.5, 0.25, 0.5);
    hand.box(shade(skin, 0.86), 0, -0.5625, 0.255, 0.25, 0.125, 0.015);
    if (side === -1) addResidentProp(hand, index);
    elbow.add(hand.finish("forearm"));
    arm.add(elbow);
    root.add(arm);
  }
  return { root, height: new Box3().setFromObject(root).max.y };
}
export function loadCharacterModel(_palette: WorldPalette): void {
  if (material) return;
  material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  // Build a shared template only when a visible resident needs that variant.
}
export function onCharacterModel(cb: () => void): () => void {
  cb();
  return () => {};
}
export function characterVariantCount(): number {
  return HARBOR_RESIDENTS.length;
}
export type CharacterAction = "idle" | "wave" | "read" | "work" | "handoff" | "celebrate" | "carry";
export interface CharacterInstance {
  setAction(action: CharacterAction): void;
  root: Object3D;
  footOffset: number;
  setMoving(moving: boolean): void;
  update(deltaSeconds: number): void;
  dispose(): void;
}
export function makeCharacterInstance(
  variant: number,
  targetHeight: number,
): CharacterInstance | null {
  if (!material) return null;
  const profile = residentProfile(variant);
  const index = ((variant % 25) + 25) % 25,
    entry = templates[index] ?? (templates[index] = makeTemplate(index)),
    rig = entry.root.clone(true),
    root = new Group();
  root.name = entry.root.name;
  root.add(rig);
  root.scale.setScalar(targetHeight / entry.height);
  const leftLeg = root.getObjectByName("leg-left")!,
    rightLeg = root.getObjectByName("leg-right")!;
  const leftArm = root.getObjectByName("arm-left")!,
    rightArm = root.getObjectByName("arm-right")!,
    head = root.getObjectByName("head")!;
  const leftElbow = root.getObjectByName("elbow-left")!,
    rightElbow = root.getObjectByName("elbow-right")!,
    eyes = root.getObjectByName("eyes")!;
  // Positive Z lifts this +X shoulder away from the face. Compute the
  // safe lift from each head/hat silhouette and the two segment reach.
  root.updateMatrixWorld(true);
  const headEdge = new Box3().setFromObject(head).max.x / root.scale.x;
  const reach = 1.38 * profile.torso;
  const clearance = Math.max(0.35, headEdge + 0.42 - rightArm.position.x);
  const waveLift = Math.min(2.12, Math.PI - Math.asin(Math.min(0.95, clearance / reach)));
  let waveWeight = 0;
  let moving = false,
    phase = index * 0.7,
    weight = 0,
    action: CharacterAction = "idle",
    time = index * 0.31;
  return {
    root,
    footOffset: 0,
    setMoving: (v) => {
      moving = v;
    },
    setAction: (value) => {
      action = value;
    },
    update: (delta) => {
      time += delta;
      phase += delta * (moving ? 7 * profile.walkTempo : 1.5);
      weight += (Number(moving) - weight) * Math.min(1, delta * 9);
      const gait = Math.sin(phase) * weight * profile.stride;
      leftLeg.rotation.x = gait * 0.48;
      rightLeg.rotation.x = -gait * 0.48;
      leftArm.rotation.set(-0.08 - gait * 0.42, 0, 0);
      rightArm.rotation.set(gait * 0.48, 0, 0);
      leftElbow.rotation.x = 0;
      rightElbow.rotation.set(0, 0, 0);
      head.rotation.set(0, Math.sin(time * 0.7) * 0.065, Math.sin(time * 0.4) * 0.015);
      const blink = time % (3.2 + index * 0.047);
      eyes.scale.y = blink < 0.12 ? 0.08 : 1;
      const waving = action === "wave" || action === "celebrate";
      waveWeight = Math.max(0, Math.min(1, waveWeight + delta * (waving ? 3.5 : -4)));
      if (waveWeight > 0) {
        const blend = waveWeight * waveWeight * (3 - 2 * waveWeight);
        rightArm.rotation.z = waveLift * blend;
        rightArm.rotation.x *= 1 - blend;
        // A small forearm wave stays lateral; it never sweeps through the face.
        rightElbow.rotation.x = -0.35 * blend;
        rightElbow.rotation.z = Math.sin(time * 7) * 0.12 * blend;
        head.rotation.x = -0.12 * blend;
        head.rotation.y *= 1 - blend;
        head.rotation.z = 0;
      }
      if (action === "read") {
        leftArm.rotation.x = -0.65;
        rightArm.rotation.x = -0.55;
        leftElbow.rotation.x = -0.9;
        rightElbow.rotation.x = -0.95;
        head.rotation.x = 0.18;
      }
      if (action === "handoff") {
        leftArm.rotation.x = -1;
        leftElbow.rotation.x = -0.35;
        rightArm.rotation.x = -0.9;
        rightElbow.rotation.x = -0.45;
        head.rotation.x = Math.sin(time * 4) * 0.07;
      }
      if (action === "work") {
        rightArm.rotation.x = -0.5 + Math.sin(time * 3) * 0.25;
        rightElbow.rotation.x = -0.7;
        head.rotation.x = 0.12;
      }
      if (action === "carry") {
        leftArm.rotation.x = -0.65;
        leftElbow.rotation.x = -0.8;
      }
      rig.position.y = Math.abs(Math.sin(phase)) * weight * 0.055 + Math.sin(time * 2) * 0.009;
      if (action === "celebrate") rig.position.y += Math.max(0, Math.sin(time * 5)) * 0.1;
    },
    dispose: () => root.clear(),
  };
}

export function disposeCharacterModels(): void {
  for (const t of templates)
    t?.root.traverse((o) => {
      if ((o as Mesh).isMesh) (o as Mesh).geometry.dispose();
    });
  material?.dispose();
  material = null;
  templates = [];
}
export const CHARACTER_FORWARD_OFFSET = 0;
