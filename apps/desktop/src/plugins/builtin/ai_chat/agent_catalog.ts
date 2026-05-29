import type { AgentDescriptor } from "./types";

const KUKU_NATIVE_AGENT_ID = "kuku-native";

const BUILTIN_AGENT_CATALOG: AgentDescriptor[] = [
  {
    id: KUKU_NATIVE_AGENT_ID,
    label: "Kuku Agent",
    kind: "native",
    enabled: true,
    managed: true,
  },
  {
    id: "claude-acp",
    label: "Claude Agent",
    kind: "acp",
    enabled: false,
    managed: true,
  },
  {
    id: "codex-acp",
    label: "Codex CLI",
    kind: "acp",
    enabled: false,
    managed: true,
  },
  {
    id: "gemini-acp",
    label: "Gemini CLI",
    kind: "acp",
    enabled: false,
    managed: true,
  },
];

export { BUILTIN_AGENT_CATALOG, KUKU_NATIVE_AGENT_ID };
