// ── Agent World Palette ──
//
// A single, hand-tuned daytime palette in the spirit of painterly Japanese
// animation: soft sage greens, muted teal water, warm tan earth, cream walls
// under dark sloped roofs, and a warm near-black "ink" used for cel outlines.
// Every world generator reads colors from here only, so the whole world
// re-skins from one place.

export type WorldMood = "day" | "night";

export interface WorldPalette {
  mood: WorldMood;

  /** Warm near-black used for every cel outline. */
  ink: string;

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

  // Sky bodies
  cloud: string;
  cloudShadow: string;
  sunGlow: string;

  // Water
  water: string;
  waterDeep: string;
  waterShallow: string;
  waveLine: string;
  foam: string;

  // Terrain
  grassLight: string;
  grass: string;
  grassDark: string;
  cliff: string; // earthy island sides
  cliffDark: string;
  sand: string;
  pathDirt: string;
  plaza: string;

  // Nature
  trunk: string;
  trunkDark: string;
  canopyLight: string;
  canopy: string;
  canopyDark: string;
  pine: string;
  bush: string;
  rock: string;
  rockDark: string;
  flowers: string[];
  crop: string;
  fieldSoil: string;

  // Buildings
  wallLight: string;
  wall: string;
  wallShadow: string;
  roof: string;
  roofRidge: string;
  beam: string;
  door: string;
  window: string;
  windowWarm: string;
  foundation: string;

  // Effects & markers
  beacon: string;
  focusFlag: string;
  trail: string;

  // Labels
  labelText: string;
  labelBg: string;
}

const HARBOR_DAY: WorldPalette = {
  mood: "day",

  ink: "#2c2a26",

  skyTop: "#93d2d6",
  skyHorizon: "#459faf",
  fog: "#439cad",
  fogDensity: 0.000025,
  hemiSky: "#c5e8ed",
  hemiGround: "#a39076",
  hemiIntensity: 1.35,
  sunColor: "#fff4d6",
  sunIntensity: 2.45,
  ambient: "#e0ede6",
  ambientIntensity: 0.25,

  cloud: "#fbfaf2",
  cloudShadow: "#dde8e1",
  sunGlow: "#fff0c8",

  water: "#4f9aa0",
  waterDeep: "#167b91",
  waterShallow: "#3998a6",
  waveLine: "#bfe2dc",
  foam: "#f3f8f3",

  grassLight: "#aad673",
  grass: "#8cc25d",
  grassDark: "#69a64f",
  cliff: "#c4aa78",
  cliffDark: "#a3855a",
  sand: "#e6d6a6",
  pathDirt: "#c8b083",
  plaza: "#cdbb8c",

  trunk: "#7d5a3a",
  trunkDark: "#5c4128",
  canopyLight: "#80b15a",
  canopy: "#5f9a48",
  canopyDark: "#477937",
  pine: "#3f7a4e",
  bush: "#6fa84f",
  rock: "#9ba4a0",
  rockDark: "#76817b",
  flowers: ["#e86a5a", "#f3c24f", "#e58bbf", "#8aa9e0", "#fbf6ec"],
  crop: "#d3b94f",
  fieldSoil: "#9c7a4e",

  wallLight: "#f4ede1",
  wall: "#e8ddc9",
  wallShadow: "#d6c8ae",
  roof: "#56656f",
  roofRidge: "#3e484f",
  beam: "#6e5236",
  door: "#7c5230",
  window: "#bfe2e6",
  windowWarm: "#f4cd8c",
  foundation: "#9c958a",

  beacon: "#ffcd72",
  focusFlag: "#f08a4a",
  trail: "#ffe6a6",

  labelText: "#33403c",
  labelBg: "rgba(252,235,198,0.94)",
};

const HARBOR_NIGHT: WorldPalette = {
  ...HARBOR_DAY,
  mood: "night",
  fog: "#1a1a1a",
  hemiSky: "#aec8e3",
  hemiGround: "#45414a",
  hemiIntensity: 0.9,
  sunColor: "#c2d7f1",
  sunIntensity: 1.05,
  ambient: "#c4ccde",
  ambientIntensity: 0.36,
  waterDeep: "#112d38",
  waterShallow: "#28515d",
  foam: "#809da7",
  waveLine: "#678b97",
  labelText: "#e0ded6",
  labelBg: "#27292d",
  trail: "#c9b07e",
};

export function paletteForMood(mood: WorldMood): WorldPalette {
  return mood === "night" ? HARBOR_NIGHT : HARBOR_DAY;
}

// ── Cluster accents ───────────────────────────────────────────
//
// Each island gets an accent used for roofs, banners, and villager garb.
// Softer, slightly desaturated tones that sit well next to the sage palette.

const ACCENTS = [
  "#d98878",
  "#e6bf75",
  "#829dc6",
  "#a4b774",
  "#a18bb8",
  "#e8deca",
  "#88b6b3",
  "#d7a080",
  "#b4bacb",
  "#d4be83",
  "#ba8891",
  "#8caaaa",
];

export function clusterAccent(clusterIndex: number, _mood: WorldMood): string {
  return ACCENTS[Math.abs(clusterIndex) % ACCENTS.length];
}
