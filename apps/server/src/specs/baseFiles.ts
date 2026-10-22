// Pure helpers for the files a BASE project keeps beside spec.md. Everything here is byte-careful:
// BASE tooling and Par3 both edit these files, so unrelated bytes must survive untouched.

export type JsonObject = Record<string, unknown>;

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The indent of the first indented line, so a rewrite keeps the file's style; two spaces otherwise. */
export function detectIndent(text: string): string {
  return /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
}

export const serializeJson = (value: unknown, indent: string) =>
  JSON.stringify(value, null, indent) + "\n";

/** ISO UTC with the milliseconds stripped, as BASE writes timestamps. */
export const isoSeconds = (iso: string) => iso.replace(/\.\d+Z$/, "Z");

const LINK_SLUG = /^\[([^\]]*)\]\([^)]*\)$/;

function splitLines(text: string): string[] {
  return text.split(/(\r\n|\n|\r)/);
}

// The slug is the row's first cell, plain or as a markdown link; the status is the second cell.
function statusRow(line: string, slug: string): string[] | undefined {
  if (!line.trimStart().startsWith("|")) return undefined;
  const cells = line.split("|");
  if (cells.length < 4) return undefined;
  const first = cells[1]!.trim();
  return first === slug || LINK_SLUG.exec(first)?.[1] === slug ? cells : undefined;
}

/** The trimmed status cell of the slug's row in `_status.md`, or undefined when there is no row. */
export function readStatusTableStatus(text: string, slug: string): string | undefined {
  const parts = splitLines(text);
  for (let index = 0; index < parts.length; index += 2) {
    const cells = statusRow(parts[index]!, slug);
    if (cells) return cells[2]!.trim();
  }
  return undefined;
}

/**
 * Replaces the status cell of the slug's row and nothing else. Returns undefined when the file has
 * no such row, so callers can skip a project that does not keep one.
 */
export function setStatusTableStatus(
  text: string,
  slug: string,
  status: string,
): string | undefined {
  const parts = splitLines(text);
  for (let index = 0; index < parts.length; index += 2) {
    const cells = statusRow(parts[index]!, slug);
    if (!cells) continue;
    const cell = cells[2]!;
    const next = [...cells];
    next[2] =
      cell.trim() === ""
        ? ` ${status} `
        : `${cell.slice(0, cell.length - cell.trimStart().length)}${status}${cell.slice(cell.trimEnd().length)}`;
    parts[index] = next.join("|");
    return parts.join("");
  }
  return undefined;
}

export interface ApprovalEntry {
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly source: "button";
  readonly artifacts: Readonly<Record<string, string>>;
}

/** Appends one entry to the append-only approval log, or undefined when the file is not a log. */
export function appendApproval(existing: string | null, entry: ApprovalEntry): string | undefined {
  if (existing === null) return serializeJson({ approvals: [entry] }, "  ");
  const parsed = parseJsonObject(existing);
  if (!parsed || !Array.isArray(parsed.approvals)) return undefined;
  return serializeJson(
    { ...parsed, approvals: [...(parsed.approvals as unknown[]), entry] },
    detectIndent(existing),
  );
}

/**
 * The newest approval in a log when it covers exactly this spec.md, or undefined. An older entry
 * never counts: BASE appends a new one for every approval, so only the last speaks for the file.
 */
export function currentApproval(
  text: string,
  specSha256: string,
): { readonly confirmedBy: string; readonly confirmedAt: string } | undefined {
  const parsed = parseJsonObject(text);
  if (!parsed || !Array.isArray(parsed.approvals)) return undefined;
  const last: unknown = parsed.approvals.at(-1);
  if (!isJsonObject(last) || !isJsonObject(last.artifacts)) return undefined;
  if (last.artifacts["spec.md"] !== specSha256) return undefined;
  if (typeof last.confirmedBy !== "string" || typeof last.confirmedAt !== "string")
    return undefined;
  return { confirmedBy: last.confirmedBy, confirmedAt: last.confirmedAt };
}

/** status.json after approval: stamp `updated` and clear what the requirements phase awaited. */
export function approvedStatusJson(status: JsonObject, confirmedAt: string): JsonObject {
  const next: JsonObject = { ...status, updated: confirmedAt };
  if (isJsonObject(status.requirements))
    next.requirements = { ...status.requirements, awaiting: "nothing" };
  return next;
}

const messageOf = (item: unknown): string | undefined => {
  if (typeof item === "string") return item;
  if (!isJsonObject(item)) return undefined;
  for (const key of ["message", "msg", "error", "text", "detail"])
    if (typeof item[key] === "string") return item[key];
  return JSON.stringify(item);
};

const severityOf = (item: unknown): string | undefined => {
  if (!isJsonObject(item)) return undefined;
  const value = item.severity ?? item.level;
  return typeof value === "string" ? value.toLowerCase() : undefined;
};

const isError = (item: unknown) => {
  const severity = severityOf(item);
  return severity === undefined || severity === "error" || severity === "critical";
};

/**
 * The error messages a BASE validator reported. The JSON shape is read loosely: an `errors` array,
 * or `issues`/`findings`/`problems` entries whose severity is not a warning. Without usable JSON a
 * non-zero exit is itself the error, carrying the first lines of output. Warnings never count.
 */
export function validatorErrors(output: {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    parsed = undefined;
  }
  const errors: string[] = [];
  const collect = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const message = isError(item) ? messageOf(item) : undefined;
      if (message) errors.push(message);
    }
  };
  if (Array.isArray(parsed)) collect(parsed);
  else if (isJsonObject(parsed)) {
    for (const key of ["errors", "issues", "findings", "problems"]) collect(parsed[key]);
    if (
      !errors.length &&
      (parsed.valid === false || parsed.ok === false || parsed.passed === false)
    )
      errors.push("The validator reported that the spec is invalid.");
  }
  if (errors.length || output.code === 0) return errors;
  const lines = `${output.stderr}\n${output.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  return [lines.length ? lines.join(" ") : `The validator exited with code ${output.code ?? "?"}.`];
}
