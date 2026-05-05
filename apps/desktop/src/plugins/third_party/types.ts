interface ThirdPartyPluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  kind: "third-party";
  permissions?: {
    sidecar?: boolean;
    vaultRead?: boolean;
    vaultWrite?: boolean;
    network?: boolean;
  };
  sidecars?: Record<
    string,
    {
      path: string;
      commands: Record<string, string[] | { args: string[]; stdin?: string }>;
    }
  >;
  skills?: string[];
  aiTools?: ThirdPartyAiToolManifest[];
  settingsSchema?: Record<string, unknown>;
}

interface ThirdPartyAiToolManifest {
  name: string;
  toolId?: string;
  description: string;
  parameters: Record<string, unknown>;
  category?: string;
  sidecar: string;
  operation: string;
  access?: "read" | "write" | "admin";
  modes?: ("ask" | "agent" | "inline")[];
}

interface InstalledPluginInfo {
  manifest: ThirdPartyPluginManifest;
  installedPath: string;
  packagePath: string;
}

export type { InstalledPluginInfo, ThirdPartyAiToolManifest, ThirdPartyPluginManifest };
