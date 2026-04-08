import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { AiProxyToolRegistry, ProxyToolCallPayload, ProxyToolSpec } from "./types";

async function createProxyToolBridge(): Promise<{
  registry: AiProxyToolRegistry;
  dispose: () => void;
}> {
  const handlers = new Map<string, ProxyToolSpec["handler"]>();
  const specs = new Map<string, ProxyToolSpec>();

  const unlisten = await listen<ProxyToolCallPayload>("ai:proxy-tool-call", (event) => {
    void (async () => {
      const { callId, toolName, arguments: args } = event.payload;
      const handler = handlers.get(toolName);

      if (!handler) {
        await invoke("plugin:kuku-ai|ai_submit_proxy_tool_result", {
          callId,
          output: `No handler registered for proxy tool: ${toolName}`,
          isError: true,
        }).catch(() => {});
        return;
      }

      try {
        const output = await handler(args);
        await invoke("plugin:kuku-ai|ai_submit_proxy_tool_result", {
          callId,
          output,
          isError: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await invoke("plugin:kuku-ai|ai_submit_proxy_tool_result", {
          callId,
          output: message,
          isError: true,
        }).catch(() => {});
      }
    })();
  });

  const registry: AiProxyToolRegistry = {
    register(tool: ProxyToolSpec) {
      handlers.set(tool.name, tool.handler);
      specs.set(tool.name, tool);

      void invoke("plugin:kuku-ai|ai_register_proxy_tool", {
        descriptor: {
          toolId: tool.toolId,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          category: tool.category,
        },
      }).catch((error) => {
        // Roll back optimistic registration if the backend rejects it.
        handlers.delete(tool.name);
        specs.delete(tool.name);
        // eslint-disable-next-line no-console
        console.error("[ai-chat] failed to register proxy tool", error);
      });

      return () => {
        handlers.delete(tool.name);
        specs.delete(tool.name);
        void invoke("plugin:kuku-ai|ai_unregister_proxy_tool", {
          name: tool.name,
        }).catch((error) => {
          // eslint-disable-next-line no-console
          console.error("[ai-chat] failed to unregister proxy tool", error);
        });
      };
    },
  };

  const dispose = () => {
    unlisten();
    handlers.clear();
    specs.clear();
  };

  return { registry, dispose };
}

export { createProxyToolBridge };
