import { computeMerge3, splitLines } from "@t3tools/shared/merge3";
import { describe, expect, it } from "vite-plus/test";

import { createMergeModel, planChunkAction } from "./mergeModel";
import {
  buildConnectors,
  buildPaneCss,
  buildWordHighlightCss,
  chunkTone,
  paneLineTones,
} from "./mergePresentation";

const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join("");
const BASE = text("a", "b", "c", "d", "e");
const OURS = text("a", "O1", "O2", "c", "d", "E");
const THEIRS = text("a", "T", "c", "D", "e");

const merge = computeMerge3({ base: BASE, ours: OURS, theirs: THEIRS });
const model = createMergeModel(
  { base: splitLines(BASE), ours: splitLines(OURS), theirs: splitLines(THEIRS) },
  merge,
);

describe("chunkTone", () => {
  it("shows an undecided conflict the same way in every pane", () => {
    for (const pane of ["ours", "result", "theirs"] as const) {
      expect(chunkTone(model.chunks[0]!, pane)).toBe("conflict");
    }
  });

  it("reads applied one-sided work as a change and decided conflicts as applied", () => {
    expect(chunkTone(model.chunks[1]!, "result")).toBe("change");
    const accepted = {
      ...model.chunks[0]!,
      state: "accepted-ours" as const,
    };
    expect(chunkTone(accepted, "result")).toBe("applied");
    expect(chunkTone(accepted, "ours")).toBe("change");
    expect(chunkTone({ ...accepted, state: "resolved" }, "theirs")).toBe("settled");
    expect(chunkTone({ ...accepted, state: "ignored-ours", kind: "ours" }, "result")).toBe(
      "settled",
    );
  });
});

describe("pane styling", () => {
  it("lists only the lines of a region that are rendered", () => {
    const tones = paneLineTones(model, "ours", { first: 2, last: 2 });
    expect(tones).toEqual([{ line: 2, tone: "conflict" }]);
    expect(paneLineTones(model, "result", { first: 0, last: 0 })).toEqual([]);
  });

  it("writes one rule per tone using the pane's own line indexes", () => {
    const css = buildPaneCss([
      { line: 1, tone: "conflict" },
      { line: 2, tone: "conflict" },
      { line: 4, tone: "applied" },
    ]);
    expect(css).toContain('[data-line][data-line-index="1"],[data-line][data-line-index="2"]');
    expect(css).toContain(
      "--diffs-line-bg:color-mix(in srgb, var(--warning) 20%, transparent) !important",
    );
    expect(css).toContain('[data-column-number][data-line-index="4"]');
    expect(css).toContain("var(--diff-addition)");
  });

  it("is empty with nothing to tint", () => {
    expect(buildPaneCss([])).toBe("");
  });

  it("registers a highlight style per tone", () => {
    const css = buildWordHighlightCss({
      conflict: "w-conflict",
      change: "w-change",
      applied: "w-applied",
      settled: "w-settled",
    });
    expect(css).toContain("::highlight(w-conflict)");
    expect(css.split("\n")).toHaveLength(4);
  });
});

describe("buildConnectors", () => {
  const geometry = {
    lineHeight: 20,
    leftOrigin: 0,
    rightOrigin: 0,
    leftScrollTop: 0,
    rightScrollTop: 0,
    viewportHeight: 100,
    width: 40,
  };

  it("joins a region's lines in the side pane to its lines in the result", () => {
    const [first] = buildConnectors(model, "ours", "result", geometry);
    // Region 0: ours lines 1..3, result lines 1..2.
    expect(first).toMatchObject({ chunkId: 0, tone: "conflict" });
    expect(first!.path.startsWith("M0 20C20 20 20 20 40 20L40 40C20 40 20 60 0 60Z")).toBe(true);
    expect(first!.buttonY).toBe(20);
  });

  it("follows each pane's own scroll position", () => {
    const [first] = buildConnectors(model, "ours", "result", {
      ...geometry,
      leftScrollTop: 10,
      rightScrollTop: 0,
    });
    expect(first!.path.startsWith("M0 10C20 10 20 20 40 20")).toBe(true);
  });

  it("leaves out regions with neither end in view", () => {
    const connectors = buildConnectors(model, "ours", "result", {
      ...geometry,
      leftScrollTop: 1000,
      rightScrollTop: 1000,
    });
    expect(connectors).toEqual([]);
  });

  it("keeps a region that is only partly in view and clamps its buttons", () => {
    const connectors = buildConnectors(model, "ours", "result", {
      ...geometry,
      leftScrollTop: 30,
      rightScrollTop: 30,
    });
    expect(connectors.map((connector) => connector.chunkId)).toContain(0);
    for (const connector of connectors) {
      expect(connector.buttonY).toBeGreaterThanOrEqual(0);
      expect(connector.buttonY).toBeLessThanOrEqual(80);
    }
  });

  it("anchors the right divider's buttons to the theirs pane", () => {
    const connectors = buildConnectors(model, "result", "theirs", geometry);
    expect(connectors.find((connector) => connector.chunkId === 0)!.buttonY).toBe(20);
  });

  it("reflects an action in the tone it draws", () => {
    const plan = planChunkAction(
      model,
      0,
      { type: "accept", side: "ours" },
      {
        textOf: () => "b\n",
        lineCount: 6,
        endPosition: { line: 5, character: 0 },
      },
    );
    expect(plan?.states.get(0)).toBe("accepted-ours");
  });
});
