import {
  computeMerge3,
  type LineRange,
  type Merge3Chunk,
  type Merge3ChunkKind,
  type Merge3Lines,
  type Merge3Result,
} from "@t3tools/shared/merge3";

/**
 * The pure state behind the three-pane merge view: one entry per changed region, with the
 * region's line range in each pane and what has been done to it. The result pane's ranges move
 * as the user edits, so every editor change goes through `shiftModel`.
 */

export type ChunkState =
  | "pending"
  | "accepted-ours"
  | "accepted-theirs"
  | "accepted-both"
  | "ignored-ours"
  | "ignored-theirs"
  | "edited"
  | "resolved";

export type MergePane = "ours" | "result" | "theirs";
export type MergeSide = "ours" | "theirs";
type SideStatus = "pending" | "applied" | "ignored";
interface SideStatuses {
  readonly ours: SideStatus;
  readonly theirs: SideStatus;
}

export interface MergeChunk {
  readonly id: number;
  readonly kind: Merge3ChunkKind;
  readonly base: LineRange;
  readonly ours: LineRange;
  readonly theirs: LineRange;
  /** Where the chunk is in the result pane right now. */
  readonly result: LineRange;
  readonly state: ChunkState;
  readonly baseText: string;
  readonly oursText: string;
  readonly theirsText: string;
}

export interface MergeModel {
  readonly chunks: ReadonlyArray<MergeChunk>;
}

export interface MergeSummary {
  /** Every changed region. */
  readonly changes: number;
  /** Conflicts nobody has settled yet. */
  readonly conflicts: number;
}

/** A position in the result document, as the editor addresses it. */
export interface ModelPosition {
  readonly line: number;
  readonly character: number;
}

/** The part of an editor change the model needs; the editor reports it in pre-edit coordinates. */
export interface ModelTextChange {
  readonly range: { readonly start: ModelPosition; readonly end: ModelPosition };
  readonly text: string;
}

export interface ModelTextEdit {
  readonly range: { readonly start: ModelPosition; readonly end: ModelPosition };
  readonly newText: string;
}

const joinLines = (lines: ReadonlyArray<string>, range: LineRange) =>
  lines.slice(range.start, range.end).join("");

const INITIAL_SIDES: Record<Merge3ChunkKind, SideStatuses> = {
  conflict: { ours: "pending", theirs: "pending" },
  ours: { ours: "applied", theirs: "pending" },
  theirs: { ours: "pending", theirs: "applied" },
  "both-same": { ours: "applied", theirs: "applied" },
  "auto-resolved": { ours: "applied", theirs: "applied" },
};

const MERGED_KINDS: ReadonlySet<Merge3ChunkKind> = new Set(["both-same", "auto-resolved"]);

function stateFromSides(sides: SideStatuses, kind: Merge3ChunkKind): ChunkState {
  if (sides.ours === "applied" && sides.theirs === "applied") {
    return MERGED_KINDS.has(kind) ? "resolved" : "accepted-both";
  }
  if (sides.ours === "applied") return "accepted-ours";
  if (sides.theirs === "applied") return "accepted-theirs";
  if (sides.ours === "ignored" && sides.theirs === "ignored") return "resolved";
  if (sides.ours === "ignored") return "ignored-ours";
  if (sides.theirs === "ignored") return "ignored-theirs";
  return "pending";
}

function sidesFromState(chunk: MergeChunk): SideStatuses {
  switch (chunk.state) {
    case "accepted-ours":
      return { ours: "applied", theirs: "pending" };
    case "accepted-theirs":
      return { ours: "pending", theirs: "applied" };
    case "accepted-both":
      return { ours: "applied", theirs: "applied" };
    case "ignored-ours":
      return { ours: "ignored", theirs: "pending" };
    case "ignored-theirs":
      return { ours: "pending", theirs: "ignored" };
    case "resolved":
      return MERGED_KINDS.has(chunk.kind)
        ? { ours: "applied", theirs: "applied" }
        : { ours: "ignored", theirs: "ignored" };
    case "pending":
    case "edited":
      return { ours: "pending", theirs: "pending" };
  }
}

export function createMergeModel(lines: Merge3Lines, merge: Merge3Result): MergeModel {
  return {
    chunks: merge.chunks.map((chunk: Merge3Chunk, id) => ({
      id,
      kind: chunk.kind,
      base: chunk.base,
      ours: chunk.ours,
      theirs: chunk.theirs,
      result: chunk.result,
      state: stateFromSides(INITIAL_SIDES[chunk.kind], chunk.kind),
      baseText: joinLines(lines.base, chunk.base),
      oursText: joinLines(lines.ours, chunk.ours),
      theirsText: joinLines(lines.theirs, chunk.theirs),
    })),
  };
}

/** A conflict still needs a decision until a side is accepted, both are ignored, or it is edited. */
export function isUnresolved(chunk: MergeChunk): boolean {
  return (
    chunk.kind === "conflict" &&
    (chunk.state === "pending" ||
      chunk.state === "ignored-ours" ||
      chunk.state === "ignored-theirs")
  );
}

export function summarizeModel(model: MergeModel): MergeSummary {
  return {
    changes: model.chunks.length,
    conflicts: model.chunks.filter(isUnresolved).length,
  };
}

const comparePositions = (a: ModelPosition, b: ModelPosition) =>
  a.line - b.line || a.character - b.character;

/** Where the end of `text` lands when it replaces a range starting at `start`. */
function endOfInsertedText(start: ModelPosition, text: string): ModelPosition {
  let newlines = 0;
  let lastBreak = -1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    newlines += 1;
    lastBreak = index;
  }
  return newlines === 0
    ? { line: start.line, character: start.character + text.length }
    : { line: start.line + newlines, character: text.length - lastBreak - 1 };
}

/**
 * Moves one chunk boundary (the position before line `line`) through one change.
 *
 * Text typed exactly at a boundary belongs inside the chunk at its start, and outside it at its
 * end, because that end is the first character of the next region. A deletion that swallows a
 * boundary pulls the chunk's start to the end of the new text and its end back to the change's
 * start, so the chunk keeps only what survives.
 */
function mapBoundary(
  line: number,
  kind: "start" | "end",
  chunkEmpty: boolean,
  change: ModelTextChange,
): number {
  const position = { line, character: 0 };
  const { start, end } = change.range;
  const after = endOfInsertedText(start, change.text);
  const lineDelta = after.line - end.line;
  if (comparePositions(position, start) < 0) return line;
  if (comparePositions(position, end) > 0) return line + lineDelta;
  const insertion = comparePositions(start, end) === 0;
  if (comparePositions(position, start) === 0) {
    // A pure insertion into an empty chunk grows it; anything else at the start leaves it alone.
    return kind === "end" && insertion && chunkEmpty ? after.line : line;
  }
  if (comparePositions(position, end) === 0) return after.line;
  // Strictly inside the replaced region.
  return kind === "start" ? after.line : start.line + (start.character > 0 ? 1 : 0);
}

function mapRange(range: LineRange, change: ModelTextChange): LineRange {
  const empty = range.start === range.end;
  const start = mapBoundary(range.start, "start", empty, change);
  const end = Math.max(start, mapBoundary(range.end, "end", empty, change));
  return start === range.start && end === range.end ? range : { start, end };
}

/** Whether a change touches lines of the range, not merely its edge. */
function changeTouchesRange(range: LineRange, change: ModelTextChange): boolean {
  const { start, end } = change.range;
  const insertion = comparePositions(start, end) === 0;
  if (range.start === range.end) return start.line === range.start;
  const firstLine = start.line;
  const lastLine = !insertion && end.character === 0 ? end.line - 1 : end.line;
  return firstLine < range.end && Math.max(firstLine, lastLine) >= range.start;
}

/**
 * Applies editor changes (pre-edit coordinates, ascending) to the result ranges. Changes are
 * walked last to first so each is still addressed in the coordinates it was reported in.
 */
export function shiftModel(model: MergeModel, changes: ReadonlyArray<ModelTextChange>): MergeModel {
  if (changes.length === 0) return model;
  let chunks = model.chunks;
  for (const change of changes.toReversed()) {
    chunks = chunks.map((chunk) => {
      const result = mapRange(chunk.result, change);
      return result === chunk.result ? chunk : { ...chunk, result };
    });
  }
  return { chunks };
}

/** Marks every chunk a user edit reached; later actions on it replace the user's text. */
function markEdited(model: MergeModel, changes: ReadonlyArray<ModelTextChange>): MergeModel {
  if (changes.length === 0) return model;
  // Touch is judged against the ranges as they were before the edit, so this runs first.
  const touched = new Set<number>();
  for (const change of changes) {
    for (const chunk of model.chunks) {
      if (changeTouchesRange(chunk.result, change)) touched.add(chunk.id);
    }
  }
  if (touched.size === 0) return model;
  return {
    chunks: model.chunks.map((chunk) =>
      touched.has(chunk.id) && chunk.state !== "edited" ? { ...chunk, state: "edited" } : chunk,
    ),
  };
}

/** A user's own edit: classify against the old ranges, then shift. */
export function applyUserEdit(
  model: MergeModel,
  changes: ReadonlyArray<ModelTextChange>,
): MergeModel {
  return shiftModel(markEdited(model, changes), changes);
}

export type ChunkAction =
  | { readonly type: "accept"; readonly side: MergeSide }
  | { readonly type: "acceptBoth"; readonly order: "ours-first" | "theirs-first" }
  | { readonly type: "ignore"; readonly side: MergeSide };

export interface ActionContext {
  /** The text the result pane holds for these lines right now. */
  readonly textOf: (range: LineRange) => string;
  /** Lines in the result document, as the editor counts them (a final newline adds an empty one). */
  readonly lineCount: number;
  /** The very end of the result document, where a region that runs to the end of the file stops. */
  readonly endPosition: ModelPosition;
}

export interface ActionPlan {
  readonly edits: ReadonlyArray<ModelTextEdit>;
  /** State to give each touched chunk once the edits have landed. */
  readonly states: ReadonlyMap<number, ChunkState>;
}

const other = (side: MergeSide): MergeSide => (side === "ours" ? "theirs" : "ours");

function textForSides(
  chunk: MergeChunk,
  sides: SideStatuses,
  order: "ours-first" | "theirs-first" = "ours-first",
): string {
  if (sides.ours === "applied" && sides.theirs === "applied") {
    return order === "ours-first"
      ? chunk.oursText + chunk.theirsText
      : chunk.theirsText + chunk.oursText;
  }
  if (sides.ours === "applied") return chunk.oursText;
  if (sides.theirs === "applied") return chunk.theirsText;
  return chunk.baseText;
}

function replaceEdit(range: LineRange, text: string, ctx: ActionContext): ModelTextEdit {
  // A chunk that is not the file's last must end its last line, or it would run into the next.
  const toEnd = range.end >= ctx.lineCount;
  const body = text.length > 0 && !text.endsWith("\n") && !toEnd ? `${text}\n` : text;
  return {
    range: {
      start: { line: range.start, character: 0 },
      end: toEnd ? ctx.endPosition : { line: range.end, character: 0 },
    },
    newText: body,
  };
}

/** An empty insertion: it changes nothing but gives the action its own undo step. */
function markerEdit(range: LineRange): ModelTextEdit {
  const position = { line: range.start, character: 0 };
  return { range: { start: position, end: position }, newText: "" };
}

function planForSides(
  chunk: MergeChunk,
  sides: SideStatuses,
  ctx: ActionContext,
  order?: "ours-first" | "theirs-first",
): { edit: ModelTextEdit; state: ChunkState } {
  const text = textForSides(chunk, sides, order);
  const current = ctx.textOf(chunk.result);
  return {
    edit: text === current ? markerEdit(chunk.result) : replaceEdit(chunk.result, text, ctx),
    state: stateFromSides(sides, chunk.kind),
  };
}

/** Null when the action would change nothing. */
export function planChunkAction(
  model: MergeModel,
  chunkId: number,
  action: ChunkAction,
  ctx: ActionContext,
): ActionPlan | null {
  const chunk = model.chunks.find((candidate) => candidate.id === chunkId);
  if (chunk === undefined) return null;
  const current = chunk.state === "edited" ? undefined : sidesFromState(chunk);

  if (action.type === "acceptBoth") {
    const planned = planForSides(chunk, { ours: "applied", theirs: "applied" }, ctx, action.order);
    return { edits: [planned.edit], states: new Map([[chunk.id, "accepted-both"]]) };
  }

  if (action.type === "accept") {
    if (chunk.state === (action.side === "ours" ? "accepted-ours" : "accepted-theirs")) return null;
    const otherSide = other(action.side);
    // Two sides that both changed a region can both be taken, ours first; for a region only one
    // side touched, taking the other side just replaces it.
    const keepOther =
      chunk.kind === "conflict" &&
      chunk.state === (otherSide === "ours" ? "accepted-ours" : "accepted-theirs");
    const sides: SideStatuses = {
      ours: "pending",
      theirs: "pending",
      [action.side]: "applied",
      [otherSide]: keepOther ? "applied" : "ignored",
    } as SideStatuses;
    const planned = planForSides(chunk, sides, ctx);
    return { edits: [planned.edit], states: new Map([[chunk.id, planned.state]]) };
  }

  // ignore
  if (current === undefined) return null;
  if (current[action.side] === "ignored") return null;
  if (current[action.side] === "pending" && chunk.kind !== "conflict" && !isReverted(chunk)) {
    return null;
  }
  const sides: SideStatuses = { ...current, [action.side]: "ignored" };
  const planned = planForSides(chunk, sides, ctx);
  return { edits: [planned.edit], states: new Map([[chunk.id, planned.state]]) };
}

/** A one-sided region whose applied change was taken back out, so its other side can still be ignored. */
const isReverted = (chunk: MergeChunk) =>
  chunk.state === "ignored-ours" || chunk.state === "ignored-theirs";

/**
 * Applies the changes only one side made, from the left, right or both. Regions both sides
 * touched are never decided here.
 */
export function planApplyNonConflicting(
  model: MergeModel,
  side: "left" | "right" | "all",
  ctx: ActionContext,
): ActionPlan | null {
  const edits: ModelTextEdit[] = [];
  const states = new Map<number, ChunkState>();
  for (const chunk of model.chunks) {
    const wanted: MergeSide | null =
      chunk.kind === "ours" && side !== "right"
        ? "ours"
        : chunk.kind === "theirs" && side !== "left"
          ? "theirs"
          : null;
    if (wanted === null || chunk.state === "edited") continue;
    const alreadyApplied =
      chunk.state === (wanted === "ours" ? "accepted-ours" : "accepted-theirs");
    if (alreadyApplied) continue;
    const plan = planChunkAction(model, chunk.id, { type: "accept", side: wanted }, ctx);
    if (plan === null) continue;
    edits.push(...plan.edits);
    for (const [id, state] of plan.states) states.set(id, state);
  }
  return edits.length === 0 ? null : { edits, states };
}

/**
 * Re-merges every undecided conflict word by word and applies the ones that come out clean.
 * Safe to run again after the user has changed things: settled chunks are left alone.
 */
export function planResolveSimple(model: MergeModel, ctx: ActionContext): ActionPlan | null {
  const edits: ModelTextEdit[] = [];
  const states = new Map<number, ChunkState>();
  for (const chunk of model.chunks) {
    if (!isUnresolved(chunk)) continue;
    const merged = computeMerge3(
      { base: chunk.baseText, ours: chunk.oursText, theirs: chunk.theirsText },
      { resolveSimple: true },
    );
    if (merged.stats.conflicts > 0 || merged.stats.editLimitExceeded) continue;
    edits.push(replaceEdit(chunk.result, merged.initialResult, ctx));
    states.set(chunk.id, "resolved");
  }
  return edits.length === 0 ? null : { edits, states };
}

/** Sets the planned states once an action's edits have been shifted into the ranges. */
function applyStates(model: MergeModel, states: ReadonlyMap<number, ChunkState>): MergeModel {
  return {
    chunks: model.chunks.map((chunk) => {
      const state = states.get(chunk.id);
      return state === undefined ? chunk : { ...chunk, state };
    }),
  };
}

export function chunkAtLine(model: MergeModel, line: number): MergeChunk | null {
  return (
    model.chunks.find((chunk) =>
      chunk.result.start === chunk.result.end
        ? chunk.result.start === line
        : line >= chunk.result.start && line < chunk.result.end,
    ) ?? null
  );
}

/** The next (or previous) unresolved conflict from a result line, wrapping around the file. */
export function findConflict(
  model: MergeModel,
  fromLine: number,
  direction: "next" | "previous",
): MergeChunk | null {
  const unresolved = model.chunks
    .filter(isUnresolved)
    .toSorted((a, b) => a.result.start - b.result.start);
  if (unresolved.length === 0) return null;
  if (direction === "next") {
    return unresolved.find((chunk) => chunk.result.start > fromLine) ?? unresolved[0]!;
  }
  return unresolved.findLast((chunk) => chunk.result.start < fromLine) ?? unresolved.at(-1)!;
}

function paneRange(chunk: MergeChunk, pane: MergePane): LineRange {
  return chunk[pane];
}

/**
 * Maps a line in one pane to the matching (fractional) line in another, linearly inside each
 * region and anchored at region edges, so scrolling keeps the same code level across panes.
 */
export function mapLine(
  model: MergeModel,
  fromPane: MergePane,
  toPane: MergePane,
  line: number,
  totals: Readonly<Record<MergePane, number>>,
): number {
  if (fromPane === toPane) return line;
  const anchors: Array<readonly [from: number, to: number]> = [[0, 0]];
  for (const chunk of model.chunks) {
    const from = paneRange(chunk, fromPane);
    const to = paneRange(chunk, toPane);
    anchors.push([from.start, to.start], [from.end, to.end]);
  }
  anchors.push([totals[fromPane], totals[toPane]]);
  for (let index = 1; index < anchors.length; index += 1) {
    const [fromStart, toStart] = anchors[index - 1]!;
    const [fromEnd, toEnd] = anchors[index]!;
    if (line > fromEnd && index < anchors.length - 1) continue;
    if (fromEnd === fromStart) return toStart;
    const progress = Math.min(1, Math.max(0, (line - fromStart) / (fromEnd - fromStart)));
    return toStart + progress * (toEnd - toStart);
  }
  return totals[toPane];
}

/**
 * Keeps the chunk state in step with the editor's undo history. The editor owns the text and its
 * history, so each history entry remembers the model that held after it. After a change the top
 * undo entry says what happened: one this timeline has seen is an undo or redo and restores its
 * model; an unseen one is a new edit, which is either one of our actions (planned states
 * attached) or the user typing. Typing that coalesces replaces the entry object, so it is simply
 * recorded again.
 */
export class MergeTimeline<Entry extends object> {
  readonly #initial: MergeModel;
  readonly #snapshots = new WeakMap<Entry, MergeModel>();
  #current: MergeModel;

  constructor(initial: MergeModel) {
    this.#initial = initial;
    this.#current = initial;
  }

  get model(): MergeModel {
    return this.#current;
  }

  /** Call after every editor change with the top of its undo stack. */
  update(
    top: Entry | undefined,
    changes: ReadonlyArray<ModelTextChange>,
    plannedStates?: ReadonlyMap<number, ChunkState>,
  ): MergeModel {
    let next: MergeModel;
    if (plannedStates !== undefined) {
      next = applyStates(shiftModel(this.#current, changes), plannedStates);
    } else {
      const remembered = top === undefined ? this.#initial : this.#snapshots.get(top);
      next = remembered ?? applyUserEdit(this.#current, changes);
    }
    if (top !== undefined) this.#snapshots.set(top, next);
    this.#current = next;
    return next;
  }
}

export interface ChunkActionAvailability {
  readonly acceptOurs: boolean;
  readonly acceptTheirs: boolean;
  readonly ignoreOurs: boolean;
  readonly ignoreTheirs: boolean;
  readonly acceptBoth: boolean;
}

const PROBE_CONTEXT: ActionContext = {
  textOf: () => "\u0000",
  lineCount: Number.MAX_SAFE_INTEGER,
  endPosition: { line: 0, character: 0 },
};

/** Which buttons a region offers, so the dividers draw only the ones that would do something. */
export function chunkActionAvailability(chunk: MergeChunk): ChunkActionAvailability {
  const model: MergeModel = { chunks: [chunk] };
  const can = (action: ChunkAction) =>
    planChunkAction(model, chunk.id, action, PROBE_CONTEXT) !== null;
  return {
    acceptOurs: chunk.kind !== "theirs" && can({ type: "accept", side: "ours" }),
    acceptTheirs: chunk.kind !== "ours" && can({ type: "accept", side: "theirs" }),
    ignoreOurs: chunk.kind !== "theirs" && can({ type: "ignore", side: "ours" }),
    ignoreTheirs: chunk.kind !== "ours" && can({ type: "ignore", side: "theirs" }),
    acceptBoth: chunk.kind === "conflict",
  };
}
