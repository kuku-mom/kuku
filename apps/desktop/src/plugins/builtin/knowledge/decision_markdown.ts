import type { Code, RootContent } from "mdast";

import type { MdastToPmBlockHandler, PMNodeJSON, PmToMdastBlockHandler } from "~/lib/markdown";

interface KukuDecisionOption {
  id: string;
  label: string;
  requires_input?: boolean;
}

interface KukuDecisionAttrs {
  id: string;
  proposalId: string;
  targetChangeId: string;
  question: string;
  selectionMode: string;
  required: boolean;
  status: string;
  selectedOptionId?: string;
  options: KukuDecisionOption[];
  otherText?: string;
  resolvedAt?: string;
}

type ParsedDecisionYaml = Omit<
  KukuDecisionAttrs,
  | "proposalId"
  | "targetChangeId"
  | "selectionMode"
  | "selectedOptionId"
  | "otherText"
  | "resolvedAt"
> & {
  proposal_id: string;
  target_change_id: string;
  selection_mode: string;
  selected_option_id?: string;
  other_text?: string;
  resolved_at?: string;
};

const KUKU_DECISION_LANGUAGE = "kuku-decision";

const kukuDecisionMdastHandler: MdastToPmBlockHandler = (node) => {
  const code = node as Code;
  if (code.lang !== KUKU_DECISION_LANGUAGE) {
    return codeBlockPmNode(code);
  }

  const attrs = parseKukuDecisionYaml(code.value);
  if (!attrs) {
    return codeBlockPmNode(code);
  }
  const result: PMNodeJSON = {
    type: "kukuDecision",
    attrs: attrs as unknown as Record<string, unknown>,
  };
  return [result];
};

const kukuDecisionPmHandler: PmToMdastBlockHandler = (node) => {
  const attrs = normalizeDecisionAttrs(node.attrs ?? {});
  if (!attrs) return null;
  const result: Code = {
    type: "code",
    lang: KUKU_DECISION_LANGUAGE,
    value: stringifyKukuDecisionYaml(attrs).trimEnd(),
  };
  return result as RootContent;
};

function codeBlockPmNode(code: Code): PMNodeJSON[] {
  const result: PMNodeJSON = {
    type: "codeBlock",
    attrs: { language: code.lang ?? "" },
  };
  if (code.value) {
    result.content = [{ type: "text", text: code.value }];
  }
  return [result];
}

function parseKukuDecisionYaml(value: string): KukuDecisionAttrs | null {
  const parsed = parseDecisionYamlObject(value);
  if (!parsed) return null;

  const attrs: KukuDecisionAttrs = {
    id: parsed.id,
    proposalId: parsed.proposal_id,
    targetChangeId: parsed.target_change_id,
    question: parsed.question,
    selectionMode: parsed.selection_mode,
    required: parsed.required,
    status: parsed.status,
    selectedOptionId: parsed.selected_option_id,
    options: parsed.options,
    otherText: parsed.other_text,
    resolvedAt: parsed.resolved_at,
  };
  return normalizeDecisionAttrs(attrs as unknown as Record<string, unknown>);
}

function parseDecisionYamlObject(value: string): ParsedDecisionYaml | null {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const result: Partial<ParsedDecisionYaml> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;

    const field = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!field) continue;

    const key = field[1] as keyof ParsedDecisionYaml;
    const rawValue = field[2].trimStart();

    if (key === "options") {
      const parsed = parseDecisionOptions(lines, index + 1);
      result.options = parsed.options;
      index = parsed.nextIndex - 1;
      continue;
    }

    if (rawValue === "|" || rawValue === "|-") {
      const parsed = parseIndentedBlock(lines, index + 1);
      assignParsedScalar(result, key, parsed.value);
      index = parsed.nextIndex - 1;
      continue;
    }

    assignParsedScalar(result, key, parseYamlScalar(rawValue));
  }

  return normalizeParsedDecision(result);
}

function parseDecisionOptions(
  lines: string[],
  startIndex: number,
): { options: KukuDecisionOption[]; nextIndex: number } {
  const options: KukuDecisionOption[] = [];
  let current: Partial<KukuDecisionOption> | null = null;
  let index = startIndex;

  function flushCurrent() {
    if (typeof current?.id === "string" && typeof current.label === "string") {
      options.push({
        id: current.id,
        label: current.label,
        ...(current.requires_input ? { requires_input: true } : {}),
      });
    }
    current = null;
  }

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(line)) break;

    const optionStart = /^\s*-\s+([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (optionStart) {
      flushCurrent();
      current = {};
      assignOptionScalar(current, optionStart[1], parseYamlScalar(optionStart[2].trimStart()));
      continue;
    }

    const optionField = /^\s+([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (optionField && current) {
      assignOptionScalar(current, optionField[1], parseYamlScalar(optionField[2].trimStart()));
    }
  }

  flushCurrent();
  return { options, nextIndex: index };
}

function parseIndentedBlock(
  lines: string[],
  startIndex: number,
): { value: string; nextIndex: number } {
  const block: string[] = [];
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !/^\s/.test(line)) break;
    block.push(line.startsWith("  ") ? line.slice(2) : line);
  }
  return { value: block.join("\n"), nextIndex: index };
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function assignParsedScalar(
  result: Partial<ParsedDecisionYaml>,
  key: keyof ParsedDecisionYaml,
  value: unknown,
): void {
  if (key === "required") {
    result.required = value === true || value === "true";
    return;
  }
  if (key === "options") return;
  if (typeof value === "string" && value.length > 0) {
    (result as Record<string, unknown>)[key] = value;
  }
}

function assignOptionScalar(
  option: Partial<KukuDecisionOption>,
  key: string,
  value: unknown,
): void {
  if (key === "id" && typeof value === "string") option.id = value;
  if (key === "label" && typeof value === "string") option.label = value;
  if (key === "requires_input") option.requires_input = value === true || value === "true";
}

function normalizeParsedDecision(value: Partial<ParsedDecisionYaml>): ParsedDecisionYaml | null {
  if (
    typeof value.id !== "string" ||
    typeof value.proposal_id !== "string" ||
    typeof value.target_change_id !== "string" ||
    typeof value.question !== "string" ||
    typeof value.selection_mode !== "string" ||
    typeof value.required !== "boolean" ||
    typeof value.status !== "string" ||
    !Array.isArray(value.options)
  ) {
    return null;
  }

  return {
    id: value.id,
    proposal_id: value.proposal_id,
    target_change_id: value.target_change_id,
    question: value.question,
    selection_mode: value.selection_mode,
    required: value.required,
    status: value.status,
    selected_option_id: value.selected_option_id,
    options: value.options,
    other_text: value.other_text,
    resolved_at: value.resolved_at,
  };
}

function normalizeDecisionAttrs(attrs: Record<string, unknown>): KukuDecisionAttrs | null {
  if (
    typeof attrs.id !== "string" ||
    typeof attrs.proposalId !== "string" ||
    typeof attrs.targetChangeId !== "string" ||
    typeof attrs.question !== "string" ||
    typeof attrs.selectionMode !== "string" ||
    typeof attrs.required !== "boolean" ||
    typeof attrs.status !== "string" ||
    !Array.isArray(attrs.options)
  ) {
    return null;
  }

  const options = attrs.options.filter(isDecisionOption);
  if (options.length === 0) return null;

  return {
    id: attrs.id,
    proposalId: attrs.proposalId,
    targetChangeId: attrs.targetChangeId,
    question: attrs.question,
    selectionMode: attrs.selectionMode,
    required: attrs.required,
    status: attrs.status,
    selectedOptionId:
      typeof attrs.selectedOptionId === "string" && attrs.selectedOptionId.length > 0
        ? attrs.selectedOptionId
        : undefined,
    options,
    otherText:
      typeof attrs.otherText === "string" && attrs.otherText.length > 0
        ? attrs.otherText
        : undefined,
    resolvedAt:
      typeof attrs.resolvedAt === "string" && attrs.resolvedAt.length > 0
        ? attrs.resolvedAt
        : undefined,
  };
}

function isDecisionOption(value: unknown): value is KukuDecisionOption {
  if (!value || typeof value !== "object") return false;
  const option = value as Record<string, unknown>;
  return typeof option.id === "string" && typeof option.label === "string";
}

function stringifyKukuDecisionYaml(attrs: KukuDecisionAttrs): string {
  const lines: string[] = [
    `id: ${formatScalar(attrs.id)}`,
    `proposal_id: ${formatScalar(attrs.proposalId)}`,
    `target_change_id: ${formatScalar(attrs.targetChangeId)}`,
    `question: ${formatScalar(attrs.question)}`,
    `selection_mode: ${formatScalar(attrs.selectionMode)}`,
    `required: ${attrs.required ? "true" : "false"}`,
    `status: ${formatScalar(attrs.status)}`,
  ];

  if (attrs.selectedOptionId) {
    lines.push(`selected_option_id: ${formatScalar(attrs.selectedOptionId)}`);
  }

  lines.push("options:");
  for (const option of attrs.options) {
    lines.push(`- id: ${formatScalar(option.id)}`);
    lines.push(`  label: ${formatScalar(option.label)}`);
    if (option.requires_input) {
      lines.push("  requires_input: true");
    }
  }

  if (attrs.otherText) {
    lines.push(...formatStringField("other_text", attrs.otherText));
  }
  if (attrs.resolvedAt) {
    lines.push(`resolved_at: ${formatScalar(attrs.resolvedAt)}`);
  }

  return `${lines.join("\n")}\n`;
}

function formatStringField(key: string, value: string): string[] {
  if (!value.includes("\n")) {
    return [`${key}: ${formatScalar(value)}`];
  }
  const block = value.split("\n").map((line) => `  ${line}`);
  return [`${key}: |-`, ...block];
}

function formatScalar(value: string): string {
  if (
    /^[A-Za-z0-9_./ -]+$/.test(value) &&
    value.trim() === value &&
    !value.includes(": ") &&
    !/^(true|false|null|~)$/i.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

export {
  KUKU_DECISION_LANGUAGE,
  kukuDecisionMdastHandler,
  kukuDecisionPmHandler,
  parseKukuDecisionYaml,
  stringifyKukuDecisionYaml,
};
export type { KukuDecisionAttrs, KukuDecisionOption };
