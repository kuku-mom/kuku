import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  AiProxyToolRegistry,
  ProxyToolCallPayload,
  ProxyToolDescriptor,
} from "~/plugins/builtin/core_tool_registry/types";

interface ProxyToolBridgeOptions {
  onToolsChanged?: () => void | Promise<void>;
}

// A disabled AI plugin may still have IPC registration in flight when its
// replacement starts. Keep cleanup and registration ordered across instances.
let nativeSyncQueue: Promise<void> = Promise.resolve();
function queueNativeSync(action: () => Promise<void>) {
  const next = nativeSyncQueue.then(action, action);
  nativeSyncQueue = next.catch(() => {});
  return next;
}

async function createProxyToolBridge(
  registry: AiProxyToolRegistry,
  options: ProxyToolBridgeOptions = {},
): Promise<() => void> {
  const syncedTools = new Map<string, ProxyToolDescriptor>();
  let disposed = false;

  async function unregister(name: string) {
    try {
      await invoke("plugin:kuku-ai|ai_unregister_proxy_tool", { name });
      syncedTools.delete(name);
    } catch (error) {
      // Retain failed removals so a later sync retries them.
      // eslint-disable-next-line no-console
      console.error("[ai-chat] failed to unregister proxy tool", error);
    }
  }
  async function syncRegisteredTools(): Promise<void> {
    if (disposed) return;
    const nextTools = registry.list().filter((tool) => tool.aiEnabled !== false);
    const nextNames = new Set(nextTools.map((tool) => tool.name));
    await Promise.all(
      [...syncedTools.keys()].filter((name) => !nextNames.has(name)).map(unregister),
    );
    if (disposed) return;
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
          // Cleanup is queued behind this registration, including when dispose
          // happened while invoke was pending.
          syncedTools.set(tool.name, tool);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error("[ai-chat] failed to register proxy tool", error);
        }
      }),
    );
    if (!disposed) await options.onToolsChanged?.();
  }
  function queueSync() {
    void queueNativeSync(syncRegisteredTools).catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[ai-chat] failed to synchronize proxy tools", error);
    });
  }

  const unlisten = await listen<ProxyToolCallPayload>("ai:proxy-tool-call", (event) => {
    void (async () => {
      const { callId, toolName, toolId, access, arguments: args } = event.payload;
      const current = registry
        .list()
        .find((tool) => tool.name === toolName && tool.aiEnabled !== false);
      const synced = syncedTools.get(toolName);
      const handler = registry.getHandler(toolName);
      if (
        disposed ||
        !current ||
        !synced ||
        !handler ||
        (toolId !== undefined && current.toolId !== toolId) ||
        (access ?? "readOnly") !== (current.access ?? "readOnly") ||
        current.toolId !== synced.toolId ||
        (current.access ?? "readOnly") !== (synced.access ?? "readOnly")
      ) {
        await invoke("plugin:kuku-ai|ai_submit_proxy_tool_result", {
          callId,
          output: `No active handler registered for proxy tool: ${toolName}`,
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

  const disposeSubscription = registry.subscribe(queueSync);
  queueSync();

  return () => {
    if (disposed) return;
    disposed = true;
    disposeSubscription();
    unlisten();
    void queueNativeSync(async () => {
      await Promise.all([...syncedTools.keys()].map(unregister));
    });
  };
}

export { createProxyToolBridge };
