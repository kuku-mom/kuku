import { describe, expect, it, vi } from "vitest";

vi.mock("tinykeys", () => ({
  tinykeys: vi.fn(() => vi.fn()),
}));

async function loadCommands() {
  vi.resetModules();
  return import("./commands");
}

describe("plugin commands", () => {
  it("does not expose or execute commands from inactive plugins", async () => {
    const commands = await loadCommands();
    const execute = vi.fn();

    commands.setActivationChecker((pluginId) => pluginId === "active-plugin");
    commands.registerPluginCommand("graph-view", {
      id: "graph.cycle",
      label: "Toggle Graph",
      category: "Graph",
      execute,
    });

    expect(commands.isPluginCommandVisible("graph.cycle")).toBe(false);
    expect(commands.getVisibleCommands()).toEqual([]);
    expect(commands.executePluginCommand("graph.cycle")).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("exposes active plugin commands that pass their visibility guard", async () => {
    const commands = await loadCommands();

    commands.setActivationChecker((pluginId) => pluginId === "graph-view");
    commands.registerPluginCommand("graph-view", {
      id: "graph.cycle",
      label: "Toggle Graph",
      category: "Graph",
      when: () => true,
      execute: vi.fn(),
    });

    expect(commands.isPluginCommandVisible("graph.cycle")).toBe(true);
    expect(commands.getVisibleCommands().map((command) => command.contribution.id)).toEqual([
      "graph.cycle",
    ]);
  });
});
