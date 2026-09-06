/** Deliberately different silhouettes, independent of a note's content or importance. */
export type ResidentBuild = "balanced" | "slim" | "broad" | "compact" | "tall";
export type ResidentHeadwear =
  | "cap"
  | "none"
  | "hood"
  | "antenna"
  | "headphones"
  | "beret"
  | "headwrap"
  | "captain"
  | "bandana"
  | "beanie"
  | "sunhat"
  | "chef";
export type ResidentHair = "crop" | "bob" | "braids" | "bun" | "mohawk" | "curls" | "long";
const HEADWEAR: readonly ResidentHeadwear[] = [
  "cap",
  "none",
  "hood",
  "antenna",
  "headphones",
  "beret",
  "none",
  "hood",
  "headwrap",
  "none",
  "captain",
  "bandana",
  "antenna",
  "beanie",
  "none",
  "sunhat",
  "none",
  "headwrap",
  "sunhat",
  "none",
  "bandana",
  "beanie",
  "antenna",
  "beret",
  "chef",
];
const HAIRSTYLES: readonly ResidentHair[] = [
  "crop",
  "bob",
  "braids",
  "bun",
  "mohawk",
  "curls",
  "long",
];
const BUILDS = {
  balanced: { width: 1, depth: 1, legs: 1, torso: 1, head: 1, stature: 1 },
  slim: { width: 0.8, depth: 0.85, legs: 1.16, torso: 1.06, head: 0.95, stature: 1.12 },
  broad: { width: 1.32, depth: 1.28, legs: 0.94, torso: 1.08, head: 1.06, stature: 1.04 },
  compact: { width: 1.05, depth: 1, legs: 0.74, torso: 0.84, head: 1.16, stature: 0.8 },
  tall: { width: 0.98, depth: 0.94, legs: 1.25, torso: 1.14, head: 0.92, stature: 1.19 },
} as const;
const BUILD_NAMES: readonly ResidentBuild[] = ["balanced", "slim", "broad", "compact", "tall"];
const SKINS = [
  "#f2ccab",
  "#ba7e5b",
  "#dfad89",
  "#83583f",
  "#c29276",
  "#edc1a2",
  "#694b3c",
  "#d9a57e",
];
const HAIR = ["#493225", "#302b28", "#b37a40", "#d7c9b3", "#7c4732", "#546f75", "#a76c72"];
export function residentProfile(variant: number) {
  const index = ((variant % 25) + 25) % 25;
  const guild = Math.floor(index / 5);
  const build = BUILD_NAMES[(index + guild * 2) % 5];
  const robot = index === 3 || index === 12 || index === 22;
  return {
    build,
    ...BUILDS[build],
    robot,
    headwear: HEADWEAR[index],
    hairStyle: HAIRSTYLES[(index * 3 + guild) % HAIRSTYLES.length],
    skin: robot
      ? ["#b2bdb0", "#c29c64", "#8daab1"][index % 3]
      : SKINS[(index * 3 + guild) % SKINS.length],
    hairColor: HAIR[(index + guild) % HAIR.length],
    walkTempo: [1, 1.16, 0.84, 1.23, 0.91][(index + guild) % 5],
    stride: [1, 1.1, 0.78, 0.9, 1.16][(index + guild) % 5],
  };
}
