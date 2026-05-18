import type { Disposer } from "~/plugins/types";

interface ProxyToolCallPayload {
  sessionId: string;
  callId: string;
  toolName: string;
  toolId?: string;
  arguments: Record<string, unknown>;
}

type ProxyToolAccess = "readOnly" | "proposesMutation";
type ProxyToolKind = "read" | "search" | "edit" | "proposal" | "navigation" | "other";
type ProxyToolRiskLevel = "low" | "medium" | "high";
type ProxyToolModeAvailability = "ask" | "agent" | "inline";

interface ProxyToolSpec {
  name: string;
  toolId: string;
  description: string;
  parameters: Record<string, unknown>;
  category: string;
  access?: ProxyToolAccess;
  kind?: ProxyToolKind;
  riskLevel?: ProxyToolRiskLevel;
  requiresApproval?: boolean;
  modeAvailability?: ProxyToolModeAvailability[];
  permissionRuleKey?: string;
  aiEnabled?: boolean;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

interface ProxyToolDescriptor {
  name: string;
  toolId: string;
  description: string;
  parameters: Record<string, unknown>;
  category: string;
  access?: ProxyToolAccess;
  kind?: ProxyToolKind;
  riskLevel?: ProxyToolRiskLevel;
  requiresApproval?: boolean;
  modeAvailability?: ProxyToolModeAvailability[];
  permissionRuleKey?: string;
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
  ProxyToolKind,
  ProxyToolModeAvailability,
  ProxyToolRiskLevel,
  ProxyToolSpec,
};
