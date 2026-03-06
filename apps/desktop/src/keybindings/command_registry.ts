// ── Types ──

interface Command {
  id: string;
  label: string;
  execute: () => void;
}

// ── Registry ──

const registry = new Map<string, Command>();

function registerCommand(command: Command): void {
  registry.set(command.id, command);
}

function unregisterCommand(id: string): void {
  registry.delete(id);
}

function executeCommand(id: string): boolean {
  const command = registry.get(id);
  if (!command) return false;
  command.execute();
  return true;
}

// ── Exports ──

export { executeCommand, registerCommand, unregisterCommand };
export type { Command };
