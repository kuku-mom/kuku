import { describe, expect, it } from "vitest";

import { aiWidgetsPlugin } from "./index";

describe("AI widgets plugin metadata", () => {
  it("adds a right panel widget library tab", () => {
    expect(aiWidgetsPlugin.views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ai-widgets.panel",
          label: "Widgets",
          location: { slot: "rightPanel" },
        }),
      ]),
    );
  });
});
