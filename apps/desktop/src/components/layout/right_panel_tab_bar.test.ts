import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sourcePath = resolve(__dirname, "right_panel_tab_bar.tsx");

describe("right panel tab bar", () => {
  it("uses a widget icon for the widgets tab", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("WidgetsIcon");
    expect(source).toContain('icon === "widgets"');
  });
});
