import type { PluginContext } from "~/plugins/types";

import { canonical, PlannerAiError } from "./ai_tools_validation";
import { PROVIDERS, type EventRef } from "./types";

export type PlannerCreationLocator =
  | { kind: "task"; taskId: string; path: string }
  | { kind: "item"; eventRef: EventRef }
  | { kind: "note"; path: string };
type RequestStore = Pick<PluginContext["fs"], "exists" | "readFile" | "writeFile">;
interface Receipt {
  version: 1;
  root: string;
  requestId: string;
  fingerprint: string;
  status: "started" | "completed";
  createdAt: string;
  result?: PlannerCreationLocator;
}
function validLocator(value: unknown): value is PlannerCreationLocator {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const path = (value: unknown) =>
    typeof value === "string" &&
    !!value &&
    !value.startsWith("/") &&
    !value.split("/").includes("..") &&
    !value.includes("\u0000");
  if (entry.kind === "note") return path(entry.path);
  if (entry.kind === "task")
    return path(entry.path) && typeof entry.taskId === "string" && !!entry.taskId;
  if (entry.kind !== "item" || !entry.eventRef || typeof entry.eventRef !== "object") return false;
  const ref = entry.eventRef as Record<string, unknown>;
  return (
    PROVIDERS.includes(ref.provider as EventRef["provider"]) &&
    typeof ref.calendarId === "string" &&
    !!ref.calendarId &&
    typeof ref.itemId === "string" &&
    !!ref.itemId &&
    ["version", "occurrence", "externalId", "start", "end"].every(
      (key) => ref[key] === undefined || typeof ref[key] === "string",
    )
  );
}
async function digest(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A started receipt is deliberately not replayable after a restart: the service
 * may already have created the item even if no response reached this process. */
export class PlannerRequestReceipts {
  private readonly store?: RequestStore;
  private readonly pending = new Map<
    string,
    { payload: string; promise: Promise<PlannerCreationLocator> }
  >();
  constructor(store?: RequestStore) {
    this.store = store;
  }

  async run(
    root: string,
    requestId: string,
    payload: unknown,
    assertCurrent: () => void,
    create: () => Promise<PlannerCreationLocator>,
  ) {
    const key = canonical([root, requestId]);
    const encoded = canonical(payload);
    const existing = this.pending.get(key);
    if (existing) {
      if (existing.payload !== encoded)
        throw new PlannerAiError(
          "REQUEST_ID_CONFLICT",
          "This request_id was already used for different creation arguments.",
        );
      const result = await existing.promise;
      assertCurrent();
      return { result, replayed: true, durable: !!this.store };
    }
    let replayed = false;
    const promise = (async () => {
      const file = `ai-request-${await digest(key)}.json`;
      const fingerprint = await digest(encoded);
      assertCurrent();
      if (this.store && (await this.store.exists(file))) {
        let receipt: Receipt;
        try {
          receipt = JSON.parse(await this.store.readFile(file));
        } catch {
          throw new PlannerAiError(
            "UNKNOWN_OUTCOME",
            "The saved creation receipt could not be read. Review Planner before creating again.",
          );
        }
        assertCurrent();
        if (
          !receipt ||
          typeof receipt !== "object" ||
          receipt.version !== 1 ||
          receipt.root !== root ||
          receipt.requestId !== requestId
        )
          throw new PlannerAiError(
            "UNKNOWN_OUTCOME",
            "The saved creation receipt does not match this vault. No creation was attempted.",
          );
        if (receipt.fingerprint !== fingerprint)
          throw new PlannerAiError(
            "REQUEST_ID_CONFLICT",
            "This request_id was already used for different creation arguments.",
          );
        if (receipt.status !== "completed" || !validLocator(receipt.result))
          throw new PlannerAiError(
            "UNKNOWN_OUTCOME",
            "This creation started previously but its result is uncertain. Review Planner and its pending operations; do not repeat it with a new request_id.",
          );
        replayed = true;
        return receipt.result;
      }
      const receipt: Receipt = {
        version: 1,
        root,
        requestId,
        fingerprint,
        status: "started",
        createdAt: new Date().toISOString(),
      };
      if (this.store) await this.store.writeFile(file, JSON.stringify(receipt));
      assertCurrent();
      const result = await create();
      assertCurrent();
      if (this.store)
        await this.store.writeFile(
          file,
          JSON.stringify({ ...receipt, status: "completed", result }),
        );
      assertCurrent();
      return result;
    })();
    this.pending.set(key, { payload: encoded, promise });
    return { result: await promise, replayed, durable: !!this.store };
  }
}
