import { diffArrays, diffWordsWithSpace } from "diff";

/** Half-open range of line indices into one of the texts. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * - `ours` / `theirs`: only that side changed the region, so its text is applied.
 * - `both-same`: both sides made the identical change.
 * - `auto-resolved`: a line-level conflict that merges cleanly once re-merged by token.
 * - `conflict`: a real conflict. The initial result holds the base text for it.
 *
 * "Ours" and "theirs" are positional (the left and right input), not git's meaning of them.
 */
export type Merge3ChunkKind = "ours" | "theirs" | "both-same" | "conflict" | "auto-resolved";

/**
 * One changed region. Only changed regions are chunks; text between chunks is identical in
 * all three inputs and in the initial result. Every range is in lines of its own text, so a
 * UI can place connectors between panes and shift `result` as the user edits.
 */
export interface Merge3Chunk {
  readonly kind: Merge3ChunkKind;
  readonly base: LineRange;
  readonly ours: LineRange;
  readonly theirs: LineRange;
  readonly result: LineRange;
}

export interface Merge3Input {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
}

export interface Merge3Options {
  /** Re-merge each conflicting chunk by token and keep the ones that come out clean. */
  readonly resolveSimple?: boolean;
  /** Line-diff edit distance above which the whole file becomes a single conflict. */
  readonly maxEditLength?: number;
}

export interface Merge3Stats {
  /** Number of chunks. */
  readonly changes: number;
  /** Chunks of kind `conflict`. */
  readonly conflicts: number;
  /** Chunks of kind `auto-resolved`. */
  readonly autoResolved: number;
  /** True when the edit-length guard fired and the file was treated as one conflict. */
  readonly editLimitExceeded: boolean;
}

export interface Merge3Result {
  readonly chunks: ReadonlyArray<Merge3Chunk>;
  /** Base text with every one-sided and auto-resolved change applied; real conflicts hold the base text. */
  readonly initialResult: string;
  readonly stats: Merge3Stats;
}

export interface Merge3Lines {
  readonly base: ReadonlyArray<string>;
  readonly ours: ReadonlyArray<string>;
  readonly theirs: ReadonlyArray<string>;
}

const DEFAULT_MERGE3_MAX_EDIT_LENGTH = 4000;
const TOKEN_MAX_EDIT_LENGTH = 2000;

/** Lines keep their terminators so CRLF and a missing final newline survive a round trip. */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", start)) {
    lines.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/**
 * The lines two texts share, in order: a stand-in base when there is no common ancestor. Against
 * it every difference is an insertion, so a region both sides changed is a conflict and a region
 * only one side has is offered as that side's change. Empty when the texts are too different to
 * diff cheaply, which leaves the whole file as one conflict.
 */
export function commonLines(left: string, right: string): string {
  const changes = diffArrays(splitLines(left), splitLines(right), {
    maxEditLength: DEFAULT_MERGE3_MAX_EDIT_LENGTH,
  });
  if (changes === undefined) return "";
  return changes
    .filter((change) => !change.added && !change.removed)
    .flatMap((change) => change.value)
    .join("");
}

export function detectLineEnding(text: string): "\r\n" | "\n" {
  let crlf = 0;
  let lf = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    if (index > 0 && text.charCodeAt(index - 1) === 13) crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? "\r\n" : "\n";
}

export function convertLineEndings(text: string, lineEnding: "\r\n" | "\n"): string {
  return text.replace(/\r?\n/g, lineEnding);
}

/** A NUL byte or invalid UTF-8; callers fall back to whole-file resolution. */
export function isBinaryContent(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index += 1) if (bytes[index] === 0) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

interface Hunk {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly sideStart: number;
  readonly sideEnd: number;
}

type ClusterKind = "ours" | "theirs" | "both-same" | "conflict";

interface Cluster {
  readonly kind: ClusterKind;
  readonly base: LineRange;
  readonly ours: LineRange;
  readonly theirs: LineRange;
}

const equalSlices = (
  left: ReadonlyArray<number>,
  leftRange: LineRange,
  right: ReadonlyArray<number>,
  rightRange: LineRange,
) => {
  if (leftRange.end - leftRange.start !== rightRange.end - rightRange.start) return false;
  for (let offset = 0; offset < leftRange.end - leftRange.start; offset += 1) {
    if (left[leftRange.start + offset] !== right[rightRange.start + offset]) return false;
  }
  return true;
};

const diffHunks = (base: number[], side: number[], maxEditLength: number): Hunk[] | undefined => {
  if (base.length === side.length && base.every((id, index) => id === side[index])) return [];
  const changes = diffArrays(base, side, { maxEditLength });
  if (changes === undefined) return undefined;
  const hunks: Hunk[] = [];
  let baseIndex = 0;
  let sideIndex = 0;
  let open: { baseStart: number; sideStart: number } | undefined;
  const close = () => {
    if (open === undefined) return;
    hunks.push({
      baseStart: open.baseStart,
      baseEnd: baseIndex,
      sideStart: open.sideStart,
      sideEnd: sideIndex,
    });
    open = undefined;
  };
  for (const change of changes) {
    if (!change.added && !change.removed) {
      close();
      baseIndex += change.count;
      sideIndex += change.count;
      continue;
    }
    open ??= { baseStart: baseIndex, sideStart: sideIndex };
    if (change.removed) baseIndex += change.count;
    else sideIndex += change.count;
  }
  close();
  return hunks;
};

/**
 * Whether a hunk belongs to the cluster of earlier hunks. Edits conflict when their base ranges
 * overlap, or when two insertions land on the same point, or an insertion falls strictly inside
 * the other edit. Edits that merely touch are independent unless `touching` is set, which the
 * token re-merge uses because adjacent token edits usually do depend on each other.
 */
const joinsCluster = (start: number, end: number, hunk: Hunk, touching: boolean): boolean => {
  if (touching) return hunk.baseStart <= end && start <= hunk.baseEnd;
  const hunkEmpty = hunk.baseStart === hunk.baseEnd;
  const clusterEmpty = start === end;
  if (hunkEmpty && clusterEmpty) return hunk.baseStart === start;
  if (hunkEmpty) return start < hunk.baseStart && hunk.baseStart < end;
  if (clusterEmpty) return hunk.baseStart < start && start < hunk.baseEnd;
  return hunk.baseStart < end && start < hunk.baseEnd;
};

/** The shared diff3 sweep over interned ids. `undefined` means the edit-length guard fired. */
const mergeIds = (
  base: number[],
  ours: number[],
  theirs: number[],
  options: { maxEditLength: number; touching: boolean },
): Cluster[] | undefined => {
  const oursHunks = diffHunks(base, ours, options.maxEditLength);
  const theirsHunks = diffHunks(base, theirs, options.maxEditLength);
  if (oursHunks === undefined || theirsHunks === undefined) return undefined;

  const tagged = [
    ...oursHunks.map((hunk) => ({ hunk, side: "ours" as const })),
    ...theirsHunks.map((hunk) => ({ hunk, side: "theirs" as const })),
  ].sort(
    (left, right) =>
      left.hunk.baseStart - right.hunk.baseStart ||
      left.hunk.baseEnd - left.hunk.baseStart - (right.hunk.baseEnd - right.hunk.baseStart),
  );

  const groups: Array<{ start: number; end: number; ours: Hunk[]; theirs: Hunk[] }> = [];
  for (const { hunk, side } of tagged) {
    const current = groups.at(-1);
    if (current !== undefined && joinsCluster(current.start, current.end, hunk, options.touching)) {
      current.end = Math.max(current.end, hunk.baseEnd);
      current[side].push(hunk);
      continue;
    }
    groups.push({
      start: hunk.baseStart,
      end: hunk.baseEnd,
      ours: side === "ours" ? [hunk] : [],
      theirs: side === "theirs" ? [hunk] : [],
    });
  }

  const delta = (hunks: ReadonlyArray<Hunk>) =>
    hunks.reduce(
      (sum, hunk) => sum + (hunk.sideEnd - hunk.sideStart) - (hunk.baseEnd - hunk.baseStart),
      0,
    );
  const clusters: Cluster[] = [];
  let oursOffset = 0;
  let theirsOffset = 0;
  for (const group of groups) {
    const oursDelta = delta(group.ours);
    const theirsDelta = delta(group.theirs);
    const oursRange = {
      start: group.start + oursOffset,
      end: group.end + oursOffset + oursDelta,
    };
    const theirsRange = {
      start: group.start + theirsOffset,
      end: group.end + theirsOffset + theirsDelta,
    };
    oursOffset += oursDelta;
    theirsOffset += theirsDelta;
    const baseRange = { start: group.start, end: group.end };
    const kind: ClusterKind =
      group.theirs.length === 0
        ? "ours"
        : group.ours.length === 0
          ? "theirs"
          : equalSlices(ours, oursRange, theirs, theirsRange)
            ? "both-same"
            : "conflict";
    clusters.push({ kind, base: baseRange, ours: oursRange, theirs: theirsRange });
  }
  return clusters;
};

const createInterner = () => {
  const ids = new Map<string, number>();
  return (tokens: ReadonlyArray<string>) =>
    tokens.map((token) => {
      let id = ids.get(token);
      if (id === undefined) {
        id = ids.size;
        ids.set(token, id);
      }
      return id;
    });
};

const TOKEN_PATTERN = /[\p{L}\p{N}_$]+|[ \t]+|\r?\n|[\s\S]/gu;

const tokenize = (text: string): string[] => text.match(TOKEN_PATTERN) ?? [];

/** Re-merges one conflicting region by token. Returns `undefined` unless it merges cleanly. */
function mergeTokens(base: string, ours: string, theirs: string): string | undefined {
  const intern = createInterner();
  const baseTokens = tokenize(base);
  const oursTokens = tokenize(ours);
  const theirsTokens = tokenize(theirs);
  const clusters = mergeIds(intern(baseTokens), intern(oursTokens), intern(theirsTokens), {
    maxEditLength: TOKEN_MAX_EDIT_LENGTH,
    touching: true,
  });
  if (clusters === undefined || clusters.some((cluster) => cluster.kind === "conflict")) {
    return undefined;
  }
  let merged = "";
  let cursor = 0;
  for (const cluster of clusters) {
    merged += baseTokens.slice(cursor, cluster.base.start).join("");
    const source = cluster.kind === "theirs" ? theirsTokens : oursTokens;
    const range = cluster.kind === "theirs" ? cluster.theirs : cluster.ours;
    merged += source.slice(range.start, range.end).join("");
    cursor = cluster.base.end;
  }
  return merged + baseTokens.slice(cursor).join("");
}

const endsWithLineBreak = (text: string) => text.endsWith("\n");

export function computeMerge3(input: Merge3Input, options: Merge3Options = {}): Merge3Result {
  const baseLines = splitLines(input.base);
  const oursLines = splitLines(input.ours);
  const theirsLines = splitLines(input.theirs);
  const intern = createInterner();
  const clusters = mergeIds(intern(baseLines), intern(oursLines), intern(theirsLines), {
    maxEditLength: options.maxEditLength ?? DEFAULT_MERGE3_MAX_EDIT_LENGTH,
    touching: false,
  });

  if (clusters === undefined) {
    // The diff was too expensive to trust; hand the whole file over as a single conflict.
    return {
      chunks: [
        {
          kind: "conflict",
          base: { start: 0, end: baseLines.length },
          ours: { start: 0, end: oursLines.length },
          theirs: { start: 0, end: theirsLines.length },
          result: { start: 0, end: baseLines.length },
        },
      ],
      initialResult: input.base,
      stats: { changes: 1, conflicts: 1, autoResolved: 0, editLimitExceeded: true },
    };
  }

  const chunks: Merge3Chunk[] = [];
  const out: string[] = [];
  let resultLine = 0;
  let baseCursor = 0;
  const emit = (lines: ReadonlyArray<string>) => {
    out.push(...lines);
    resultLine += lines.length;
  };
  let conflicts = 0;
  let autoResolved = 0;

  for (const cluster of clusters) {
    emit(baseLines.slice(baseCursor, cluster.base.start));
    baseCursor = cluster.base.end;
    const resultStart = resultLine;
    const baseSlice = baseLines.slice(cluster.base.start, cluster.base.end);
    const oursSlice = oursLines.slice(cluster.ours.start, cluster.ours.end);
    const theirsSlice = theirsLines.slice(cluster.theirs.start, cluster.theirs.end);

    let kind: Merge3ChunkKind = cluster.kind;
    if (cluster.kind === "ours" || cluster.kind === "both-same") emit(oursSlice);
    else if (cluster.kind === "theirs") emit(theirsSlice);
    else {
      const merged = options.resolveSimple
        ? mergeTokens(baseSlice.join(""), oursSlice.join(""), theirsSlice.join(""))
        : undefined;
      // A merge that drops the region's final newline would glue it to the next line.
      const usable =
        merged !== undefined &&
        (merged.length === 0 || endsWithLineBreak(merged) || cluster.base.end >= baseLines.length);
      if (usable) {
        kind = "auto-resolved";
        autoResolved += 1;
        emit(splitLines(merged));
      } else {
        conflicts += 1;
        emit(baseSlice);
      }
    }
    chunks.push({
      kind,
      base: cluster.base,
      ours: cluster.ours,
      theirs: cluster.theirs,
      result: { start: resultStart, end: resultLine },
    });
  }
  emit(baseLines.slice(baseCursor));

  return {
    chunks,
    initialResult: out.join(""),
    stats: { changes: chunks.length, conflicts, autoResolved, editLimitExceeded: false },
  };
}

export interface WordRange {
  /** Line index in the pane's own text. */
  readonly line: number;
  /** Column range in UTF-16 units, excluding the line terminator. */
  readonly start: number;
  readonly end: number;
}

const contentLength = (line: string) =>
  line.length - (line.endsWith("\r\n") ? 2 : line.endsWith("\n") ? 1 : 0);

const sideWordRanges = (
  baseLines: ReadonlyArray<string>,
  baseRange: LineRange,
  sideLines: ReadonlyArray<string>,
  sideRange: LineRange,
): WordRange[] => {
  const lines = sideLines.slice(sideRange.start, sideRange.end);
  const changes = diffWordsWithSpace(
    baseLines.slice(baseRange.start, baseRange.end).join(""),
    lines.join(""),
  );
  const ranges: WordRange[] = [];
  let offset = 0;
  let lineIndex = 0;
  let lineStart = 0;
  for (const change of changes) {
    if (change.removed) continue;
    const from = offset;
    const to = offset + change.value.length;
    offset = to;
    if (!change.added) continue;
    while (lineIndex < lines.length - 1 && lineStart + lines[lineIndex]!.length <= from) {
      lineStart += lines[lineIndex]!.length;
      lineIndex += 1;
    }
    let cursorLine = lineIndex;
    let cursorStart = lineStart;
    while (cursorLine < lines.length && cursorStart < to) {
      const line = lines[cursorLine]!;
      const start = Math.max(from, cursorStart) - cursorStart;
      const end = Math.min(to, cursorStart + contentLength(line)) - cursorStart;
      if (end > start) ranges.push({ line: sideRange.start + cursorLine, start, end });
      cursorStart += line.length;
      cursorLine += 1;
    }
  }
  return ranges;
};

/**
 * Word-level highlights for one chunk: where each side differs from the base. Computed per chunk
 * on demand so a UI only pays for chunks it renders.
 */
export function chunkWordRanges(
  lines: Merge3Lines,
  chunk: Merge3Chunk,
): { readonly ours: WordRange[]; readonly theirs: WordRange[] } {
  return {
    ours: sideWordRanges(lines.base, chunk.base, lines.ours, chunk.ours),
    theirs: sideWordRanges(lines.base, chunk.base, lines.theirs, chunk.theirs),
  };
}
