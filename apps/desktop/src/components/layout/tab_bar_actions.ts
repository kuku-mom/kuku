type TabBarMoreActionId = "advanced-search";

const TAB_BAR_MORE_ACTION_IDS: TabBarMoreActionId[] = ["advanced-search"];

function getTabBarMoreActionIds(): TabBarMoreActionId[] {
  return [...TAB_BAR_MORE_ACTION_IDS];
}

export { getTabBarMoreActionIds };
export type { TabBarMoreActionId };
