import { chunkWordRanges, type Merge3Lines, type WordRange } from "@t3tools/shared/merge3";

import { mapLine, type MergeChunk, type MergeModel, type MergePane } from "./mergeModel";
import {
  buildConnectors,
  buildPaneCss,
  buildWordHighlightCss,
  chunkTone,
  paneLineTones,
  type ChunkTone,
  type Connector,
} from "./mergePresentation";

export const MERGE_DIVIDER_WIDTH = 56;
const PANES: ReadonlyArray<MergePane> = ["ours", "result", "theirs"];
const TONES: ReadonlyArray<ChunkTone> = ["conflict", "change", "applied", "settled"];
const STYLE_ATTRIBUTE = "data-merge-view-style";

export interface DividerSnapshot {
  readonly left: ReadonlyArray<Connector>;
  readonly right: ReadonlyArray<Connector>;
  readonly viewportHeight: number;
}

const EMPTY_SNAPSHOT: DividerSnapshot = { left: [], right: [], viewportHeight: 0 };

interface PaneState {
  wrapper: HTMLElement | null;
  scroller: HTMLElement | null;
  host: HTMLElement | null;
  style: HTMLStyleElement | null;
  css: string;
  /** The scrollTop this controller last assigned, so the event it causes is not taken as the user's. */
  expectedScrollTop: number | undefined;
}

interface PaneMetrics {
  readonly lineHeight: number;
  /** Where line 0 starts in the pane's scrolling content. */
  readonly origin: number;
  readonly first: number;
  readonly last: number;
}

const supportsWordHighlights = () =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

function rowsOf(host: HTMLElement | null): HTMLElement[] {
  const rows = host?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line][data-line-index]");
  return rows ? [...rows] : [];
}

function measure(scroller: HTMLElement, host: HTMLElement | null): PaneMetrics | null {
  const rows = rowsOf(host);
  const first = rows[0];
  const last = rows.at(-1);
  if (first === undefined || last === undefined) return null;
  const firstIndex = Number(first.dataset.lineIndex);
  const lastIndex = Number(last.dataset.lineIndex);
  const scrollerTop = scroller.getBoundingClientRect().top;
  const firstRect = first.getBoundingClientRect();
  const lineHeight =
    lastIndex > firstIndex
      ? (last.getBoundingClientRect().top - firstRect.top) / (lastIndex - firstIndex)
      : firstRect.height;
  if (!(lineHeight > 0)) return null;
  const firstTop = firstRect.top - scrollerTop + scroller.scrollTop;
  return {
    lineHeight,
    origin: firstTop - firstIndex * lineHeight,
    first: firstIndex,
    last: lastIndex,
  };
}

/** A DOM range over `[start, end)` columns of one rendered row's text. */
function rangeInRow(row: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

/**
 * Everything about the three panes that has to touch the DOM: scroll sync, the row tints and word
 * highlights written into each pane's shadow root, and the geometry the dividers draw from. It
 * redraws at most once per animation frame, and only the rows pierre has rendered.
 */
export class MergeViewController {
  readonly #lines: Merge3Lines;
  readonly #id: string;
  readonly #panes: Record<MergePane, PaneState> = {
    ours: {
      wrapper: null,
      scroller: null,
      host: null,
      style: null,
      css: "",
      expectedScrollTop: undefined,
    },
    result: {
      wrapper: null,
      scroller: null,
      host: null,
      style: null,
      css: "",
      expectedScrollTop: undefined,
    },
    theirs: {
      wrapper: null,
      scroller: null,
      host: null,
      style: null,
      css: "",
      expectedScrollTop: undefined,
    },
  };
  readonly #listeners = new Set<() => void>();
  readonly #wordRanges = new Map<number, { ours: WordRange[]; theirs: WordRange[] }>();
  readonly #highlightNames = new Set<string>();
  readonly #scrollHandlers = new Map<MergePane, () => void>();
  #model: MergeModel;
  #resultLineCount: number;
  #snapshot: DividerSnapshot = EMPTY_SNAPSHOT;
  #frame: number | null = null;
  #disposed = false;

  constructor(input: { lines: Merge3Lines; model: MergeModel; id: string }) {
    this.#lines = input.lines;
    this.#model = input.model;
    this.#id = input.id;
    this.#resultLineCount = input.lines.base.length;
  }

  // React hands these to useSyncExternalStore, so they are arrow properties.
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = () => this.#snapshot;

  setModel(model: MergeModel, resultLineCount: number) {
    this.#model = model;
    this.#resultLineCount = resultLineCount;
    this.scheduleRedraw();
  }

  /** Registers the element wrapping a pane's virtualizer; null when it unmounts. */
  registerPane(pane: MergePane, wrapper: HTMLElement | null) {
    const state = this.#panes[pane];
    const previous = this.#scrollHandlers.get(pane);
    if (previous !== undefined && state.scroller !== null) {
      state.scroller.removeEventListener("scroll", previous);
    }
    this.#scrollHandlers.delete(pane);
    state.wrapper = wrapper;
    state.scroller =
      wrapper?.firstElementChild instanceof HTMLElement ? wrapper.firstElementChild : null;
    if (state.scroller !== null) {
      const handler = () => this.#onScroll(pane);
      this.#scrollHandlers.set(pane, handler);
      state.scroller.addEventListener("scroll", handler, { passive: true });
    }
    this.scheduleRedraw();
  }

  /** Called from pierre's `onPostRender` for each pane, after rows were (re)rendered. */
  handlePostRender(pane: MergePane, container: HTMLElement, phase: string) {
    const state = this.#panes[pane];
    if (phase === "unmount") {
      state.host = null;
      state.style?.remove();
      state.style = null;
      return;
    }
    state.host = container;
    this.scheduleRedraw();
  }

  /** Scrolls the result pane so `line` sits a third of the way down; the other panes follow. */
  revealResultLine(line: number) {
    const state = this.#panes.result;
    if (state.scroller === null) return;
    const metrics = measure(state.scroller, state.host);
    if (metrics === null) return;
    const top = metrics.origin + line * metrics.lineHeight - state.scroller.clientHeight / 3;
    state.scroller.scrollTop = Math.max(0, top);
  }

  /** The result line at the top of the pane, for navigation when there is no caret. */
  topResultLine(): number {
    const state = this.#panes.result;
    if (state.scroller === null) return 0;
    const metrics = measure(state.scroller, state.host);
    return metrics === null
      ? 0
      : Math.max(0, Math.floor((state.scroller.scrollTop - metrics.origin) / metrics.lineHeight));
  }

  scheduleRedraw() {
    if (this.#frame !== null || this.#disposed) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#redraw();
    });
  }

  /** Starts (or, after a strict-mode remount, restarts) drawing. */
  activate() {
    this.#disposed = false;
    this.scheduleRedraw();
  }

  /**
   * Stops drawing and removes what this controller put in the document. Scroll listeners belong
   * to the pane registrations, which React releases itself.
   */
  dispose() {
    this.#disposed = true;
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    for (const pane of PANES) this.#panes[pane].style?.remove();
    if (supportsWordHighlights()) {
      for (const name of this.#highlightNames) CSS.highlights.delete(name);
    }
    this.#highlightNames.clear();
  }

  #totals(): Record<MergePane, number> {
    return {
      ours: this.#lines.ours.length,
      result: this.#resultLineCount,
      theirs: this.#lines.theirs.length,
    };
  }

  #onScroll(leader: MergePane) {
    const state = this.#panes[leader];
    const scroller = state.scroller;
    if (scroller === null) return;
    const expected = state.expectedScrollTop;
    if (expected !== undefined && Math.abs(scroller.scrollTop - expected) <= 1) {
      // The echo of a scroll this controller made to follow another pane.
      state.expectedScrollTop = undefined;
      this.scheduleRedraw();
      return;
    }
    state.expectedScrollTop = undefined;
    const metrics = measure(scroller, state.host);
    if (metrics !== null) {
      const topLine = Math.max(0, (scroller.scrollTop - metrics.origin) / metrics.lineHeight);
      for (const pane of PANES) {
        if (pane === leader) continue;
        this.#followTo(pane, mapLine(this.#model, leader, pane, topLine, this.#totals()));
      }
    }
    this.scheduleRedraw();
  }

  #followTo(pane: MergePane, targetLine: number) {
    const state = this.#panes[pane];
    if (state.scroller === null) return;
    const metrics = measure(state.scroller, state.host);
    if (metrics === null) return;
    state.scroller.scrollTop = metrics.origin + targetLine * metrics.lineHeight;
    state.expectedScrollTop = state.scroller.scrollTop;
    // No scroll event follows when the position did not change, so the mark must not outlive the frame.
    requestAnimationFrame(() => {
      state.expectedScrollTop = undefined;
    });
  }

  #redraw() {
    if (this.#disposed) return;
    const metrics = {} as Record<MergePane, PaneMetrics | null>;
    for (const pane of PANES) {
      const state = this.#panes[pane];
      metrics[pane] = state.scroller === null ? null : measure(state.scroller, state.host);
    }
    for (const pane of PANES) this.#paintPane(pane, metrics[pane]);
    this.#publishDividers(metrics);
  }

  #ensureStyle(state: PaneState): HTMLStyleElement | null {
    const root = state.host?.shadowRoot;
    if (root === null || root === undefined) return null;
    if (state.style === null || !state.style.isConnected) {
      state.style = document.createElement("style");
      state.style.setAttribute(STYLE_ATTRIBUTE, "");
      state.css = "";
      root.append(state.style);
    }
    return state.style;
  }

  #highlightName(pane: MergePane, tone: ChunkTone) {
    return `merge-word-${this.#id}-${pane}-${tone}`;
  }

  #paintPane(pane: MergePane, metrics: PaneMetrics | null) {
    const state = this.#panes[pane];
    const style = this.#ensureStyle(state);
    if (style === null) return;
    const window =
      metrics === null ? { first: 0, last: -1 } : { first: metrics.first, last: metrics.last };
    const names = Object.fromEntries(
      TONES.map((tone) => [tone, this.#highlightName(pane, tone)]),
    ) as Record<ChunkTone, string>;
    const css = [
      buildPaneCss(paneLineTones(this.#model, pane, window)),
      supportsWordHighlights() && pane !== "result" ? buildWordHighlightCss(names) : "",
    ].join("\n");
    // Rewriting an identical sheet would restyle every rendered row for nothing.
    if (css !== state.css) {
      style.textContent = css;
      state.css = css;
    }
    if (pane !== "result") this.#paintWords(pane, window, names);
  }

  #wordRangesFor(chunk: MergeChunk) {
    let ranges = this.#wordRanges.get(chunk.id);
    if (ranges === undefined) {
      ranges = chunkWordRanges(this.#lines, chunk);
      this.#wordRanges.set(chunk.id, ranges);
    }
    return ranges;
  }

  #paintWords(
    pane: "ours" | "theirs",
    window: { first: number; last: number },
    names: Record<ChunkTone, string>,
  ) {
    if (!supportsWordHighlights()) return;
    const state = this.#panes[pane];
    const root = state.host?.shadowRoot;
    const byTone = new Map<ChunkTone, Range[]>();
    if (root !== null && root !== undefined) {
      for (const chunk of this.#model.chunks) {
        const side = chunk[pane];
        // Only regions with rendered rows pay for a word diff.
        if (side.end <= window.first || side.start > window.last || side.start === side.end)
          continue;
        const tone = chunkTone(chunk, pane);
        for (const word of this.#wordRangesFor(chunk)[pane]) {
          if (word.line < window.first || word.line > window.last) continue;
          const row = root.querySelector<HTMLElement>(
            `[data-line][data-line-index="${word.line}"]`,
          );
          const range = row === null ? null : rangeInRow(row, word.start, word.end);
          if (range === null) continue;
          const ranges = byTone.get(tone);
          if (ranges === undefined) byTone.set(tone, [range]);
          else ranges.push(range);
        }
      }
    }
    for (const tone of TONES) {
      const name = names[tone];
      this.#highlightNames.add(name);
      const ranges = byTone.get(tone);
      if (ranges === undefined) CSS.highlights.delete(name);
      else CSS.highlights.set(name, new Highlight(...ranges));
    }
  }

  #publishDividers(metrics: Record<MergePane, PaneMetrics | null>) {
    const ours = this.#panes.ours.scroller;
    const result = this.#panes.result.scroller;
    const theirs = this.#panes.theirs.scroller;
    let next: DividerSnapshot = EMPTY_SNAPSHOT;
    if (
      ours !== null &&
      result !== null &&
      theirs !== null &&
      metrics.ours !== null &&
      metrics.result !== null &&
      metrics.theirs !== null
    ) {
      const viewportHeight = result.clientHeight;
      const shared = {
        lineHeight: metrics.result.lineHeight,
        viewportHeight,
        width: MERGE_DIVIDER_WIDTH,
      };
      next = {
        viewportHeight,
        left: buildConnectors(this.#model, "ours", "result", {
          ...shared,
          lineHeight: metrics.ours.lineHeight,
          leftOrigin: metrics.ours.origin,
          leftScrollTop: ours.scrollTop,
          rightOrigin: metrics.result.origin,
          rightScrollTop: result.scrollTop,
        }),
        right: buildConnectors(this.#model, "result", "theirs", {
          ...shared,
          leftOrigin: metrics.result.origin,
          leftScrollTop: result.scrollTop,
          rightOrigin: metrics.theirs.origin,
          rightScrollTop: theirs.scrollTop,
        }),
      };
    }
    if (sameSnapshot(this.#snapshot, next)) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}

function sameSnapshot(a: DividerSnapshot, b: DividerSnapshot): boolean {
  if (a === b) return true;
  if (a.viewportHeight !== b.viewportHeight) return false;
  const sameList = (x: ReadonlyArray<Connector>, y: ReadonlyArray<Connector>) =>
    x.length === y.length &&
    x.every((connector, index) => {
      const other = y[index]!;
      return (
        connector.chunkId === other.chunkId &&
        connector.tone === other.tone &&
        connector.path === other.path &&
        connector.buttonY === other.buttonY
      );
    });
  return sameList(a.left, b.left) && sameList(a.right, b.right);
}
