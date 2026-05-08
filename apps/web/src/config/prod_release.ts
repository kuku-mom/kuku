const version = "0.5.0";
const pubDate = "2026-05-08T17:18:41.000Z";
const signature =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUQ0tHMWVSVVIycE5hTFpjaDVrQUhvVUIzRzBsaEQ5UmhucDNmdzBGcHVBK20xQVJMUDBGc1NwUGtzTmgwaFllc3NSWmw3bE4yUjFwLzhROU5VWlJWdGdUWjhDRDdVM0FFPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzc4MjYwNzIxCWZpbGU6S3VrdS5hcHAudGFyLmd6CjFDQU9oVW0xWU1GdHliZmJXWnVMa1Nua1hON1BLdTFzL1l0VWdxL0NDaVV1akYvcmxXM2RQV1pOVUdNTE83QXpWVGZpejNESHJlazBXenBCQXNlOURnPT0K";

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
