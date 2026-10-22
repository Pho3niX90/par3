import { TextDocument } from "@pierre/diffs/edit";
import { computeMerge3, splitLines } from "@t3tools/shared/merge3";
import { describe, expect, it } from "vite-plus/test";

import {
  applyUserEdit,
  chunkActionAvailability,
  chunkAtLine,
  createMergeModel,
  findConflict,
  isUnresolved,
  mapLine,
  MergeTimeline,
  planApplyNonConflicting,
  planChunkAction,
  planResolveSimple,
  shiftModel,
  summarizeModel,
  type ChunkAction,
  type ChunkState,
  type MergeModel,
  type ModelTextChange,
} from "./mergeModel";

const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join("");

// b: both sides edit it (conflict). d: only theirs. f: only ours. h: a word-level conflict.
const BASE = text("a", "b", "c", "d", "e", "f", "g", "call(a, b)", "i");
const OURS = text("a", "OB", "c", "d", "e", "OF", "g", "call(x, b)", "i");
const THEIRS = text("a", "TB", "c", "TD", "e", "f", "g", "call(a, y)", "i");

function build(options: { resolveSimple?: boolean } = {}) {
  const lines = {
    base: splitLines(BASE),
    ours: splitLines(OURS),
    theirs: splitLines(THEIRS),
  };
  const merge = computeMerge3(
    { base: BASE, ours: OURS, theirs: THEIRS },
    { resolveSimple: options.resolveSimple ?? false },
  );
  return { merge, model: createMergeModel(lines, merge) };
}

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});
const change = (
  sl: number,
  sc: number,
  el: number,
  ec: number,
  newText: string,
): ModelTextChange => ({ range: range(sl, sc, el, ec), text: newText });

/** A result document and timeline wired the way the view wires the editor. */
function session(options: { resolveSimple?: boolean } = {}) {
  const { merge, model } = build(options);
  const document = new TextDocument("result", merge.initialResult);
  const timeline = new MergeTimeline<object>(model);
  const context = () => ({
    textOf: (r: { start: number; end: number }) =>
      document.getText({
        start: { line: r.start, character: 0 },
        end: { line: r.end, character: 0 },
      }),
    lineCount: document.lineCount,
    endPosition: document.positionAt(document.getText().length),
  });
  const afterChange = (
    result: ReturnType<TextDocument["applyEdits"]>,
    planned?: ReadonlyMap<number, ChunkState>,
  ) => {
    if (result === undefined) return;
    timeline.update(document.history.undoStack.at(-1), result.changes, planned);
  };
  return {
    document,
    timeline,
    get model() {
      return timeline.model;
    },
    act(chunkId: number, action: ChunkAction) {
      const plan = planChunkAction(timeline.model, chunkId, action, context());
      if (plan === null) return false;
      afterChange(document.applyEdits([...plan.edits]), plan.states);
      return true;
    },
    applyPlan(plan: ReturnType<typeof planApplyNonConflicting>) {
      if (plan === null) return false;
      afterChange(document.applyEdits([...plan.edits]), plan.states);
      return true;
    },
    type(at: { line: number; character: number }, value: string) {
      afterChange(document.applyEdits([{ range: { start: at, end: at }, newText: value }]));
    },
    undo() {
      const result = document.undo();
      if (result) timeline.update(document.history.undoStack.at(-1), result[0].changes);
    },
    redo() {
      const result = document.redo();
      if (result) timeline.update(document.history.undoStack.at(-1), result[0].changes);
    },
    context,
    chunkState: (id: number) => timeline.model.chunks[id]!.state,
  };
}

describe("createMergeModel", () => {
  it("starts one-sided changes applied and conflicts pending", () => {
    const { model } = build();
    expect(model.chunks.map((chunk) => [chunk.kind, chunk.state])).toEqual([
      ["conflict", "pending"],
      ["theirs", "accepted-theirs"],
      ["ours", "accepted-ours"],
      ["conflict", "pending"],
    ]);
    expect(summarizeModel(model)).toEqual({ changes: 4, conflicts: 2 });
  });

  it("carries each side's text so actions need no other source", () => {
    const { model } = build();
    expect(model.chunks[0]).toMatchObject({
      baseText: "b\n",
      oursText: "OB\n",
      theirsText: "TB\n",
    });
  });

  it("marks regions merged by a word-level re-merge as resolved", () => {
    const { model } = build({ resolveSimple: true });
    expect(model.chunks.at(-1)).toMatchObject({ kind: "auto-resolved", state: "resolved" });
    expect(summarizeModel(model).conflicts).toBe(1);
  });
});

describe("shiftModel", () => {
  const { model } = build();
  const starts = (m: MergeModel) => m.chunks.map((chunk) => [chunk.result.start, chunk.result.end]);

  it("leaves ranges alone for an edit that stays within a line", () => {
    expect(starts(shiftModel(model, [change(4, 0, 4, 1, "Q")]))).toEqual(starts(model));
  });

  it("moves later chunks by the lines an earlier edit adds or removes", () => {
    const grown = shiftModel(model, [change(0, 1, 0, 1, "\nnew")]);
    expect(starts(grown)).toEqual(starts(model).map(([s, e]) => [s! + 1, e! + 1]));
    const shrunk = shiftModel(model, [change(0, 0, 1, 0, "")]);
    expect(starts(shrunk)).toEqual(starts(model).map(([s, e]) => [s! - 1, e! - 1]));
  });

  it("grows a chunk for text typed inside it and keeps chunks after it in step", () => {
    const grown = shiftModel(model, [change(1, 1, 1, 1, "\nmore")]);
    expect(grown.chunks[0]!.result).toEqual({ start: 1, end: 3 });
    expect(grown.chunks[1]!.result).toEqual({ start: 4, end: 5 });
  });

  it("puts text typed at a chunk's first character inside it and at its end outside", () => {
    const atStart = shiftModel(model, [change(1, 0, 1, 0, "x\n")]);
    expect(atStart.chunks[0]!.result).toEqual({ start: 1, end: 3 });
    const atEnd = shiftModel(model, [change(2, 0, 2, 0, "x\n")]);
    expect(atEnd.chunks[0]!.result).toEqual({ start: 1, end: 2 });
    expect(atEnd.chunks[1]!.result).toEqual({ start: 4, end: 5 });
  });

  it("collapses a chunk whose lines were deleted and pulls a spanning delete's edges in", () => {
    const deleted = shiftModel(model, [change(1, 0, 2, 0, "")]);
    expect(deleted.chunks[0]!.result).toEqual({ start: 1, end: 1 });
    const spanning = shiftModel(model, [change(0, 1, 3, 1, "")]);
    expect(spanning.chunks[0]!.result.start).toBeLessThanOrEqual(spanning.chunks[0]!.result.end);
    expect(spanning.chunks[1]!.result.start).toBeGreaterThanOrEqual(0);
  });

  it("applies several changes of one report from the last to the first", () => {
    const shifted = shiftModel(model, [change(0, 0, 0, 0, "x\n"), change(4, 0, 4, 0, "y\nz\n")]);
    expect(shifted.chunks[0]!.result).toEqual({ start: 2, end: 3 });
    // The second change sits at chunk 1's end, so that chunk only moves for the first one.
    expect(shifted.chunks[1]!.result).toEqual({ start: 4, end: 5 });
    expect(shifted.chunks[2]!.result).toEqual({ start: 8, end: 9 });
  });

  it("lets an empty chunk grow when text is typed into it", () => {
    const emptied = shiftModel(model, [change(1, 0, 2, 0, "")]);
    const regrown = shiftModel(emptied, [change(1, 0, 1, 0, "back\n")]);
    expect(regrown.chunks[0]!.result).toEqual({ start: 1, end: 2 });
  });
});

describe("user edits", () => {
  const { model } = build();

  it("mark the chunks they touch as edited, and only those", () => {
    const edited = applyUserEdit(model, [change(1, 1, 1, 1, "!")]);
    expect(edited.chunks.map((chunk) => chunk.state)).toEqual([
      "edited",
      "accepted-theirs",
      "accepted-ours",
      "pending",
    ]);
    expect(isUnresolved(edited.chunks[0]!)).toBe(false);
    expect(summarizeModel(edited).conflicts).toBe(1);
  });

  it("do not mark a chunk for an edit that only borders it", () => {
    const next = applyUserEdit(model, [change(2, 0, 2, 0, "inserted\n")]);
    expect(next.chunks[0]!.state).toBe("pending");
    const before = applyUserEdit(model, [change(0, 0, 1, 0, "")]);
    expect(before.chunks[0]!.state).toBe("pending");
  });
});

describe("chunk actions", () => {
  it("accept ours replaces the base text and resolves the conflict", () => {
    const s = session();
    expect(s.act(0, { type: "accept", side: "ours" })).toBe(true);
    expect(s.document.getText()).toBe(
      text("a", "OB", "c", "TD", "e", "OF", "g", "call(a, b)", "i"),
    );
    expect(s.chunkState(0)).toBe("accepted-ours");
    expect(summarizeModel(s.model).conflicts).toBe(1);
    expect(s.model.chunks.map((chunk) => chunk.result)).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
      { start: 5, end: 6 },
      { start: 7, end: 8 },
    ]);
  });

  it("takes the second side as well for a real conflict, always writing ours first", () => {
    const s = session();
    s.act(0, { type: "accept", side: "theirs" });
    s.act(0, { type: "accept", side: "ours" });
    expect(s.document.getText().split("\n").slice(0, 4)).toEqual(["a", "OB", "TB", "c"]);
    expect(s.chunkState(0)).toBe("accepted-both");
  });

  it("accept both honours the requested order and grows the chunk", () => {
    const s = session();
    s.act(0, { type: "acceptBoth", order: "theirs-first" });
    expect(s.document.getText().split("\n").slice(0, 4)).toEqual(["a", "TB", "OB", "c"]);
    expect(s.model.chunks[0]!.result).toEqual({ start: 1, end: 3 });
    expect(s.model.chunks[1]!.result).toEqual({ start: 4, end: 5 });
    const t = session();
    t.act(0, { type: "acceptBoth", order: "ours-first" });
    expect(t.document.getText().split("\n").slice(0, 4)).toEqual(["a", "OB", "TB", "c"]);
  });

  it("accept on a one-sided chunk replaces instead of appending", () => {
    const s = session();
    s.act(1, { type: "accept", side: "ours" });
    expect(s.document.getText().split("\n")[3]).toBe("d");
    expect(s.chunkState(1)).toBe("accepted-ours");
  });

  it("does nothing when asked for what is already in place", () => {
    const s = session();
    s.act(0, { type: "accept", side: "ours" });
    expect(s.act(0, { type: "accept", side: "ours" })).toBe(false);
    expect(s.act(2, { type: "accept", side: "ours" })).toBe(false);
  });

  it("ignoring a side keeps the base text and leaves the conflict open until the other side is handled", () => {
    const s = session();
    const before = s.document.getText();
    s.act(0, { type: "ignore", side: "ours" });
    expect(s.document.getText()).toBe(before);
    expect(s.chunkState(0)).toBe("ignored-ours");
    expect(summarizeModel(s.model).conflicts).toBe(2);
    s.act(0, { type: "ignore", side: "theirs" });
    expect(s.chunkState(0)).toBe("resolved");
    expect(summarizeModel(s.model).conflicts).toBe(1);
  });

  it("ignoring an applied side takes it back out", () => {
    const s = session();
    s.act(0, { type: "acceptBoth", order: "ours-first" });
    s.act(0, { type: "ignore", side: "ours" });
    expect(s.document.getText().split("\n").slice(0, 3)).toEqual(["a", "TB", "c"]);
    expect(s.chunkState(0)).toBe("accepted-theirs");
    s.act(1, { type: "ignore", side: "theirs" });
    expect(s.document.getText().split("\n")[3]).toBe("d");
    expect(s.chunkState(1)).toBe("ignored-theirs");
    expect(s.act(1, { type: "ignore", side: "ours" })).toBe(true);
  });

  it("refuses to ignore the side that never changed a one-sided chunk", () => {
    const s = session();
    expect(s.act(1, { type: "ignore", side: "ours" })).toBe(false);
  });

  it("replaces a user's edit when a side is accepted", () => {
    const s = session();
    s.type({ line: 1, character: 1 }, "!!");
    expect(s.chunkState(0)).toBe("edited");
    s.act(0, { type: "accept", side: "theirs" });
    expect(s.document.getText().split("\n")[1]).toBe("TB");
    expect(s.chunkState(0)).toBe("accepted-theirs");
  });

  it("leaves a user's edit alone when a side is ignored", () => {
    const s = session();
    s.type({ line: 1, character: 1 }, "!!");
    expect(s.act(0, { type: "ignore", side: "ours" })).toBe(false);
  });

  it("clamps an accept at the end of a file without a trailing newline", () => {
    const base = "a\nb";
    const merge = computeMerge3({ base, ours: "a\nO", theirs: "a\nT" });
    const model = createMergeModel(
      { base: splitLines(base), ours: splitLines("a\nO"), theirs: splitLines("a\nT") },
      merge,
    );
    const document = new TextDocument("r", merge.initialResult);
    const plan = planChunkAction(
      model,
      0,
      { type: "accept", side: "theirs" },
      {
        textOf: (r) =>
          document.getText({
            start: { line: r.start, character: 0 },
            end: { line: r.end, character: 0 },
          }),
        lineCount: document.lineCount,
        endPosition: document.positionAt(document.getText().length),
      },
    );
    document.applyEdits([...plan!.edits]);
    expect(document.getText()).toBe("a\nT");
  });
});

describe("apply non-conflicting", () => {
  it("re-applies only the changes of the chosen side that were taken back out", () => {
    const s = session();
    s.act(1, { type: "ignore", side: "theirs" });
    s.act(2, { type: "ignore", side: "ours" });
    expect(s.document.getText()).toBe(BASE);

    expect(s.applyPlan(planApplyNonConflicting(s.model, "left", s.context()))).toBe(true);
    expect(s.chunkState(2)).toBe("accepted-ours");
    expect(s.chunkState(1)).toBe("ignored-theirs");

    expect(s.applyPlan(planApplyNonConflicting(s.model, "right", s.context()))).toBe(true);
    expect(s.chunkState(1)).toBe("accepted-theirs");
    expect(s.document.getText().split("\n")[3]).toBe("TD");
  });

  it("applies both sides at once and never decides a conflict", () => {
    const s = session();
    s.act(1, { type: "ignore", side: "theirs" });
    s.act(2, { type: "ignore", side: "ours" });
    s.applyPlan(planApplyNonConflicting(s.model, "all", s.context()));
    expect(s.chunkState(1)).toBe("accepted-theirs");
    expect(s.chunkState(2)).toBe("accepted-ours");
    expect(s.chunkState(0)).toBe("pending");
  });

  it("has nothing to do when everything is applied", () => {
    const s = session();
    expect(planApplyNonConflicting(s.model, "all", s.context())).toBeNull();
  });
});

describe("resolve simple", () => {
  it("merges the word-level conflict and leaves the real one", () => {
    const s = session();
    const plan = planResolveSimple(s.model, s.context());
    expect(plan?.states.get(3)).toBe("resolved");
    expect(plan?.states.has(0)).toBe(false);
    s.applyPlan(plan);
    expect(s.document.getText()).toContain("call(x, y)");
    expect(summarizeModel(s.model).conflicts).toBe(1);
  });

  it("is a no-op the second time", () => {
    const s = session();
    s.applyPlan(planResolveSimple(s.model, s.context()));
    expect(planResolveSimple(s.model, s.context())).toBeNull();
  });

  it("skips a conflict the user already edited", () => {
    const s = session();
    s.type({ line: 7, character: 0 }, "my ");
    expect(planResolveSimple(s.model, s.context())).toBeNull();
  });
});

describe("navigation", () => {
  const { model } = build();

  it("finds the next and previous unresolved conflict and wraps", () => {
    expect(findConflict(model, 0, "next")?.id).toBe(0);
    expect(findConflict(model, 1, "next")?.id).toBe(3);
    expect(findConflict(model, 7, "next")?.id).toBe(0);
    expect(findConflict(model, 7, "previous")?.id).toBe(0);
    expect(findConflict(model, 1, "previous")?.id).toBe(3);
  });

  it("skips conflicts that are settled and reports none when all are", () => {
    const s = session();
    s.act(0, { type: "accept", side: "ours" });
    expect(findConflict(s.model, 0, "next")?.id).toBe(3);
    s.act(3, { type: "accept", side: "theirs" });
    expect(findConflict(s.model, 0, "next")).toBeNull();
  });

  it("finds the chunk under a result line", () => {
    expect(chunkAtLine(model, 1)?.id).toBe(0);
    expect(chunkAtLine(model, 2)).toBeNull();
    expect(chunkAtLine(model, 7)?.id).toBe(3);
  });
});

describe("mapLine", () => {
  // ours grows chunk 0 to three lines; theirs keeps one.
  const base = text("a", "b", "c", "d");
  const ours = text("a", "O1", "O2", "O3", "c", "d");
  const theirs = text("a", "T", "c", "d");
  const merge = computeMerge3({ base, ours, theirs });
  const model = createMergeModel(
    { base: splitLines(base), ours: splitLines(ours), theirs: splitLines(theirs) },
    merge,
  );
  const totals = { ours: 6, result: 4, theirs: 4 };

  it("is the identity within a pane", () => {
    expect(mapLine(model, "ours", "ours", 3, totals)).toBe(3);
  });

  it("maps unchanged code one to one with the right offset", () => {
    expect(mapLine(model, "ours", "result", 4, totals)).toBe(2);
    expect(mapLine(model, "ours", "result", 5, totals)).toBe(3);
    expect(mapLine(model, "result", "ours", 2, totals)).toBe(4);
    expect(mapLine(model, "theirs", "ours", 2, totals)).toBe(4);
  });

  it("interpolates inside a changed region between its edges", () => {
    expect(mapLine(model, "ours", "result", 1, totals)).toBe(1);
    expect(mapLine(model, "ours", "result", 4, totals)).toBe(2);
    const middle = mapLine(model, "ours", "result", 2.5, totals);
    expect(middle).toBeGreaterThan(1);
    expect(middle).toBeLessThan(2);
  });

  it("stays monotonic across the whole file", () => {
    let previous = -1;
    for (let line = 0; line <= 6; line += 0.5) {
      const mapped = mapLine(model, "ours", "theirs", line, totals);
      expect(mapped).toBeGreaterThanOrEqual(previous);
      previous = mapped;
    }
  });
});

describe("undo", () => {
  it("restores the text and the chunk state together", () => {
    const s = session();
    const before = s.document.getText();
    s.act(0, { type: "accept", side: "ours" });
    expect(s.chunkState(0)).toBe("accepted-ours");
    s.undo();
    expect(s.document.getText()).toBe(before);
    expect(s.chunkState(0)).toBe("pending");
    expect(summarizeModel(s.model).conflicts).toBe(2);
    s.redo();
    expect(s.chunkState(0)).toBe("accepted-ours");
    expect(s.document.getText().split("\n")[1]).toBe("OB");
  });

  it("makes a state-only ignore its own undo step", () => {
    const s = session();
    s.act(0, { type: "ignore", side: "ours" });
    expect(s.chunkState(0)).toBe("ignored-ours");
    expect(s.document.history.undoStack).toHaveLength(1);
    s.undo();
    expect(s.chunkState(0)).toBe("pending");
    s.redo();
    expect(s.chunkState(0)).toBe("ignored-ours");
  });

  it("walks back through several actions one at a time", () => {
    const s = session();
    s.act(0, { type: "accept", side: "ours" });
    s.act(3, { type: "accept", side: "theirs" });
    s.act(1, { type: "ignore", side: "theirs" });
    s.undo();
    expect([s.chunkState(1), s.chunkState(3)]).toEqual(["accepted-theirs", "accepted-theirs"]);
    s.undo();
    expect([s.chunkState(3), s.chunkState(0)]).toEqual(["pending", "accepted-ours"]);
    s.undo();
    expect(s.chunkState(0)).toBe("pending");
    expect(s.model).toBe(s.timeline.model);
    expect(s.document.getText()).toBe(
      computeMerge3({ base: BASE, ours: OURS, theirs: THEIRS }).initialResult,
    );
  });

  it("marks a conflict edited when the user types in it, and undo reverts that", () => {
    const s = session();
    s.type({ line: 1, character: 1 }, "x");
    s.type({ line: 1, character: 2 }, "y");
    expect(s.chunkState(0)).toBe("edited");
    expect(s.document.history.undoStack).toHaveLength(1);
    expect(summarizeModel(s.model).conflicts).toBe(1);
    s.undo();
    expect(s.chunkState(0)).toBe("pending");
    expect(s.document.getText().split("\n")[1]).toBe("b");
    s.redo();
    expect(s.chunkState(0)).toBe("edited");
  });

  it("keeps chunk ranges right after typing that adds a line, and after undoing it", () => {
    const s = session();
    s.type({ line: 0, character: 1 }, "\nextra");
    expect(s.model.chunks[0]!.result).toEqual({ start: 2, end: 3 });
    s.undo();
    expect(s.model.chunks[0]!.result).toEqual({ start: 1, end: 2 });
  });

  it("does not let typing merge into the undo step of an action", () => {
    const s = session();
    s.act(0, { type: "accept", side: "ours" });
    const stackAfterAction = s.document.history.undoStack.length;
    s.type({ line: 1, character: 2 }, "z");
    expect(s.document.history.undoStack.length).toBeGreaterThanOrEqual(stackAfterAction);
    s.undo();
    expect(s.chunkState(0)).toBe("accepted-ours");
    expect(s.document.getText().split("\n")[1]).toBe("OB");
  });
});

describe("chunkActionAvailability", () => {
  const { model } = build();

  it("offers a conflict every action and a one-sided change only its own side", () => {
    expect(chunkActionAvailability(model.chunks[0]!)).toEqual({
      acceptOurs: true,
      acceptTheirs: true,
      ignoreOurs: true,
      ignoreTheirs: true,
      acceptBoth: true,
    });
    // chunk 2: only ours changed it and it is applied, so ours can be taken back out.
    expect(chunkActionAvailability(model.chunks[2]!)).toEqual({
      acceptOurs: false,
      acceptTheirs: false,
      ignoreOurs: true,
      ignoreTheirs: false,
      acceptBoth: false,
    });
  });

  it("stops offering what was just done and offers it back after ignoring", () => {
    const s = session();
    s.act(0, { type: "accept", side: "ours" });
    expect(chunkActionAvailability(s.model.chunks[0]!).acceptOurs).toBe(false);
    s.act(2, { type: "ignore", side: "ours" });
    expect(chunkActionAvailability(s.model.chunks[2]!)).toMatchObject({
      acceptOurs: true,
      ignoreOurs: false,
    });
  });
});
