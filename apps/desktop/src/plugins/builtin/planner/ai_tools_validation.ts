export class PlannerAiError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PlannerAiError";
    this.code = code;
    this.details = details;
  }
}

export function invalid(message: string): never {
  throw new PlannerAiError("INVALID_ARGUMENT", message);
}
export function object(
  value: unknown,
  allowed: readonly string[],
  name = "arguments",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${name} must be an object.`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result))
    if (!allowed.includes(key)) invalid(`Unknown ${name} field: ${key}.`);
  return result;
}
export function text(value: unknown, name: string, max = 500, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    value.includes("\0") ||
    (!empty && !value.trim())
  )
    invalid(`${name} must be ${empty ? "a" : "a nonempty"} string of at most ${max} characters.`);
  return value;
}
export function title(value: unknown): string {
  const result = text(value, "title");
  if (/[\r\n]/.test(result)) invalid("title must be a single line.");
  return result.trim();
}
export function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") invalid(`${name} must be a boolean.`);
  return value;
}
export function choice<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T))
    invalid(`${name} must be one of: ${values.join(", ")}.`);
  return value as T;
}
export function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    invalid(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}
export function date(value: unknown, name: string): string {
  const result = text(value, name, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    !Number.isFinite(Date.parse(`${result}T00:00:00Z`)) ||
    new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result
  )
    invalid(`${name} must be a valid YYYY-MM-DD date.`);
  return result;
}
export function instant(value: unknown, name: string): string {
  const result = text(value, name, 45);
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      result,
    ) ||
    !Number.isFinite(Date.parse(result))
  )
    invalid(`${name} must be an ISO timestamp with an explicit UTC offset.`);
  date(result.slice(0, 10), name);
  return new Date(result).toISOString();
}
export function timeZone(value: unknown): string {
  const result = text(value, "time_zone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: result }).format();
  } catch {
    invalid("time_zone must be a supported IANA time zone.");
  }
  return result;
}
export function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
export function copy<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
export function schema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
export const stringSchema = { type: "string" };
export const refSchema = {
  type: "string",
  description:
    "Opaque reference returned by this Planner tool session; never construct one from a title or path.",
};
export const revisionSchema = {
  type: "string",
  description: "Exact revision returned with the reference. Re-read after a stale-reference error.",
};
export const requestSchema = {
  type: "string",
  minLength: 8,
  maxLength: 120,
  description:
    "Stable identifier for this one creation request. Reuse exactly on retries; do not use a new ID after an uncertain outcome.",
};
