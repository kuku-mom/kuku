import { describe, expect, it } from "vitest";

import { externalLinks } from "@/config/links";
import { prodRelease, prodReleaseLinks, prodReleaseManifest } from "@/config/prod_release";

describe("prod release config", () => {
  it("drives the mac download link from the configured release version", () => {
    expect(externalLinks.github).toBe(prodReleaseLinks.github);
    expect(externalLinks.downloadMac).toBe(
      `https://github.com/${prodRelease.githubRepo}/releases/download/${prodRelease.version}/Kuku_${prodRelease.version}_aarch64.dmg`,
    );
  });

  it("drives the updater manifest from the configured release version", () => {
    expect(prodReleaseManifest.version).toBe(prodRelease.version);
    expect(prodReleaseManifest.notes).toBe(`Kuku ${prodRelease.version}`);
    expect(prodReleaseManifest.pub_date).toBe(prodRelease.pubDate);
    expect(prodReleaseManifest.platforms["darwin-aarch64"]).toEqual({
      signature: prodRelease.signature,
      url: prodReleaseLinks.updaterTarGz,
    });
  });
});
