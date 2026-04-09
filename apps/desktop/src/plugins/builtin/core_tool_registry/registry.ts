import type { AiProxyToolRegistry, ProxyToolDescriptor, ProxyToolSpec } from "./types";

function createProxyToolRegistry(): AiProxyToolRegistry {
  const tools = new Map<string, ProxyToolSpec>();
  const listeners = new Set<() => void>();

  function emitChange(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    register(tool) {
      if (tools.has(tool.name)) {
        // eslint-disable-next-line no-console
        console.warn(`[core-tool-registry] overwriting existing tool "${tool.name}"`);
      }

      tools.set(tool.name, tool);
      emitChange();

      return () => {
        const current = tools.get(tool.name);
        if (current === tool) {
          tools.delete(tool.name);
          emitChange();
        }
      };
    },
    list(): ProxyToolDescriptor[] {
      return [...tools.values()].map((tool) => ({
        name: tool.name,
        toolId: tool.toolId,
        description: tool.description,
        parameters: tool.parameters,
        category: tool.category,
        aiEnabled: tool.aiEnabled,
      }));
    },
    getHandler(name) {
      return tools.get(name)?.handler;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export { createProxyToolRegistry };
