import type { Disposer } from "~/plugins/types";

interface ProxyToolCallPayload {
  sessionId: string;
  callId: string;
  toolName: string;
  toolId?: string;
  arguments: Record<string, unknown>;
}

type ProxyToolAccess = "readOnly" | "proposesMutation";

interface ProxyToolSpec {
  name: string;
  toolId: string;
  description: string;
  parameters: Record<string, unknown>;
  category: string;
  access?: ProxyToolAccess;
  aiEnabled?: boolean;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

interface ProxyToolDescriptor {
  name: string;
  toolId: string;
  description: string;
  parameters: Record<string, unknown>;
  category: string;
  access: ProxyToolAccess;
  aiEnabled?: boolean;
}

interface AiProxyToolRegistry {
  register(tool: ProxyToolSpec): Disposer;
  list(): ProxyToolDescriptor[];
  getHandler(name: string): ProxyToolSpec["handler"] | undefined;
  subscribe(listener: () => void): Disposer;
}

export type {
  AiProxyToolRegistry,
  ProxyToolAccess,
  ProxyToolCallPayload,
  ProxyToolDescriptor,
  ProxyToolSpec,
};
