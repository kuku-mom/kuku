import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("resize handle", () => {
  it("keeps resize state local to the handle", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "resize_handle.tsx");
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("const [active, setActive]");
    expect(source).toContain("const [hovered, setHovered]");
    expect(source).not.toContain("active?: boolean;");
    expect(source).not.toContain("hovered?: boolean;");
    expect(source).not.toContain("onResizeStart?: () => void;");
    expect(source).not.toContain("onResizeEnd?: () => void;");
    expect(source).not.toContain("onResizeHoverStart?: () => void;");
    expect(source).not.toContain("onResizeHoverEnd?: () => void;");
    expect(source).not.toContain("hasExternalActive");
    expect(source).not.toContain("hasExternalHover");
  });

  it("shows hover and active affordances from local pointer state", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "resize_handle.tsx");
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain('data-active={active() ? "" : undefined}');
    expect(source).toContain('data-hovered={hovered() && !active() ? "" : undefined}');
    expect(source).toContain("onPointerEnter={onPointerEnter}");
    expect(source).toContain("onPointerLeave={onPointerLeave}");
    expect(source).toContain("setActive(true);");
    expect(source).toContain("setActive(false);");
    expect(source).toContain("setHovered(true);");
    expect(source).toContain("setHovered(false);");
    expect(source).toContain('"bg-border": !active() && !hovered()');
    expect(source).toContain('"bg-transparent": active() || hovered()');
  });
});
