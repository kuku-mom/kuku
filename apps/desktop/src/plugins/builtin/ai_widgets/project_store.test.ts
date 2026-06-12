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

  it("does not load default widget projects from the legacy plugin sandbox", async () => {
    mockInvoke.mockRejectedValue(new Error("missing"));

    const store = createWidgetProjectStore({
      now: () => "2026-06-09T00:00:00.000Z",
    });

    await expect(store.list()).resolves.toEqual([]);
    await expect(store.read("daily-trends")).rejects.toThrow("missing");

    expect(mockInvoke).not.toHaveBeenCalledWith("plugin_fs_read_dir", {
      pluginId: "ai-widgets",
      path: "projects",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("plugin_fs_read_text", {
      pluginId: "ai-widgets",
      path: "projects/daily-trends/manifest.json",
    });
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

  it("allocates a unique id for new widgets with duplicate names", async () => {
    const existing: WidgetProject = {
      id: "daily-trends",
      name: "Daily Trends",
      type: "html",
      entry: "index.html",
      files: [{ path: "index.html", content: "" }],
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
    };
    const files = new Map<string, string>([
      ["projects/daily-trends/manifest.json", JSON.stringify(existing)],
    ]);
    const store = createWidgetProjectStore({
      now: () => "2026-06-09T00:00:00.000Z",
      fs: {
        readDir: async () => [],
        readText: async (path) => {
          const content = files.get(path);
          if (content == null) throw new Error(`Missing file: ${path}`);
          return content;
        },
        writeText: async (path, content) => {
          files.set(path, content);
        },
      },
    });

    const project = await store.save({
      name: "Daily Trends",
      type: "html",
      files: [{ path: "index.html", content: "<h1>New</h1>" }],
    });

    expect(project.id).toBe("daily-trends-1");
    expect(files.get("projects/daily-trends/manifest.json")).toBe(JSON.stringify(existing));
    expect(files.get("projects/daily-trends-1/files/index.html")).toBe("<h1>New</h1>");
  });

  it("writes project files before the manifest", async () => {
    const writes: string[] = [];
    const store = createWidgetProjectStore({
      now: () => "2026-06-09T00:00:00.000Z",
      fs: {
        readDir: async () => [],
        readText: async () => {
          throw new Error("missing");
        },
        writeText: async (path) => {
          writes.push(path);
        },
      },
    });

    await store.save({
      name: "Daily Trends",
      type: "html",
      files: [{ path: "index.html", content: "<h1>Daily Trends</h1>" }],
    });

    expect(writes).toEqual([
      "projects/daily-trends/files/index.html",
      "projects/daily-trends/manifest.json",
    ]);
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

  it.each([
    ["location", '<script>location.href = "https://example.com/leak"</script>'],
    ["fetch", '<script>fetch("https://example.com/leak")</script>'],
    [
      "computed navigation script",
      "<script>globalThis['loc' + 'ation']['href'] = String.fromCharCode(104)</script>",
    ],
    ["window.open", "<button onclick=\"window.open('https://example.com')\">Open</button>"],
    ["inline event handler", '<button onclick="alert(1)">Open</button>'],
    ["javascript URL", '<a href="javascript:alert(1)">Open</a>'],
    ["external anchor", '<a href="https://example.com">Open</a>'],
    ["form", '<form action="/submit"><button>Send</button></form>'],
    ["protocol-relative URL", '<img src="//example.com/pixel.png" alt="">'],
  ])("rejects unsafe widget source before writing: %s", async (_label, source) => {
    const writes = new Map<string, string>();
    const store = createWidgetProjectStore({
      now: () => "2026-06-09T00:00:00.000Z",
      fs: {
        readDir: async () => [],
        readText: async () => {
          throw new Error("missing");
        },
        writeText: async (path, content) => {
          writes.set(path, content);
        },
      },
    });

    await expect(
      store.save({
        name: "Unsafe",
        type: "html",
        files: [{ path: "index.html", content: source }],
      }),
    ).rejects.toThrow("Widget source cannot");

    expect(writes.size).toBe(0);
  });

  it("reads legacy stored widget files even when their source is no longer allowed for saves", async () => {
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
      [
        "projects/daily-trends/files/index.html",
        '<meta http-equiv="refresh" content="0; url=https://example.com">',
      ],
    ]);
    const store = createWidgetProjectStore({
      now: () => "2026-06-09T00:00:00.000Z",
      fs: {
        readDir: async () => [],
        readText: async (path) => files.get(path) ?? "",
        writeText: async () => {},
      },
    });

    await expect(store.read("daily-trends")).resolves.toMatchObject({
      id: "daily-trends",
      files: [
        {
          path: "index.html",
          content: '<meta http-equiv="refresh" content="0; url=https://example.com">',
        },
      ],
    });
  });

  it("allows svg namespace URLs while rejecting external widget URLs", async () => {
    const writes = new Map<string, string>();
    const store = createWidgetProjectStore({
      now: () => "2026-06-09T00:00:00.000Z",
      fs: {
        readDir: async () => [],
        readText: async () => {
          throw new Error("missing");
        },
        writeText: async (path, content) => {
          writes.set(path, content);
        },
      },
    });

    await expect(
      store.save({
        name: "Safe Svg",
        type: "svg",
        files: [
          {
            path: "widget.svg",
            content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" /></svg>',
          },
        ],
      }),
    ).resolves.toMatchObject({ id: "safe-svg" });

    expect(writes.get("projects/safe-svg/files/widget.svg")).toContain("www.w3.org/2000/svg");
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

  it("rejects stored manifests with unsafe project metadata", async () => {
    const manifest: WidgetProject = {
      id: "daily-trends",
      name: "Daily Trends",
      type: "html",
      entry: "../outside.html",
      files: [{ path: "../outside.html", content: "" }],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };
    const store = createWidgetProjectStore({
      now: () => "2026-06-09T00:00:00.000Z",
      fs: {
        readDir: async () => [],
        readText: async (path) => (path.endsWith("manifest.json") ? JSON.stringify(manifest) : ""),
        writeText: async () => {},
      },
    });

    await expect(store.read("daily-trends")).rejects.toThrow("Unsafe widget file path");
  });

  it("ignores stored manifests whose id does not match their folder", async () => {
    const manifest: WidgetProject = {
      id: "other-widget",
      name: "Daily Trends",
      type: "html",
      entry: "index.html",
      files: [{ path: "index.html", content: "" }],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };
    const store = createWidgetProjectStore({
      now: () => "2026-06-09T00:00:00.000Z",
      fs: {
        readDir: async (path) => (path === "projects" ? ["daily-trends"] : []),
        readText: async () => JSON.stringify(manifest),
        writeText: async () => {},
      },
    });

    await expect(store.read("daily-trends")).rejects.toThrow("Widget manifest id mismatch");
    expect(await store.list()).toEqual([]);
  });
});
