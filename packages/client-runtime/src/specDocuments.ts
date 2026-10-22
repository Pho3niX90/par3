// Helpers for the markdown of a BASE spec's documents: finding the source line behind a rendered
// checkbox, the section a remark belongs to, and where a selection came from. Line numbers are
// 1-based and count the same line breaks the server does (`\r\n`, `\n` or `\r`).

const LINE_BREAK = /\r\n|\n|\r/g;

/** The leading `---` block removed, with how many lines it took so source lines can be restored. */
export function splitFrontmatter(content: string): { body: string; lineOffset: number } {
  const lines = content.split(/(\r\n|\n|\r)/);
  if (lines[0]?.trimEnd() !== "---") return { body: content, lineOffset: 0 };
  for (let index = 2; index < lines.length; index += 2) {
    if (lines[index]!.trimEnd() === "---") {
      const consumed = lines.slice(0, index + 2).join("");
      return { body: content.slice(consumed.length), lineOffset: (index + 2) / 2 };
    }
  }
  return { body: content, lineOffset: 0 };
}

/** The line holding an offset, with its text (without the line break). */
export function lineAtOffset(source: string, offset: number): { line: number; text: string } {
  const at = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let start = 0;
  for (const match of source.matchAll(LINE_BREAK)) {
    const end = match.index + match[0].length;
    if (end > at) break;
    line += 1;
    start = end;
  }
  const rest = source.slice(start);
  const stop = rest.search(LINE_BREAK);
  return { line, text: stop === -1 ? rest : rest.slice(0, stop) };
}

export interface MarkdownHeading {
  readonly level: number;
  readonly text: string;
  /** Offset of the heading line's first character. */
  readonly offset: number;
  readonly line: number;
}

/** ATX headings outside fenced code, in document order. */
export function markdownHeadings(source: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: { char: string; length: number } | undefined;
  let offset = 0;
  let line = 1;
  const parts = source.split(/(\r\n|\n|\r)/);
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index]!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.char &&
        marker[1]!.length >= fence.length &&
        marker[2]!.trim() === ""
      )
        fence = undefined;
    } else if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
    } else {
      const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(text);
      if (heading && heading[2]!.trim() !== "")
        headings.push({ level: heading[1]!.length, text: heading[2]!.trim(), offset, line });
    }
    offset += text.length + (parts[index + 1]?.length ?? 0);
    line += 1;
  }
  return headings;
}

/**
 * The section a position belongs to: the nearest preceding `##` heading, or failing that the
 * nearest heading of any level. Undefined before the first heading.
 */
export function sectionHeadingAt(source: string, offset: number): string | undefined {
  const before = markdownHeadings(source).filter((heading) => heading.offset <= offset);
  return (before.findLast((heading) => heading.level === 2) ?? before.at(-1))?.text;
}

/** The `##` headings, for choosing a section where there is no text selection. */
export const sectionHeadings = (source: string): string[] => {
  const all = markdownHeadings(source);
  const second = all.filter((heading) => heading.level === 2);
  return (second.length > 0 ? second : all).map((heading) => heading.text);
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAX_NEEDLE = 400;

/**
 * Finds a selection of rendered text in the markdown source. Whitespace may differ, since a
 * paragraph wrapped in the source reads as one line; when the text occurs more than once, the
 * occurrence whose preceding text matches `prefix` wins. Null when it cannot be found (for
 * example formatting inside the selection), which callers treat as "unknown position".
 */
export function locateSelection(
  source: string,
  selected: string,
  prefix = "",
): { start: number; end: number } | null {
  const needle = selected.trim().slice(0, MAX_NEEDLE);
  if (needle === "") return null;
  const pattern = new RegExp(escapeRegExp(needle).replace(/\s+/g, "\\s+"), "g");
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0) return null;
  const squash = (value: string) => value.replace(/\s+/g, " ").trim();
  const wanted = squash(prefix);
  const best =
    (wanted === ""
      ? undefined
      : matches.find((match) => squash(source.slice(0, match.index)).endsWith(wanted))) ??
    matches[0]!;
  return { start: best.index, end: best.index + best[0].length };
}

/** About `size` characters either side of a range, on the line it sits on. */
export function selectionContext(
  source: string,
  start: number,
  end: number,
  size = 30,
): { prefix: string; suffix: string } {
  const lineStart =
    Math.max(source.lastIndexOf("\n", start - 1), source.lastIndexOf("\r", start - 1)) + 1;
  const after = source.slice(end).search(LINE_BREAK);
  const lineEnd = after === -1 ? source.length : end + after;
  return {
    prefix: source.slice(Math.max(lineStart, start - size), start),
    suffix: source.slice(end, Math.min(lineEnd, end + size)),
  };
}

export type DocumentSegment =
  | {
      readonly kind: "markdown";
      readonly text: string;
      /** 1-based source line the run starts on, which also makes a stable key. */
      readonly line: number;
    }
  | {
      readonly kind: "task";
      /** 1-based source line, before `lineOffset` is added. */
      readonly line: number;
      /** The whole source line, as the server expects it back. */
      readonly text: string;
      readonly label: string;
      readonly checked: boolean;
      readonly depth: number;
    };

const TASK_ITEM = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\](.*)$/;

/**
 * Splits a document into runs of ordinary markdown and single checklist items, for clients that
 * cannot attach a handler to a rendered checkbox. Items inside fenced code stay markdown.
 */
export function splitDocumentSegments(source: string): DocumentSegment[] {
  const segments: DocumentSegment[] = [];
  let run: string[] = [];
  let runStart = 1;
  const flush = (next: number) => {
    const text = run.join("\n");
    if (text.trim() !== "") segments.push({ kind: "markdown", text, line: runStart });
    run = [];
    runStart = next;
  };
  let fence: { char: string; length: number } | undefined;
  source.split(/\r\n|\n|\r/).forEach((text, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.char &&
        marker[1]!.length >= fence.length &&
        marker[2]!.trim() === ""
      )
        fence = undefined;
      run.push(text);
      return;
    }
    if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      run.push(text);
      return;
    }
    const task = TASK_ITEM.exec(text);
    if (!task) {
      run.push(text);
      return;
    }
    flush(index + 2);
    segments.push({
      kind: "task",
      line: index + 1,
      text,
      label: task[3]!.trim(),
      checked: task[2] !== " ",
      depth: Math.floor(task[1]!.replaceAll("\t", "    ").length / 2),
    });
  });
  flush(0);
  return segments;
}
