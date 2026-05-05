const version = "0.3.2";
const pubDate = "2026-04-24T12:16:12.000Z";
const signature =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUQ0tHMWVSVVIycE45UjZQRCt0eGsrdWREZGF0eG93djlDd0F3QlpTV2lDNnNacG9ybWJxZG11cWk4cWtFeGwyVytvRTE4aTducGFOZFJYNy81TFBUV0VYdi85TzJ2bWdRPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzc3MDMyOTcyCWZpbGU6S3VrdS5hcHAudGFyLmd6Cjd6Q3hPTnVRWDliK0dHbzNnM01YeGUzWWZRV1dsaTE1Q25oNEg0VldzK3VaNzQrdDlWcjZjZVJnU1plQ3A0RjRjNUZ0aVp3bWE3My9oTlFyMGk0VkFnPT0K";

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
