import type { Disposer } from "~/plugins/types";

interface ProxyToolCallPayload {
  sessionId: string;
  callId: string;
  toolName: string;
  toolId?: string;
  access?: ProxyToolAccess;
  arguments: Record<string, unknown>;
}

type ProxyToolAccess = "readOnly" | "proposesMutation";

interface ProxyToolSpec {
  name: string;
  toolId: string;
  description: string;
  parameters: Record<string, unknown>;
  category: string;
  aiEnabled?: boolean;
  access?: ProxyToolAccess;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

interface ProxyToolDescriptor {
  name: string;
  toolId: string;
  description: string;
  parameters: Record<string, unknown>;
  category: string;
  aiEnabled?: boolean;
  access?: ProxyToolAccess;
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
