// A task-list line is a list item whose text starts with `[ ]`, `[x]` or `[X]`.
const LIST_MARKER = String.raw`(?:[-*+]|\d+[.)])`;
const TASK_BOX = new RegExp(String.raw`^([ \t]*${LIST_MARKER}[ \t]+\[)([ xX])(\])`, "gm");
const TASK_LINE = new RegExp(String.raw`^([ \t]*${LIST_MARKER}[ \t]+\[)([ xX])(\])`);

/** The content with every task-list box unticked, so ticking one is not a requirements change. */
export const withoutCheckboxState = (content: string) => content.replace(TASK_BOX, "$1 $3");

const lineWithoutState = (line: string) => line.replace(TASK_LINE, "$1 $3");

export type ToggleResult =
  | { readonly ok: true; readonly content: string; readonly changed: boolean }
  | { readonly ok: false; readonly reason: "missing" | "stale" | "not-task" };

/**
 * Ticks or unticks the task-list item on one line (1-based) and leaves every other byte alone.
 * `expectedText` is the line as the caller saw it; if the line is different now, apart from its
 * box, the toggle is refused. A box already in the wanted state is a successful no-op, so a retried
 * request is harmless.
 */
export function toggleChecklistLine(
  content: string,
  line: number,
  expectedText: string,
  checked: boolean,
): ToggleResult {
  const parts = content.split(/(\r\n|\n|\r)/);
  const index = (line - 1) * 2;
  if (line < 1 || index >= parts.length) return { ok: false, reason: "missing" };
  const text = parts[index]!;
  if (lineWithoutState(text) !== lineWithoutState(expectedText))
    return { ok: false, reason: "stale" };
  const match = TASK_LINE.exec(text);
  if (!match || insideFence(parts, index)) return { ok: false, reason: "not-task" };
  const wanted = checked ? "x" : " ";
  const isChecked = match[2] !== " ";
  if (isChecked === checked) return { ok: true, content, changed: false };
  parts[index] = `${match[1]}${wanted}${text.slice(match[0].length - 1)}`;
  return { ok: true, content: parts.join(""), changed: true };
}

// A checkbox in a code sample is text, not a task.
function insideFence(parts: readonly string[], target: number): boolean {
  let fence: { char: string; length: number } | undefined;
  for (let index = 0; index < target; index += 2) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(parts[index]!);
    if (!marker) continue;
    if (!fence) fence = { char: marker[1]![0]!, length: marker[1]!.length };
    else if (
      marker[1]![0] === fence.char &&
      marker[1]!.length >= fence.length &&
      marker[2]!.trim() === ""
    )
      fence = undefined;
  }
  return fence !== undefined;
}
