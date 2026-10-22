import { SpecStatus } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isSpecStatus = Schema.is(SpecStatus);

interface Line {
  readonly text: string;
  readonly eol: string;
}

function lines(content: string): Line[] {
  return [...content.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => ({ text: match[1]!, eol: match[2]! }));
}

/** Frontmatter is the leading `---` block; a spec with no closing fence has none. */
function frontmatterBounds(all: readonly Line[]) {
  if (all[0]?.text.trimEnd() !== "---") return undefined;
  const close = all.findIndex((line, index) => index > 0 && line.text.trimEnd() === "---");
  return close === -1 ? undefined : { open: 0, close };
}

// Only a column-zero key counts: nested children such as `  status:` under another key are not ours.
// The value token is replaced alone so padding and a trailing `# ...` comment survive byte for byte.
const STATUS_LINE = /^(status:[ \t]*)("[^"]*"|'[^']*'|[^\s#"'][^\s#]*)?(.*)$/;

function statusLine(all: readonly Line[], bounds: { open: number; close: number }) {
  for (let index = bounds.open + 1; index < bounds.close; index += 1) {
    const match = STATUS_LINE.exec(all[index]!.text);
    if (match) return { index, prefix: match[1]!, value: match[2], rest: match[3]! };
  }
  return undefined;
}

const unquote = (token: string) =>
  /^(["']).*\1$/.test(token) && token.length >= 2 ? token.slice(1, -1) : token;

/** The raw top-level frontmatter `status:` value, or undefined when there is none. */
export function readFrontmatterStatus(content: string): string | undefined {
  const all = lines(content);
  const bounds = frontmatterBounds(all);
  const found = bounds && statusLine(all, bounds);
  return found?.value === undefined ? undefined : unquote(found.value).trim();
}

/** The frontmatter status when it names a lifecycle status Par3 knows. */
export function readFrontmatterLifecycleStatus(content: string): SpecStatus | undefined {
  const value = readFrontmatterStatus(content);
  return value !== undefined && isSpecStatus(value) ? value : undefined;
}

/**
 * Sets the frontmatter `status:` value and leaves every other byte alone. Content without
 * frontmatter is returned unchanged: Par3 does not add a header to a document that has none.
 */
export function setFrontmatterStatus(content: string, status: SpecStatus): string {
  const all = lines(content);
  const bounds = frontmatterBounds(all);
  if (!bounds) return content;
  const found = statusLine(all, bounds);
  const next = [...all];
  if (!found) {
    next.splice(bounds.close, 0, { text: `status: ${status}`, eol: all[bounds.open]!.eol });
  } else if (found.value === undefined) {
    const comment = found.rest.trimStart().startsWith("#") ? ` ${found.rest.trimStart()}` : "";
    next[found.index] = { ...all[found.index]!, text: `status: ${status}${comment}` };
  } else {
    const quote = /^["']/.test(found.value) ? found.value[0]! : "";
    next[found.index] = {
      ...all[found.index]!,
      text: `${found.prefix}${quote}${status}${quote}${found.rest}`,
    };
  }
  return next.map((line) => line.text + line.eol).join("");
}

// BASE tooling rewrites these on every edit, so neither is a change to the requirements.
const VOLATILE_KEYS = ["status", "updated"];

/** The content without the volatile top-level frontmatter lines, for hashing the requirements. */
export function withoutVolatileFrontmatter(content: string): string {
  const all = lines(content);
  const bounds = frontmatterBounds(all);
  if (!bounds) return content;
  const volatile = (text: string) => VOLATILE_KEYS.some((key) => text.startsWith(`${key}:`));
  return all
    .filter((line, index) => index <= bounds.open || index >= bounds.close || !volatile(line.text))
    .map((line) => line.text + line.eol)
    .join("");
}

/** The content after any frontmatter, for reading the title and headings. */
export function withoutFrontmatter(content: string): string {
  const all = lines(content);
  const bounds = frontmatterBounds(all);
  if (!bounds) return content;
  return all
    .slice(bounds.close + 1)
    .map((line) => line.text + line.eol)
    .join("");
}
