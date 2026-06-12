// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearMermaidPreviewRuntimeCache,
  createMermaidRenderCacheKey,
  getCachedMermaidConfig,
  getCachedMermaidFontReady,
  getMermaidRuntimeCacheCountsForTest,
  readCachedMermaidHeight,
  readCachedMermaidSvg,
  writeCachedMermaidHeight,
  writeCachedMermaidSvg,
} from "./runtime_cache";

function cacheKey(overrides: Partial<Parameters<typeof createMermaidRenderCacheKey>[0]> = {}) {
  return createMermaidRenderCacheKey({
    configSignature: "theme-a",
    fontSignature: "font-a",
    language: "mermaid",
    securitySignature: "strict",
    source: "graph TD\nA-->B",
    width: 1280,
    ...overrides,
  });
}

describe("mermaid preview runtime cache", () => {
  beforeEach(() => {
    clearMermaidPreviewRuntimeCache();
  });

  it("reuses cached heights for matching render keys", () => {
    const key = cacheKey();

    writeCachedMermaidHeight(key.key, 312, key.parts.widthBucket);

    expect(readCachedMermaidHeight(key.key)).toBe(312);
    expect(getMermaidRuntimeCacheCountsForTest(document).height).toBe(1);
  });

  it("reuses cached svg for matching render keys", () => {
    const key = cacheKey();

    writeCachedMermaidSvg(
      key.key,
      '<svg role="img"><text>diagram</text></svg>',
      key.parts.widthBucket,
    );

    expect(readCachedMermaidSvg(key.key)).toContain("<svg");
    expect(getMermaidRuntimeCacheCountsForTest(document).svg).toBe(1);
    expect(getMermaidRuntimeCacheCountsForTest(document).svgBytes).toBeGreaterThan(0);
  });

  it("reuses pending and resolved font readiness per document", async () => {
    const load = vi.fn(async () => undefined);

    await Promise.all([
      getCachedMermaidFontReady(document, "font-a", load),
      getCachedMermaidFontReady(document, "font-a", load),
    ]);
    await getCachedMermaidFontReady(document, "font-a", load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(getMermaidRuntimeCacheCountsForTest(document).fontReady).toBe(1);
  });

  it("reuses cached configs by signature", () => {
    const build = vi.fn(() => ({ securityLevel: "strict" as const, startOnLoad: false }));

    const first = getCachedMermaidConfig("config-a", build);
    const second = getCachedMermaidConfig("config-a", build);

    expect(first).toBe(second);
    expect(build).toHaveBeenCalledTimes(1);
    expect(getMermaidRuntimeCacheCountsForTest(document).config).toBe(1);
  });

  it("misses cache keys when theme font or width signatures change", () => {
    const base = cacheKey();
    const theme = cacheKey({ configSignature: "theme-b" });
    const font = cacheKey({ fontSignature: "font-b" });
    const width = cacheKey({ width: 1536 });

    expect(theme.key).not.toBe(base.key);
    expect(font.key).not.toBe(base.key);
    expect(width.key).not.toBe(base.key);
  });
});
