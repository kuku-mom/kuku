const version = "0.6.0";
const pubDate = "2026-10-10T12:05:43.000Z";
const signature = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUQ0tHMWVSVVIycEdDWmovUlJoVFdmWUs1ajdOMlI1bnRGdUNRRkZncHNhaWorMVFRQjRVM0prQ2Q4RTczOE5TMWVHdkJaTDU5VUYwRHczMkIrdDYyT1hldW03UWZTVFFnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxNjMzOTQyCWZpbGU6S3VrdS5hcHAudGFyLmd6CklwaVlHbmlZbGhGdC9pVGZJckJaMW9TRXhIU2xHRGQwQjFTV2FuV0FKc2VoeXRMU0dCamFsc2dhcWJ1bEVnaTlIQmR6SHF6T2VpNTl1Rm1JNWwzREN3PT0K";

const githubRepo = "kuku-mom/kuku";
const webUrl = "https://kuku.mom";
const siteUrl = "https://www.kuku.mom";
const apiBaseUrl = "https://api.kuku.mom";

function githubReleaseAssetUrl(assetName: string): string {
  return `https://github.com/${githubRepo}/releases/download/${version}/${assetName}`;
}

export const prodRelease = {
  version,
  pubDate,
  signature,
  githubRepo,
  webUrl,
  siteUrl,
  apiBaseUrl,
  notes: `Kuku ${version}`,
  assets: {
    macDmg: `Kuku_${version}_aarch64.dmg`,
    updaterTarGz: "Kuku.app.tar.gz",
  },
} as const;

export const prodReleaseLinks = {
  github: `https://github.com/${prodRelease.githubRepo}`,
  downloadMac: githubReleaseAssetUrl(prodRelease.assets.macDmg),
  updaterTarGz: githubReleaseAssetUrl(prodRelease.assets.updaterTarGz),
} as const;

export const prodReleaseManifest = {
  version: prodRelease.version,
  notes: prodRelease.notes,
  pub_date: prodRelease.pubDate,
  platforms: {
    "darwin-aarch64": {
      signature: prodRelease.signature,
      url: prodReleaseLinks.updaterTarGz,
    },
  },
} as const;
