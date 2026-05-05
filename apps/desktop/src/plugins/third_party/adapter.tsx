import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";
import type { KukuPlugin } from "~/plugins/types";
import { closeRightPanelView, layoutState, openRightPanelView } from "~/stores/layout";
import { vaultState } from "~/stores/vault";

import { callPluginSidecar } from "./installer";
import { GenericThirdPartySettings } from "./generic_settings";
import GBrainPanel from "./gbrain_panel";
import LlmWikiPanel from "./llmwiki_panel";
import type { InstalledPluginInfo, ThirdPartyAiToolManifest } from "./types";

function aiEnabled(tool: ThirdPartyAiToolManifest): boolean {
  return tool.access !== "admin";
}

function createThirdPartyPlugin(info: InstalledPluginInfo): KukuPlugin {
  const manifest = info.manifest;
  const isGbrain = manifest.id === "gbrain";
  const isLlmwiki = manifest.id === "llmwiki";

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    kind: "third-party",
    installedPath: info.installedPath,
    permissions: manifest.permissions,
    canDisable: true,
    dependencies: ["core-tool-registry"],

    views: [
      ...(isGbrain
        ? [
            {
              id: "gbrain.panel",
              label: "GBrain",
              icon: "brain",
              location: { slot: "rightPanel" as const },
              order: 70,
              component: GBrainPanel,
            },
          ]
        : []),
      ...(isLlmwiki
        ? [
            {
              id: "llmwiki.panel",
              label: "LLM Wiki",
              icon: "file",
              location: { slot: "rightPanel" as const },
              order: 75,
              component: LlmWikiPanel,
            },
          ]
        : []),
      {
        id: `${manifest.id}.settings`,
        label: manifest.name,
        location: { slot: "settingsSection" },
        order: 80,
        component: () => <GenericThirdPartySettings info={info} />,
      },
    ],

    commands: commandContributionsFor(info),

    activate(ctx) {
      const proxyTools = ctx.services.get("core-tool-registry.proxyTools") as
        | AiProxyToolRegistry
        | undefined;
      if (!proxyTools) return;

      for (const tool of manifest.aiTools ?? []) {
        if (!aiEnabled(tool)) continue;
        const dispose = proxyTools.register({
          name: tool.name,
          toolId: tool.toolId ?? `${manifest.id}.${tool.name}`,
          description: tool.description,
          parameters: tool.parameters,
          category: tool.category ?? manifest.name,
          access: tool.access === "write" ? "proposesMutation" : "readOnly",
          aiEnabled: true,
          handler: (args) => {
            if (tool.access === "write") {
              if (manifest.id !== "llmwiki") {
                return Promise.resolve(
                  JSON.stringify(
                    {
                      error: "approval_required",
                      message:
                        "This third-party write tool is registered for Agent-mode planning, but Kuku does not execute sidecar writes until a plugin approval bridge is available.",
                      tool: tool.name,
                      arguments: args,
                    },
                    null,
                    2,
                  ),
                );
              }
              return callPluginSidecar(manifest.id, tool.sidecar, tool.operation, {
                ...args,
                vaultPath: vaultState.rootPath,
                modePolicy: tool.modes ?? null,
                access: tool.access ?? "write",
              });
            }
            return callPluginSidecar(manifest.id, tool.sidecar, tool.operation, {
              ...args,
              ...(manifest.id === "llmwiki" ? { vaultPath: vaultState.rootPath } : {}),
              modePolicy: tool.modes ?? null,
              access: tool.access ?? "read",
            });
          },
        });
        ctx.track(dispose);
      }
    },
  };
}

function commandContributionsFor(info: InstalledPluginInfo): KukuPlugin["commands"] {
  if (info.manifest.id === "llmwiki" && info.manifest.sidecars?.llmwiki) {
    return [
      {
        id: "llmwiki.openPanel",
        label: "Toggle LLM Wiki",
        category: "LLM Wiki",
        defaultKeys: ["$mod+Shift+KeyW"],
        global: true,
        execute: () => {
          if (
            layoutState.rightPanelOpen &&
            layoutState.activeRightPanelViewId === "llmwiki.panel"
          ) {
            closeRightPanelView();
          } else {
            openRightPanelView("llmwiki.panel");
          }
        },
      },
      {
        id: "llmwiki.status",
        label: "LLM Wiki: Status",
        category: "LLM Wiki",
        execute: () => {
          void callPluginSidecar("llmwiki", "llmwiki", "status", {}).catch(() => {});
        },
      },
      {
        id: "llmwiki.lint",
        label: "LLM Wiki: Lint",
        category: "LLM Wiki",
        execute: () => {
          void callPluginSidecar("llmwiki", "llmwiki", "lint", {}).catch(() => {});
        },
      },
    ];
  }

  if (info.manifest.id !== "gbrain" || !info.manifest.sidecars?.gbrain) return [];

  return [
    {
      id: "gbrain.openPanel",
      label: "Toggle GBrain",
      category: "GBrain",
      defaultKeys: ["$mod+Shift+KeyB"],
      global: true,
      execute: () => {
        if (layoutState.rightPanelOpen && layoutState.activeRightPanelViewId === "gbrain.panel") {
          closeRightPanelView();
        } else {
          openRightPanelView("gbrain.panel");
        }
      },
    },
    {
      id: "gbrain.version",
      label: "GBrain: Version",
      category: "GBrain",
      execute: () => {
        void callPluginSidecar("gbrain", "gbrain", "version", {}).catch(() => {});
      },
    },
    {
      id: "gbrain.doctor",
      label: "GBrain: Doctor",
      category: "GBrain",
      execute: () => {
        void callPluginSidecar("gbrain", "gbrain", "doctor", {}).catch(() => {});
      },
    },
    {
      id: "gbrain.sync",
      label: "GBrain: Sync",
      category: "GBrain",
      execute: () => {
        void callPluginSidecar("gbrain", "gbrain", "sync", {}).catch(() => {});
      },
    },
  ];
}

export { createThirdPartyPlugin };
