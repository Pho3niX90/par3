import { TextDocument } from "@pierre/diffs/edit";
import { describe, expect, it } from "vite-plus/test";

// The three-pane merge view builds its undo on these properties of the pierre editor's document.
// A pierre upgrade that changes one of them breaks undo there, so they are pinned.

const range = (
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
) => ({
  start: { line: startLine, character: startCharacter },
  end: { line: endLine, character: endCharacter },
});

describe("pierre edit history contract", () => {
  it("records a multi-edit batch as one undo step reported in pre-edit coordinates", () => {
    const document = new TextDocument("f", "a\nb\nc\nd\n");
    const change = document.applyEdits([
      { range: range(1, 0, 2, 0), newText: "B1\nB2\n" },
      { range: range(3, 0, 3, 0), newText: "X\n" },
    ]);
    expect(change?.changes.map(({ start, end, text }) => [start, end, text])).toEqual([
      [2, 4, "B1\nB2\n"],
      [6, 6, "X\n"],
    ]);
    expect(document.history.undoStack).toHaveLength(1);
    document.undo();
    expect(document.getText()).toBe("a\nb\nc\nd\n");
    expect(document.history.undoStack).toHaveLength(0);
  });

  it("gives an empty insertion its own undoable step, which is how a state-only action is recorded", () => {
    const document = new TextDocument("f", "a\nb\n");
    expect(document.applyEdits([])).toBeUndefined();
    const change = document.applyEdits([{ range: range(1, 0, 1, 0), newText: "" }]);
    expect(change?.changes).toHaveLength(1);
    expect(document.history.undoStack).toHaveLength(1);
    expect(document.undo()?.[0].changes).toHaveLength(1);
    expect(document.getText()).toBe("a\nb\n");
    expect(document.redo()).toBeDefined();
    expect(document.history.undoStack).toHaveLength(1);
  });

  it("keeps an entry's identity across undo and redo, and replaces it when typing coalesces", () => {
    const document = new TextDocument("f", "a\n");
    document.applyEdits([{ range: range(0, 1, 0, 1), newText: "x" }]);
    const first = document.history.undoStack.at(-1);
    document.applyEdits([{ range: range(0, 2, 0, 2), newText: "y" }]);
    const coalesced = document.history.undoStack.at(-1);
    expect(document.history.undoStack).toHaveLength(1);
    expect(coalesced).not.toBe(first);

    document.applyEdits([{ range: range(0, 0, 1, 0), newText: "Q\n" }]);
    const replaced = document.history.undoStack.at(-1);
    document.undo();
    expect(document.history.undoStack.at(-1)).toBe(coalesced);
    document.redo();
    expect(document.history.undoStack.at(-1)).toBe(replaced);
  });

  it("lets an undo boundary on the previous entry keep a later single-line insert from merging into it", () => {
    const merged = new TextDocument("f", "a\n");
    merged.applyEdits([{ range: range(0, 1, 0, 1), newText: "x" }]);
    merged.applyEdits([{ range: range(0, 2, 0, 2), newText: "y" }]);
    expect(merged.history.undoStack).toHaveLength(1);

    const separated = new TextDocument("f", "a\n");
    separated.applyEdits([{ range: range(0, 1, 0, 1), newText: "x" }]);
    separated.history.undoStack.at(-1)!.undoBoundary = true;
    separated.applyEdits([{ range: range(0, 2, 0, 2), newText: "y" }]);
    expect(separated.history.undoStack).toHaveLength(2);
  });
});
