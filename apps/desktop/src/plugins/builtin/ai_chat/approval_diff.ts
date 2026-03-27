import { readVaultFile } from "~/lib/vault_fs";
import { openDiffView } from "~/plugins/builtin/diff_view";
import { createDiffTabPath } from "~/stores/diff_store";
import { closeTab, filesState, openTab } from "~/stores/files";

interface EditFileDiffTarget {
  path: string;
  newMarkdown: string;
}

function getEditFileDiffTarget(mutation: Record<string, unknown>): EditFileDiffTarget | null {
  const operations = mutation.operations;
  if (!Array.isArray(operations) || operations.length !== 1) {
    return null;
  }

  const [operation] = operations;
  if (!operation || typeof operation !== "object") {
    return null;
  }

  const candidate = operation as Record<string, unknown>;
  if (candidate.kind !== "replaceFile") {
    return null;
  }

  const path = candidate.path;
  const content = candidate.content;

  if (typeof path !== "string" || typeof content !== "string") {
    return null;
  }

  return {
    path,
    newMarkdown: content,
  };
}

function canOpenApprovalDiff(mutation: Record<string, unknown>, toolName: string): boolean {
  return toolName === "edit_file" && getEditFileDiffTarget(mutation) !== null;
}

async function openApprovalDiff(
  mutation: Record<string, unknown>,
  toolName: string,
): Promise<void> {
  if (toolName !== "edit_file") {
    return;
  }

  const target = getEditFileDiffTarget(mutation);
  if (!target) {
    return;
  }

  try {
    const oldMarkdown = await readVaultFile(target.path);
    openDiffView(target.path, oldMarkdown, target.newMarkdown);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[ai-chat] failed to open approval diff", error);
  }
}

/**
 * Close the diff tab (if open) for the given mutation and open the real file.
 * Called when an approval is resolved (Approve or Reject).
 */
function closeApprovalDiff(mutation: Record<string, unknown>, toolName: string): void {
  if (toolName !== "edit_file") return;

  const target = getEditFileDiffTarget(mutation);
  if (!target) return;

  // Close the diff tab
  const diffTabPath = createDiffTabPath(target.path);
  const diffTab = filesState.tabs.find((t) => t.filePath === diffTabPath);
  if (diffTab) {
    closeTab(diffTab.id);
  }

  // Close existing editor tab so its cached content is purged,
  // forcing the editor to reload the file from disk when reopened.
  const existingEditorTab = filesState.tabs.find(
    (t) => t.filePath === target.path && t.type === "editor",
  );
  if (existingEditorTab) {
    closeTab(existingEditorTab.id);
  }

  // Open a fresh tab — reads from disk since cache was purged
  const fileName = target.path.split("/").at(-1) ?? target.path;
  openTab(fileName, target.path, "editor");
}

export { canOpenApprovalDiff, closeApprovalDiff, getEditFileDiffTarget, openApprovalDiff };
