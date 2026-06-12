import { beforeEach, describe, expect, it, vi } from "vitest";

import { createWidgetProjectStore } from "~/plugins/builtin/ai_widgets/project_store";
import type { WidgetProject } from "~/plugins/builtin/ai_widgets/types";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("widget project store", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("stores default widget projects under the vault-local plugin directory", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command.endsWith("_read_text")) {
        throw new Error("missing");
      }
      if (command.endsWith("_write_text")) {
        return undefined;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const store = createWidgetProjectStore({
      now: () => "2026-06-09T00:00:00.000Z",
    });

    await store.save({
      name: "Daily Trends",
      type: "html",
      files: [{ path: "index.html", content: "<h1>Daily Trends</h1>" }],
    });

    expect(mockInvoke).toHaveBeenCalledWith("vault_plugin_fs_read_text", {
      pluginId: "ai-widgets",
      path: "projects/daily-trends/manifest.json",
    });
    expect(mockInvoke).toHaveBeenCalledWith("vault_plugin_fs_write_text", {
      pluginId: "ai-widgets",
      path: "projects/daily-trends/manifest.json",
      content: expect.stringContaining('"name": "Daily Trends"'),
    });
    expect(mockInvoke).toHaveBeenCalledWith("vault_plugin_fs_write_text", {
      pluginId: "ai-widgets",
      path: "projects/daily-trends/files/index.html",
      content: "<h1>Daily Trends</h1>",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "plugin_fs_write_text",
      expect.objectContaining({ pluginId: "ai-widgets" }),
    );
  });

  it("writes a manifest and project files into the plugin sandbox", async () => {
    const writes = new Map<string, string>();
    const store = createWidgetProjectStore({
      now: () => "2026-06-09T00:00:00.000Z",
      fs: {
        readDir: async () => [],
        readText: async (path) => writes.get(path) ?? "",
        writeText: async (path, content) => {
          writes.set(path, content);
        },
      },
    });

    const project = await store.save({
      name: "Daily Trends",
      type: "html",
      files: [{ path: "index.html", content: "<h1>Daily Trends</h1>" }],
    });

    expect(project.id).toBe("daily-trends");
    expect(writes.get("projects/daily-trends/manifest.json")).toContain('"name": "Daily Trends"');
    expect(writes.get("projects/daily-trends/files/index.html")).toBe("<h1>Daily Trends</h1>");
  });

  it("rejects project file paths that could escape or confuse the sandbox", async () => {
    const store = createWidgetProjectStore({
      now: () => "2026-06-09T00:00:00.000Z",
      fs: {
        readDir: async () => [],
        readText: async () => "",
        writeText: async () => {},
      },
    });

    await expect(
      store.save({
        name: "Unsafe",
        type: "html",
        files: [{ path: "../index.html", content: "" }],
      }),
    ).rejects.toThrow("Unsafe widget file path");

    await expect(
      store.save({
        name: "Unsafe",
        type: "html",
        files: [{ path: "nested\\index.html", content: "" }],
      }),
    ).rejects.toThrow("Unsafe widget file path");
  });

  it("lists and reads saved widget projects", async () => {
    const manifest: WidgetProject = {
      id: "daily-trends",
      name: "Daily Trends",
      type: "html",
      entry: "index.html",
      files: [{ path: "index.html", content: "" }],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };
    const files = new Map<string, string>([
      ["projects/daily-trends/manifest.json", JSON.stringify(manifest)],
      ["projects/daily-trends/files/index.html", "<h1>Daily Trends</h1>"],
    ]);
    const store = createWidgetProjectStore({
      now: () => "2026-06-09T00:00:00.000Z",
      fs: {
        readDir: async (path) => (path === "projects" ? ["daily-trends"] : []),
        readText: async (path) => files.get(path) ?? "",
        writeText: async (path, content) => {
          files.set(path, content);
        },
      },
    });

    expect(await store.list()).toEqual([
      {
        id: "daily-trends",
        name: "Daily Trends",
        type: "html",
        entry: "index.html",
        updatedAt: "2026-06-09T00:00:00.000Z",
      },
    ]);
    expect(await store.read("daily-trends")).toEqual({
      ...manifest,
      files: [{ path: "index.html", content: "<h1>Daily Trends</h1>" }],
    });
  });
});
