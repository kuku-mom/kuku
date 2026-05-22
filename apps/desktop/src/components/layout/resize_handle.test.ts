import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("resize handle", () => {
  it("elevates the active resize grip above the tab bar", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "resize_handle.tsx");
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain('"z-20": active()');
    expect(source).toContain('"z-10": !active()');
  });
});
