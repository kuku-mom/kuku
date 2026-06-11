// ── Agent World Palettes ──
//
// Two fully designed moods: the light app theme renders the medieval world at
// golden daytime, the dark theme renders the same world at night. Every
// generator reads colors from here only, so the whole world re-skins on theme
// change.

export type WorldMood = "day" | "night";

export interface WorldPalette {
  mood: WorldMood;

  // Atmosphere
  skyTop: string;
  skyHorizon: string;
  fog: string;
  fogDensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  sunColor: string;
  sunIntensity: number;
  ambient: string;
  ambientIntensity: number;

  // Celestial bodies
  orb: string; // sun / moon face
  orbGlow: string;
  cloud: string;
  cloudOpacity: number;
  star: string;

  // Water
  water: string;
  waterDeep: string;
  waterEmissive: string;

  // Terrain
  grass: string;
  grassAlt: string;
  plaza: string; // cobblestone
  plazaAlt: string;
  sand: string;
  dirt: string;
  path: string;
  bridge: string;
  bridgePost: string;

  // Nature & fields
  trunk: string;
  leaf: string;
  leafAlt: string;
  pine: string;
  rock: string;
  flowers: string[];
  soil: string;
  crop: string;

  // Buildings — medieval timber-frame & stone
  walls: string[]; // plaster
  timber: string; // dark frame beams
  stoneBase: string; // foundations, towers
  thatch: string; // cottage roofs
  trim: string;
  door: string;
  windowDay: string;
  windowNight: string;
  chimney: string;

  // Village props
  fence: string;
  awning: string; // market stall canvas (paired with island accent)
  torchFlame: string;

  // Effects & markers
  beacon: string;
  focusFlag: string;
  trail: string;

  // Labels
  labelText: string;
  labelBg: string;
}

const DAY_PALETTE: WorldPalette = {
  mood: "day",

  skyTop: "#3f8fd1",
  skyHorizon: "#cfe7f2",
  fog: "#bcd9e8",
  fogDensity: 0.00055,
  hemiSky: "#dff0fa",
  hemiGround: "#9fb98a",
  hemiIntensity: 0.85,
  sunColor: "#ffe9bf",
  sunIntensity: 1.5,
  ambient: "#dce8ee",
  ambientIntensity: 0.28,

  orb: "#ffd76a",
  orbGlow: "#ffb347",
  cloud: "#ffffff",
  cloudOpacity: 0.92,
  star: "#ffffff",

  water: "#3d8fc4",
  waterDeep: "#2a6e9e",
  waterEmissive: "#7cc4e8",

  grass: "#69b04b",
  grassAlt: "#5aa03f",
  plaza: "#a8a49a",
  plazaAlt: "#98948a",
  sand: "#e3cf8e",
  dirt: "#8a6244",
  path: "#b9a884",
  bridge: "#a87b4d",
  bridgePost: "#7d5a38",

  trunk: "#7d5535",
  leaf: "#4d8f3a",
  leafAlt: "#65a847",
  pine: "#3a7a44",
  rock: "#9aa0a3",
  flowers: ["#e2574c", "#e8b63e", "#d96bb1", "#7a8fe0", "#f0f0e8"],
  soil: "#7a5a3c",
  crop: "#7ab648",

  walls: ["#f0e3c8", "#e8d4b0", "#e5d9c0", "#dccfae", "#d8d2c0"],
  timber: "#5a4630",
  stoneBase: "#8f8c84",
  thatch: "#c8a35a",
  trim: "#8a6a48",
  door: "#6e4a28",
  windowDay: "#5d8aa8",
  windowNight: "#5d8aa8",
  chimney: "#a08878",

  fence: "#8a6a45",
  awning: "#f0ead8",
  torchFlame: "#e8c87a",

  beacon: "#54c6ff",
  focusFlag: "#ff7849",
  trail: "#ffe9a8",

  labelText: "#2b3a44",
  labelBg: "rgba(255,255,255,0.78)",
};

const NIGHT_PALETTE: WorldPalette = {
  mood: "night",

  skyTop: "#070d1f",
  skyHorizon: "#1c2c4f",
  fog: "#0e1830",
  fogDensity: 0.00075,
  hemiSky: "#2a3a60",
  hemiGround: "#101c28",
  hemiIntensity: 0.5,
  sunColor: "#9fb6e8",
  sunIntensity: 0.55,
  ambient: "#3a4a70",
  ambientIntensity: 0.34,

  orb: "#e8ecf2",
  orbGlow: "#aebde0",
  cloud: "#2c3a58",
  cloudOpacity: 0.55,
  star: "#dfe8ff",

  water: "#10304e",
  waterDeep: "#0a2038",
  waterEmissive: "#1d5a7d",

  grass: "#27543a",
  grassAlt: "#1f4730",
  plaza: "#3f4452",
  plazaAlt: "#383d4a",
  sand: "#6e6650",
  dirt: "#3c2f26",
  path: "#565040",
  bridge: "#4f3c28",
  bridgePost: "#3a2c1e",

  trunk: "#3c2e20",
  leaf: "#1d4030",
  leafAlt: "#27503a",
  pine: "#16382c",
  rock: "#454c52",
  flowers: ["#7a3b48", "#7a6a32", "#6a4070", "#3a4a7a", "#6e6e68"],
  soil: "#33271c",
  crop: "#2e5232",

  walls: ["#5a5648", "#544e44", "#56503e", "#4e4a40", "#50524a"],
  timber: "#241c14",
  stoneBase: "#3a3c42",
  thatch: "#564730",
  trim: "#36302a",
  door: "#2a2014",
  windowDay: "#1c2838",
  windowNight: "#ffc46a",
  chimney: "#3e3834",

  fence: "#3a2d1e",
  awning: "#6a6456",
  torchFlame: "#ffb347",

  beacon: "#5fd2ff",
  focusFlag: "#ff8c5a",
  trail: "#ffd27a",

  labelText: "#d8e2f0",
  labelBg: "rgba(10,16,32,0.78)",
};

export function paletteForMood(mood: WorldMood): WorldPalette {
  return mood === "day" ? DAY_PALETTE : NIGHT_PALETTE;
}

// ── Cluster accents ───────────────────────────────────────────
//
// Each island gets an accent used for banners, market awnings, manor roofs,
// the island label, and villager garb. Curated for both moods: saturated by
// day, ember-like by night.

const DAY_ACCENTS = [
  "#d95d4a",
  "#3f8fd1",
  "#46a06a",
  "#e0a13c",
  "#9a6fd0",
  "#3aa8a0",
  "#d96bb1",
  "#7a8a3a",
  "#c8784a",
  "#5a78d8",
  "#b04a5a",
  "#4a9ab8",
];

const NIGHT_ACCENTS = [
  "#a8503f",
  "#3a6aa0",
  "#3a7a55",
  "#b08234",
  "#7a5aa8",
  "#357f7a",
  "#a85a8c",
  "#6a7838",
  "#9a6240",
  "#4f64b0",
  "#8c4250",
  "#42798f",
];

export function clusterAccent(clusterIndex: number, mood: WorldMood): string {
  const accents = mood === "day" ? DAY_ACCENTS : NIGHT_ACCENTS;
  return accents[Math.abs(clusterIndex) % accents.length];
}
