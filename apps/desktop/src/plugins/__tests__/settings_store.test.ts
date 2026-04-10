import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

async function loadSettingsStoreModule() {
  vi.resetModules();
  return import("../settings_store");
}

describe("settings_store secure key support", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("loads plain plugin settings without secure command", async () => {
    mockInvoke.mockResolvedValue({ provider: "remote" });

    const { loadPluginSettings } = await loadSettingsStoreModule();

    const settings = await loadPluginSettings({
      pluginId: "ai-chat",
      defaults: { provider: "gemini" as const },
    });

    expect(settings).toEqual({ provider: "remote" });
    expect(mockInvoke).toHaveBeenCalledWith("plugin_get_settings", {
      pluginId: "ai-chat",
    });
  });

  it("loads secure plugin settings with secure-aware command", async () => {
    mockInvoke.mockResolvedValue({ provider: "gemini", apiKey: "secret" });

    const { loadPluginSettings } = await loadSettingsStoreModule();

    const settings = await loadPluginSettings({
      pluginId: "ai-chat",
      defaults: { provider: "remote" as const, apiKey: null as string | null },
      secureKeys: ["apiKey"],
    });

    expect(settings).toEqual({ provider: "gemini", apiKey: "secret" });
    expect(mockInvoke).toHaveBeenCalledWith("plugin_get_settings_with_secrets", {
      pluginId: "ai-chat",
      secureKeys: ["apiKey"],
    });
  });

  it("saves secure plugin settings with secure-aware command", async () => {
    mockInvoke.mockResolvedValue(undefined);

    const { savePluginSettings } = await loadSettingsStoreModule();

    await savePluginSettings("ai-chat", { provider: "gemini", apiKey: "secret" }, ["apiKey"]);

    expect(mockInvoke).toHaveBeenCalledWith("plugin_save_settings_with_secrets", {
      pluginId: "ai-chat",
      settings: { provider: "gemini", apiKey: "secret" },
      secureKeys: ["apiKey"],
    });
  });

  it("createPluginSettings persists updates through secure-aware command", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "plugin_get_settings_with_secrets":
          return { provider: "remote", apiKey: null };
        case "plugin_save_settings_with_secrets":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const { createPluginSettings } = await loadSettingsStoreModule();

    const handle = await createPluginSettings({
      pluginId: "ai-chat",
      defaults: { provider: "remote" as const, apiKey: null as string | null },
      secureKeys: ["apiKey"],
    });

    await handle.set("apiKey", "new-secret");

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "plugin_get_settings_with_secrets", {
      pluginId: "ai-chat",
      secureKeys: ["apiKey"],
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "plugin_save_settings_with_secrets", {
      pluginId: "ai-chat",
      settings: { provider: "remote", apiKey: "new-secret" },
      secureKeys: ["apiKey"],
    });
  });
});
