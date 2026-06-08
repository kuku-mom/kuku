const version = "0.5.5";
const pubDate = "2026-06-08T14:22:56.000Z";
const signature =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUQ0tHMWVSVVIycEZ5UDFLUHgwYlllV0VPY05KZks3cU9WT1Y4Z1FvRGhpZGZkOXo4dHhTZkN3N2F2OHRCSDJvajdmakgrNVdNYmt1V2F0Uk5pQVZnUzVvbWVoMkUyRGdnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzgwOTI4NTc1CWZpbGU6S3VrdS5hcHAudGFyLmd6CkYwa1NIZHRsQ1dZaUNUNzdGMU1lMlNrNm1VdHJZRk01d3NsUmZqUmw5eTNYemdsVFlGejJOS0M1ZWlDTVMwdGF5YUk3Z2kwczd2bUlZOFlKR0VQVkJRPT0K";

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
