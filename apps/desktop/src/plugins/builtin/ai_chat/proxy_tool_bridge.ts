import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  AiProxyToolRegistry,
  ProxyToolCallPayload,
} from "~/plugins/builtin/core_tool_registry/types";

async function createProxyToolBridge(registry: AiProxyToolRegistry): Promise<() => void> {
  const syncedNames = new Set<string>();
  let disposed = false;
  let syncPromise = Promise.resolve();

  async function syncRegisteredTools(): Promise<void> {
    if (disposed) return;

    const nextTools = registry.list().filter((tool) => tool.aiEnabled !== false);
    const nextNames = new Set(nextTools.map((tool) => tool.name));

    const removedNames = [...syncedNames].filter((name) => !nextNames.has(name));
    await Promise.all(
      removedNames.map((name) =>
        invoke("plugin:kuku-ai|ai_unregister_proxy_tool", { name }).catch((error) => {
          // eslint-disable-next-line no-console
          console.error("[ai-chat] failed to unregister proxy tool", error);
        }),
      ),
    );

    const successfulNames = new Set<string>();
    await Promise.all(
      nextTools.map(async (tool) => {
        try {
          await invoke("plugin:kuku-ai|ai_register_proxy_tool", {
            descriptor: {
              toolId: tool.toolId,
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              category: tool.category,
              access: tool.access ?? "readOnly",
            },
          });
          successfulNames.add(tool.name);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error("[ai-chat] failed to register proxy tool", error);
        }
      }),
    );

    syncedNames.clear();
    for (const name of successfulNames) {
      syncedNames.add(name);
    }
  }

  function queueSync(): void {
    syncPromise = syncPromise.then(syncRegisteredTools, syncRegisteredTools);
  }

  const unlisten = await listen<ProxyToolCallPayload>("ai:proxy-tool-call", (event) => {
    void (async () => {
      const { callId, toolName, arguments: args } = event.payload;
      const handler = registry.getHandler(toolName);

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

  const disposeSubscription = registry.subscribe(() => {
    queueSync();
  });

  queueSync();

  return () => {
    disposed = true;
    disposeSubscription();
    unlisten();
    const names = [...syncedNames];
    syncedNames.clear();
    void Promise.all(
      names.map((name) =>
        invoke("plugin:kuku-ai|ai_unregister_proxy_tool", { name }).catch((error) => {
          // eslint-disable-next-line no-console
          console.error("[ai-chat] failed to unregister proxy tool", error);
        }),
      ),
    );
  };
}

export { createProxyToolBridge };
