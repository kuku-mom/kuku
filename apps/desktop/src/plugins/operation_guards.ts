import type { Disposer } from "~/plugins/types";

export type GuardedOperation =
  | { kind: "close-tab"; tabId: string }
  | { kind: "change-path"; path: string }
  | { kind: "change-vault" }
  | { kind: "exit" };

interface OperationGuard {
  matches(operation: GuardedOperation): boolean;
  confirm(operation: GuardedOperation): Promise<boolean>;
}

const guards = new Set<OperationGuard>();

export function registerOperationGuard(guard: OperationGuard): Disposer {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

export function hasOperationGuard(operation: GuardedOperation): boolean {
  return [...guards].some((guard) => guard.matches(operation));
}

export async function allowOperation(operation: GuardedOperation): Promise<boolean> {
  for (const guard of guards) {
    if (guard.matches(operation) && !(await guard.confirm(operation))) return false;
  }
  return true;
}
