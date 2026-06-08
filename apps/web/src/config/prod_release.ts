const version = "0.5.4";
const pubDate = "2026-06-04T09:51:51.000Z";
const signature =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUQ0tHMWVSVVIycEFjd2U3Q202Ukt0aVJwTTNmc245dlkzSy9VYjBCQ0ZhMWdrbXRDN1U5R3AwV3RpcU9wSFNjY0lPck9ZTkNEWEhNbzlQS1l1bGRlVTRUNWtWT0lwVndJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzgwNTY2NzEwCWZpbGU6S3VrdS5hcHAudGFyLmd6ClRRQ3hsY1BmMWVTMHpJcnljaGdLd0cvcUlCSnNBRXh6QlU1Y1gyeFFiNVMyMENoYUZOcFhaNFprT2JjaFdYaTJvUGZWbUtPV0xGR0VYbkZNUmYyVUR3PT0K";

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
