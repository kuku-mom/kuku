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
    expect(source).toContain("onResizeStart?: () => void;");
    expect(source).toContain("onResizeEnd?: () => void;");
    expect(source).toContain("props.onResizeStart?.();");
    expect(source).toContain("props.onResizeEnd?.();");
  });

  it("can mirror externally active side resize state", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "resize_handle.tsx");
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("active?: boolean;");
    expect(source).toContain('"z-20": active() || props.active');
    expect(source).toContain('"z-10": !active() && !props.active');
    expect(source).toContain('data-active={active() || props.active ? "" : undefined}');
    expect(source).toContain('"bg-border hover:bg-border/80": !active() && !props.active');
    expect(source).toContain('"bg-transparent": active() || props.active');
  });
});
