import type { LineRange } from "@t3tools/shared/merge3";

import { isUnresolved, type MergeChunk, type MergeModel, type MergePane } from "./mergeModel";

/**
 * How a region reads at a glance. A conflict nobody settled stands out; an applied or merged
 * region reads as done; a one-sided change is quieter; a region that was put aside fades.
 */
export type ChunkTone = "conflict" | "change" | "applied" | "settled";

export function chunkTone(chunk: MergeChunk, pane: MergePane): ChunkTone {
  if (isUnresolved(chunk)) return "conflict";
  if (pane === "result") {
    switch (chunk.state) {
      case "ignored-ours":
      case "ignored-theirs":
        return "settled";
      case "accepted-ours":
      case "accepted-theirs":
        return chunk.kind === "conflict" ? "applied" : "change";
      default:
        return "applied";
    }
  }
  return chunk.state === "resolved" || chunk.state === "edited" || chunk.state.startsWith("ignored")
    ? "settled"
    : "change";
}

// Tokens the app already defines: diff addition for applied work, the warning token for what
// needs a decision, info for one-sided changes. Alpha mixes keep the row's own surface visible,
// so a selection painted under the row still shows.
const TONE_COLOR: Record<ChunkTone, string> = {
  conflict: "var(--warning)",
  change: "var(--info)",
  applied: "var(--diff-addition)",
  settled: "var(--muted-foreground)",
};
const LINE_ALPHA: Record<ChunkTone, number> = {
  conflict: 20,
  change: 16,
  applied: 16,
  settled: 8,
};
const WORD_ALPHA = 38;

export const toneColor = (tone: ChunkTone) => TONE_COLOR[tone];

export interface PaneLineTone {
  readonly line: number;
  readonly tone: ChunkTone;
}

/** The lines of a pane that belong to a region, limited to the lines currently rendered. */
export function paneLineTones(
  model: MergeModel,
  pane: MergePane,
  window: { readonly first: number; readonly last: number },
): PaneLineTone[] {
  const tones: PaneLineTone[] = [];
  for (const chunk of model.chunks) {
    const range = chunk[pane];
    const tone = chunkTone(chunk, pane);
    const from = Math.max(range.start, window.first);
    const to = Math.min(range.end - 1, window.last);
    for (let line = from; line <= to; line += 1) tones.push({ line, tone });
  }
  return tones;
}

/** Row tints for a pane. Tints go through `--diffs-line-bg`, which the editor paints below its selection. */
export function buildPaneCss(tones: ReadonlyArray<PaneLineTone>): string {
  const byTone = new Map<ChunkTone, number[]>();
  for (const { line, tone } of tones) {
    const lines = byTone.get(tone);
    if (lines === undefined) byTone.set(tone, [line]);
    else lines.push(line);
  }
  const rules: string[] = [];
  for (const [tone, lines] of byTone) {
    const color = `color-mix(in srgb, ${TONE_COLOR[tone]} ${LINE_ALPHA[tone]}%, transparent)`;
    const rows = lines.map((line) => `[data-line][data-line-index="${line}"]`).join(",");
    const numbers = lines
      .map((line) => `[data-column-number][data-line-index="${line}"]`)
      .join(",");
    rules.push(`:is(${rows}){--diffs-line-bg:${color} !important;}`);
    rules.push(`:is(${numbers}){background-color:${color} !important;}`);
  }
  return rules.join("\n");
}

/** `::highlight()` styles for word-level differences, one registered highlight per tone. */
export function buildWordHighlightCss(names: Readonly<Record<ChunkTone, string>>): string {
  return (Object.keys(names) as ChunkTone[])
    .map(
      (tone) =>
        `::highlight(${names[tone]}){background-color:color-mix(in srgb, ${TONE_COLOR[tone]} ${WORD_ALPHA}%, transparent);}`,
    )
    .join("\n");
}

export interface DividerGeometry {
  readonly lineHeight: number;
  /** Where line 0 starts, in each pane's own scrolling content. */
  readonly leftOrigin: number;
  readonly rightOrigin: number;
  readonly leftScrollTop: number;
  readonly rightScrollTop: number;
  readonly viewportHeight: number;
  readonly width: number;
}

export interface Connector {
  readonly chunkId: number;
  readonly tone: ChunkTone;
  readonly path: string;
  /** Top of the region on the pane the buttons act from, clamped into view. */
  readonly buttonY: number;
}

const lineY = (line: number, origin: number, scrollTop: number, lineHeight: number) =>
  origin + line * lineHeight - scrollTop;

/**
 * The shapes joining a side pane's region to the result pane's, for regions at least partly in
 * view. Line positions are plain arithmetic because the panes do not wrap.
 */
export function buildConnectors(
  model: MergeModel,
  leftPane: "ours" | "result",
  rightPane: "result" | "theirs",
  geometry: DividerGeometry,
): Connector[] {
  const { lineHeight, viewportHeight, width } = geometry;
  const connectors: Connector[] = [];
  for (const chunk of model.chunks) {
    const left: LineRange = chunk[leftPane];
    const right: LineRange = chunk[rightPane];
    const leftTop = lineY(left.start, geometry.leftOrigin, geometry.leftScrollTop, lineHeight);
    const leftBottom = lineY(left.end, geometry.leftOrigin, geometry.leftScrollTop, lineHeight);
    const rightTop = lineY(right.start, geometry.rightOrigin, geometry.rightScrollTop, lineHeight);
    const rightBottom = lineY(right.end, geometry.rightOrigin, geometry.rightScrollTop, lineHeight);
    const outsideLeft = leftBottom < 0 || leftTop > viewportHeight;
    const outsideRight = rightBottom < 0 || rightTop > viewportHeight;
    if (outsideLeft && outsideRight) continue;
    const middle = width / 2;
    const path =
      `M0 ${leftTop}C${middle} ${leftTop} ${middle} ${rightTop} ${width} ${rightTop}` +
      `L${width} ${rightBottom}C${middle} ${rightBottom} ${middle} ${leftBottom} 0 ${leftBottom}Z`;
    const sourceTop = leftPane === "ours" ? leftTop : rightTop;
    connectors.push({
      chunkId: chunk.id,
      tone: chunkTone(chunk, "result"),
      path,
      buttonY: Math.min(Math.max(sourceTop, 0), Math.max(0, viewportHeight - lineHeight)),
    });
  }
  return connectors;
}
