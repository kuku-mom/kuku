import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("resize handle", () => {
  it("elevates the active resize grip above the tab bar", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "resize_handle.tsx");
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain('"z-20": isActive()');
    expect(source).toContain('"z-10": !isActive()');
    expect(source).toContain("onResizeStart?: () => void;");
    expect(source).toContain("onResizeEnd?: () => void;");
    expect(source).toContain("props.onResizeStart?.();");
    expect(source).toContain("props.onResizeEnd?.();");
  });

  it("can mirror externally active side resize state", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "resize_handle.tsx");
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("active?: boolean;");
    expect(source).toContain(
      "const isActive = () => (hasExternalActive() ? props.active : active());",
    );
    expect(source).toContain('"z-20": isActive()');
    expect(source).toContain('"z-10": !isActive()');
    expect(source).toContain('data-active={isActive() ? "" : undefined}');
    expect(source).toContain('"bg-transparent": isActive() || isHovered()');
  });

  it("can mirror externally hovered side resize state", () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "resize_handle.tsx");
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("hovered?: boolean;");
    expect(source).toContain("onResizeHoverStart?: () => void;");
    expect(source).toContain("onResizeHoverEnd?: () => void;");
    expect(source).toContain("const hasExternalActive = () => props.active !== undefined;");
    expect(source).toContain("const hasExternalHover = () => props.hovered !== undefined;");
    expect(source).toContain(
      "const isActive = () => (hasExternalActive() ? props.active : active());",
    );
    expect(source).toContain(
      "const isHovered = () => (hasExternalHover() ? props.hovered : hovered());",
    );
    expect(source).toContain("onPointerEnter={onPointerEnter}");
    expect(source).toContain("onPointerLeave={onPointerLeave}");
    expect(source).toContain("if (!hasExternalActive()) setActive(true);");
    expect(source).toContain("if (!hasExternalActive()) setActive(false);");
    expect(source).toContain("if (!hasExternalHover()) setHovered(true);");
    expect(source).toContain("if (!hasExternalHover()) setHovered(false);");
    expect(source).toContain("props.onResizeHoverStart?.();");
    expect(source).toContain("props.onResizeHoverEnd?.();");
    expect(source).toContain('data-hovered={isHovered() && !isActive() ? "" : undefined}');
  });
});
