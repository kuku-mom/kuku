import type { PluginContext } from "~/plugins/types";

import { sameInstant, validEventRef, validTaskRef } from "./bindings";
import { PROVIDERS, type ExternalItem, type ItemPatch, type PendingOperation } from "./types";

const queues = new Map<string, Promise<void>>();
const knownIds = new WeakMap<PendingOperation[], Set<string>>();
/** Device-local filename; the file also checks the full vault path, so a hash
 * collision can never replay another vault's operations. */
export function journalPath(root: string): string {
  let hash = 14695981039346656037n;
  for (const char of root)
    hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * 1099511628211n);
  return `write-journal-${hash.toString(16)}.json`;
}
function validOperation(value: unknown): value is PendingOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const operation = value as PendingOperation;
  return (
    typeof operation.id === "string" &&
    !!operation.id &&
    ["create", "update", "delete"].includes(operation.type) &&
    PROVIDERS.includes(operation.provider) &&
    typeof operation.calendarId === "string" &&
    !!operation.calendarId &&
    ["remote", "local"].includes(operation.stage) &&
    ["pending", "failed", "conflict"].includes(operation.status) &&
    Number.isInteger(operation.attempts) &&
    operation.attempts >= 0 &&
    typeof operation.createdAt === "string" &&
    (!operation.eventRef ||
      (validEventRef(operation.eventRef) &&
        operation.eventRef.provider === operation.provider &&
        operation.eventRef.calendarId === operation.calendarId)) &&
    (!operation.task || validTaskRef(operation.task)) &&
    (operation.type === "create"
      ? !!operation.draft && typeof operation.draft.title === "string"
      : !!operation.eventRef) &&
    (operation.type !== "update" || !!operation.patch)
  );
}
export async function loadOperations(
  fs: PluginContext["fs"],
  root: string,
): Promise<PendingOperation[]> {
  const path = journalPath(root);
  await queues.get(path)?.catch(() => {});
  if (!(await fs.exists(path))) {
    const empty: PendingOperation[] = [];
    knownIds.set(empty, new Set());
    return empty;
  }
  const value: unknown = JSON.parse(await fs.readFile(path));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Planner retry journal.");
  const journal = value as { version?: number; vaultRoot?: string; operations?: unknown };
  if (
    journal.version !== 1 ||
    journal.vaultRoot !== root ||
    !Array.isArray(journal.operations) ||
    !journal.operations.every(validOperation) ||
    new Set(journal.operations.map((op) => op.id)).size !== journal.operations.length
  )
    throw new Error(
      "Planner retry journal does not match this vault or contains invalid operations.",
    );
  const operations = journal.operations.map((operation) => ({
    ...operation,
    status: operation.status === "pending" ? ("failed" as const) : operation.status,
    error:
      operation.error ?? "The previous operation was interrupted. Retry to recover its result.",
  }));
  knownIds.set(operations, new Set(operations.map((operation) => operation.id)));
  return operations;
}
export function saveOperations(
  fs: PluginContext["fs"],
  root: string,
  operations: PendingOperation[],
): Promise<void> {
  const path = journalPath(root);
  const operation = (queues.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      // An old plugin instance can receive a native response after reactivation.
      // Merge operations it has never seen instead of overwriting the new queue.
      let latest: PendingOperation[] = [];
      if (await fs.exists(path)) {
        const current = JSON.parse(await fs.readFile(path));
        if (
          current.version !== 1 ||
          current.vaultRoot !== root ||
          !Array.isArray(current.operations) ||
          !current.operations.every(validOperation)
        )
          throw new Error("Planner retry journal is invalid.");
        latest = current.operations;
      }
      const known = knownIds.get(operations) ?? new Set<string>();
      const desired = new Map(operations.map((value) => [value.id, value]));
      const unseen = latest.filter((value) => !known.has(value.id) && !desired.has(value.id));
      for (const current of latest) {
        const requested = desired.get(current.id);
        if (requested && current.attempts > requested.attempts) desired.set(current.id, current);
      }
      operations.splice(0, operations.length, ...unseen, ...desired.values());
      await fs.writeFile(path, JSON.stringify({ version: 1, vaultRoot: root, operations }));
      knownIds.set(operations, new Set(operations.map((value) => value.id)));
    });
  queues.set(path, operation);
  void operation
    .finally(() => {
      if (queues.get(path) === operation) queues.delete(path);
    })
    .catch(() => {});
  return operation;
}
/** Before retrying a versioned update, recover a lost successful response by
 * checking only the fields that were actually requested by this operation. */
export function patchMatches(item: ExternalItem, patch: ItemPatch): boolean {
  return Object.entries(patch).every(([key, expected]) => {
    if (expected === undefined) return true;
    const actual = item[key as keyof ItemPatch];
    if ((key === "start" || key === "end") && typeof expected === "string")
      return sameInstant(actual as string | undefined, expected);
    if (expected === null) return actual === undefined || actual === null || actual === "";
    return actual === expected;
  });
}
export function operationFailure(error: unknown): "failed" | "conflict" {
  const message = error instanceof Error ? error.message : String(error);
  return /\bCONFLICT\b|\b412\b|duplicate|ambiguous/i.test(message) ? "conflict" : "failed";
}
