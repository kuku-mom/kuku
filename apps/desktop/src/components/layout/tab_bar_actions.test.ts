import { describe, expect, it } from "vitest";

import { getTabBarMoreActionIds } from "./tab_bar_actions";

describe("tab bar actions", () => {
  it("keeps the more menu free of actions already exposed as direct buttons", () => {
    expect(getTabBarMoreActionIds()).toEqual(["advanced-search"]);
    expect(getTabBarMoreActionIds()).not.toContain("new-tab");
    expect(getTabBarMoreActionIds()).not.toContain("graph");
    expect(getTabBarMoreActionIds()).not.toContain("settings");
  });
});
