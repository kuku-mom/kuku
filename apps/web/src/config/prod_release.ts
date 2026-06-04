const version = "0.5.3";
const pubDate = "2026-06-04T09:11:47.000Z";
const signature =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUQ0tHMWVSVVIycEJOck5yaCtEUHd0djZqOHpHRko5azEyenRGK05yRTJ1Z05yb2ZDK3NhandibmJaUE5MU2dXNVZtaytESE5lL0c1S2c2dUhQMFMxM1VxTGN5MllTTWdnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzgwNTY0MzA2CWZpbGU6S3VrdS5hcHAudGFyLmd6CjI1R2xvbWg0YWV2UXVRbGpmbzRPV2NHcmR5Vmc0U0VLN1U1SDZkNkNVM1QwSDVQR2dCb29VN3ZDa0FXVTlraEM4WlFQQUFoM0F0MU42cmpNL2VnRUJBPT0K";

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
