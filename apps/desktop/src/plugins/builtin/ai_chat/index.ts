import { lazy } from "solid-js";

import { openRightPanelView } from "~/stores/layout";
import type { KukuPlugin } from "~/plugins/types";

import { createAiEventBridge } from "./event_bridge";
import { createProxyToolBridge } from "./proxy_tool_bridge";
import { loadConfig, loadTools } from "./chat_store";

const ChatPanelView = lazy(() => import("./chat_panel"));
const AiSettingsView = lazy(() =>
  import("./components/ai_settings").then((module) => ({ default: module.AiSettings })),
);

const aiChatPlugin: KukuPlugin = {
  id: "ai-chat",
  name: "AI Chat",
  version: "0.1.0",
  description: "Chat with Gemini from the right panel",
  canDisable: true,

  views: [
    {
      id: "ai-chat.panel",
      label: "AI Chat",
      location: { slot: "rightPanel" },
      component: ChatPanelView,
    },
    {
      id: "ai-chat.settings",
      label: "AI Chat",
      location: { slot: "settingsSection" },
      order: 20,
      component: AiSettingsView,
    },
  ],

  commands: [
    {
      id: "ai-chat.openPanel",
      label: "Open AI Chat",
      category: "AI",
      defaultKeys: ["$mod+Shift+KeyA"],
      global: true,
      execute: () => openRightPanelView("ai-chat.panel"),
    },
  ],

  async activate(ctx) {
    const { registry, dispose } = await createProxyToolBridge();
    ctx.services.register("proxyTools", registry);
    ctx.track(dispose);

    const disposeEvents = await createAiEventBridge();
    ctx.track(disposeEvents);

    try {
      await Promise.all([loadConfig(), loadTools()]);
    } catch {
      // Keep defaults if the backend plugin is not ready yet.
    }
  },
};

export { aiChatPlugin };
