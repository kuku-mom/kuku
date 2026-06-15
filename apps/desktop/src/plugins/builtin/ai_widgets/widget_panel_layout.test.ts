import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sourcePath = resolve(__dirname, "widget_panel.tsx");

describe("widget panel layout", () => {
  it("uses localized copy feedback with a prominent badge", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain('t("widget.panel.copied")');
    expect(source).toContain("bg-text-primary");
    expect(source).not.toContain("Copied to clipboard!");
  });

  it("renders a localized delete button for each widget", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("<TrashIcon");
    expect(source).toContain('t("widget.panel.copy")');
    expect(source).toContain('t("widget.panel.delete")');
    expect(source).toContain('t("widget.panel.delete_confirm")');
    expect(source).not.toContain('role="button"');
  });
});
