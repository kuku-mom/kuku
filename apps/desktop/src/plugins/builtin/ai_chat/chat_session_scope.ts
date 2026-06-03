const CHAT_SESSIONS_STORAGE_KEY = "kuku.aiChat.sessions.v1";
const NO_VAULT_SESSION_SCOPE = "no-vault";

interface ChatSessionVaultScoped {
  workingDirectory?: string | null;
}

function normalizeChatSessionVaultRoot(root: string | null | undefined): string | null {
  if (typeof root !== "string") return null;
  const normalized = normalizeVaultRootPath(root);
  return normalized || null;
}

function normalizeVaultRootPath(root: string): string {
  const normalized = root.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  if (normalized === "/") return normalized;
  if (/^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/g, "");
}

function chatSessionStorageKey(vaultRoot: string | null): string {
  return `${CHAT_SESSIONS_STORAGE_KEY}:${encodeURIComponent(vaultRoot ?? NO_VAULT_SESSION_SCOPE)}`;
}

function chatSessionMatchesVaultRoot(
  session: ChatSessionVaultScoped,
  vaultRoot: string | null,
): boolean {
  return normalizeChatSessionVaultRoot(session.workingDirectory) === vaultRoot;
}

function filterForChatSessionVaultRoot<T extends ChatSessionVaultScoped>(
  sessions: T[],
  vaultRoot: string | null,
): T[] {
  return sessions.filter((session) => chatSessionMatchesVaultRoot(session, vaultRoot));
}

export {
  CHAT_SESSIONS_STORAGE_KEY,
  chatSessionMatchesVaultRoot,
  chatSessionStorageKey,
  filterForChatSessionVaultRoot,
  normalizeChatSessionVaultRoot,
  normalizeVaultRootPath,
};
