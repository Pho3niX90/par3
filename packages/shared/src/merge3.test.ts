import { describe, expect, it } from "vite-plus/test";

import {
  chunkWordRanges,
  computeMerge3,
  convertLineEndings,
  detectLineEnding,
  isBinaryContent,
  splitLines,
} from "./merge3.ts";

const lines = (...values: string[]) => values.map((value) => `${value}\n`).join("");
const kinds = (result: ReturnType<typeof computeMerge3>) =>
  result.chunks.map((chunk) => chunk.kind);

describe("computeMerge3", () => {
  it("returns no chunks when nothing changed", () => {
    const text = lines("a", "b", "c");
    const result = computeMerge3({ base: text, ours: text, theirs: text });
    expect(result.chunks).toEqual([]);
    expect(result.initialResult).toBe(text);
    expect(result.stats).toEqual({
      changes: 0,
      conflicts: 0,
      autoResolved: 0,
      editLimitExceeded: false,
    });
  });

  it("applies one-sided changes from both directions", () => {
    const base = lines("a", "b", "c", "d", "e");
    const ours = lines("a", "B", "c", "d", "e");
    const theirs = lines("a", "b", "c", "D", "e");
    const result = computeMerge3({ base, ours, theirs });
    expect(kinds(result)).toEqual(["ours", "theirs"]);
    expect(result.initialResult).toBe(lines("a", "B", "c", "D", "e"));
    expect(result.stats.conflicts).toBe(0);
  });

  it("treats the same change on both sides as both-same", () => {
    const base = lines("a", "b", "c");
    const changed = lines("a", "X", "c");
    const result = computeMerge3({ base, ours: changed, theirs: changed });
    expect(kinds(result)).toEqual(["both-same"]);
    expect(result.initialResult).toBe(changed);
  });

  it("reports overlapping edits as a conflict holding the base text", () => {
    const base = lines("a", "b", "c");
    const result = computeMerge3({
      base,
      ours: lines("a", "ours", "c"),
      theirs: lines("a", "theirs", "c"),
    });
    expect(kinds(result)).toEqual(["conflict"]);
    expect(result.initialResult).toBe(base);
    expect(result.chunks[0]).toEqual({
      kind: "conflict",
      base: { start: 1, end: 2 },
      ours: { start: 1, end: 2 },
      theirs: { start: 1, end: 2 },
      result: { start: 1, end: 2 },
    });
  });

  it("conflicts when two sides insert different text at the same point", () => {
    const base = lines("a", "b");
    const result = computeMerge3({
      base,
      ours: lines("a", "ours", "b"),
      theirs: lines("a", "theirs", "b"),
    });
    expect(kinds(result)).toEqual(["conflict"]);
    expect(result.chunks[0]!.base).toEqual({ start: 1, end: 1 });
    expect(result.initialResult).toBe(base);
  });

  it("does not conflict for adjacent edits", () => {
    const base = lines("a", "b", "c", "d");
    const result = computeMerge3({
      base,
      ours: lines("a", "B", "c", "d"),
      theirs: lines("a", "b", "C", "d"),
    });
    expect(kinds(result)).toEqual(["ours", "theirs"]);
    expect(result.initialResult).toBe(lines("a", "B", "C", "d"));
  });

  it("orders an insertion that touches another edit without conflicting", () => {
    const base = lines("a", "b", "c");
    const result = computeMerge3({
      base,
      ours: lines("a", "new", "b", "c"),
      theirs: lines("a", "B", "c"),
    });
    expect(kinds(result)).toEqual(["ours", "theirs"]);
    expect(result.initialResult).toBe(lines("a", "new", "B", "c"));
  });

  it("conflicts when one side edits and the other deletes", () => {
    const base = lines("a", "b", "c");
    const result = computeMerge3({
      base,
      ours: lines("a", "B", "c"),
      theirs: lines("a", "c"),
    });
    expect(kinds(result)).toEqual(["conflict"]);
    expect(result.chunks[0]!.theirs).toEqual({ start: 1, end: 1 });
    expect(result.initialResult).toBe(base);
  });

  it("applies a deletion when the other side did not touch it", () => {
    const base = lines("a", "b", "c");
    const result = computeMerge3({ base, ours: base, theirs: lines("a", "c") });
    expect(kinds(result)).toEqual(["theirs"]);
    expect(result.initialResult).toBe(lines("a", "c"));
  });

  it("treats add/add with different content as one conflict and identical content as both-same", () => {
    const different = computeMerge3({ base: "", ours: lines("x"), theirs: lines("y") });
    expect(kinds(different)).toEqual(["conflict"]);
    expect(different.initialResult).toBe("");

    const same = computeMerge3({ base: "", ours: lines("x"), theirs: lines("x") });
    expect(kinds(same)).toEqual(["both-same"]);
    expect(same.initialResult).toBe(lines("x"));
  });

  it("tracks result ranges as earlier chunks change the line count", () => {
    const base = lines("a", "b", "c", "d", "e");
    const result = computeMerge3({
      base,
      ours: lines("a", "b1", "b2", "b3", "c", "d", "e"),
      theirs: lines("a", "b", "c", "D", "e"),
    });
    expect(result.chunks.map((chunk) => chunk.result)).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 6 },
    ]);
    expect(result.chunks[1]!.ours).toEqual({ start: 5, end: 6 });
    expect(result.chunks[1]!.theirs).toEqual({ start: 3, end: 4 });
  });

  describe("resolveSimple", () => {
    const base = lines("call(a, b)");
    const ours = lines("call(x, b)");
    const theirs = lines("call(a, y)");

    it("keeps the line conflict when resolveSimple is off", () => {
      expect(kinds(computeMerge3({ base, ours, theirs }))).toEqual(["conflict"]);
    });

    it("merges edits to different words on the same line", () => {
      const result = computeMerge3({ base, ours, theirs }, { resolveSimple: true });
      expect(kinds(result)).toEqual(["auto-resolved"]);
      expect(result.initialResult).toBe(lines("call(x, y)"));
      expect(result.stats).toMatchObject({ conflicts: 0, autoResolved: 1 });
    });

    it("keeps a conflict when both sides edit the same word", () => {
      const result = computeMerge3(
        { base, ours, theirs: lines("call(z, b)") },
        { resolveSimple: true },
      );
      expect(kinds(result)).toEqual(["conflict"]);
      expect(result.initialResult).toBe(base);
    });

    it("merges a word edit with an append on the same line", () => {
      const result = computeMerge3(
        { base: lines("ab cd"), ours: lines("xb cd"), theirs: lines("ab cd ef") },
        { resolveSimple: true },
      );
      expect(result.initialResult).toBe(lines("xb cd ef"));
    });

    it("keeps a conflict when edits touch adjacent tokens", () => {
      const adjacent = computeMerge3(
        { base: lines("foo(a)"), ours: lines("foo(x)"), theirs: lines("foo(a, b)") },
        { resolveSimple: true },
      );
      expect(kinds(adjacent)).toEqual(["conflict"]);
    });

    it("leaves real conflicts alongside resolved ones", () => {
      const result = computeMerge3(
        {
          base: lines("call(a, b)", "keep", "name = 1"),
          ours: lines("call(x, b)", "keep", "name = 2"),
          theirs: lines("call(a, y)", "keep", "name = 3"),
        },
        { resolveSimple: true },
      );
      expect(kinds(result)).toEqual(["auto-resolved", "conflict"]);
      expect(result.initialResult).toBe(lines("call(x, y)", "keep", "name = 1"));
      expect(result.stats).toMatchObject({ changes: 2, conflicts: 1, autoResolved: 1 });
    });
  });

  describe("line terminators", () => {
    it("preserves CRLF through a merge", () => {
      const result = computeMerge3({
        base: "a\r\nb\r\nc\r\n",
        ours: "a\r\nB\r\nc\r\n",
        theirs: "a\r\nb\r\nC\r\n",
      });
      expect(result.initialResult).toBe("a\r\nB\r\nC\r\n");
    });

    it("preserves a missing final newline", () => {
      const result = computeMerge3({
        base: "a\nb\nc",
        ours: "A\nb\nc",
        theirs: "a\nb\nC",
      });
      expect(result.initialResult).toBe("A\nb\nC");
    });

    it("sees a changed final newline as a change", () => {
      const result = computeMerge3({ base: "a\nb", ours: "a\nb\n", theirs: "a\nb" });
      expect(kinds(result)).toEqual(["ours"]);
      expect(result.initialResult).toBe("a\nb\n");
    });

    it("does not glue lines when a token merge drops a final newline", () => {
      const result = computeMerge3(
        {
          base: "x = 1\ny\n",
          ours: "x = 2\ny\n",
          theirs: "x = 1 \ny\n",
        },
        { resolveSimple: true },
      );
      expect(result.initialResult.endsWith("y\n")).toBe(true);
      expect(result.initialResult.split("\n")).toHaveLength(3);
    });
  });

  describe("edit-length guard", () => {
    it("turns the whole file into one conflict", () => {
      const base = lines(...Array.from({ length: 30 }, (_, index) => `base ${index}`));
      const ours = lines(...Array.from({ length: 30 }, (_, index) => `ours ${index}`));
      const theirs = lines(...Array.from({ length: 30 }, (_, index) => `theirs ${index}`));
      const result = computeMerge3({ base, ours, theirs }, { maxEditLength: 5 });
      expect(result.stats).toMatchObject({ conflicts: 1, editLimitExceeded: true });
      expect(result.chunks).toEqual([
        {
          kind: "conflict",
          base: { start: 0, end: 30 },
          ours: { start: 0, end: 30 },
          theirs: { start: 0, end: 30 },
          result: { start: 0, end: 30 },
        },
      ]);
      expect(result.initialResult).toBe(base);
    });
  });

  it("is symmetric when the sides are swapped", () => {
    const base = lines("a", "b", "c", "d", "e", "f");
    const ours = lines("a", "ours", "c", "d", "E", "f");
    const theirs = lines("a", "theirs", "c", "D", "e", "f");
    const forward = computeMerge3({ base, ours, theirs });
    const swapped = computeMerge3({ base, ours: theirs, theirs: ours });
    expect(forward.initialResult).toBe(swapped.initialResult);
    const swap = { ours: "theirs", theirs: "ours" } as const;
    expect(kinds(swapped)).toEqual(
      kinds(forward).map((kind) => (kind === "ours" || kind === "theirs" ? swap[kind] : kind)),
    );
    expect(swapped.chunks.map((chunk) => chunk.result)).toEqual(
      forward.chunks.map((chunk) => chunk.result),
    );
  });

  it("round-trips: with no conflicts the result equals applying both edits", () => {
    const base = lines("1", "2", "3", "4", "5", "6", "7", "8");
    const ours = lines("1", "2", "two-and-a-half", "3", "4", "5", "6", "7");
    const theirs = lines("0", "1", "2", "3", "4", "five", "6", "7", "8");
    const result = computeMerge3({ base, ours, theirs });
    expect(result.stats.conflicts).toBe(0);
    expect(result.initialResult).toBe(
      lines("0", "1", "2", "two-and-a-half", "3", "4", "five", "6", "7"),
    );
  });
});

describe("chunkWordRanges", () => {
  it("highlights the changed words on each side", () => {
    const input = {
      base: lines("call(a, b)"),
      ours: lines("call(xyz, b)"),
      theirs: lines("call(a, b)", "call(c)"),
    };
    const result = computeMerge3(input);
    expect(kinds(result)).toEqual(["ours", "theirs"]);
    const ranges = chunkWordRanges(
      {
        base: splitLines(input.base),
        ours: splitLines(input.ours),
        theirs: splitLines(input.theirs),
      },
      result.chunks[0]!,
    );
    expect(ranges.ours).toEqual([{ line: 0, start: 5, end: 8 }]);
    expect(ranges.theirs).toEqual([]);
    const inserted = chunkWordRanges(
      {
        base: splitLines(input.base),
        ours: splitLines(input.ours),
        theirs: splitLines(input.theirs),
      },
      result.chunks[1]!,
    );
    expect(inserted.theirs).toEqual([{ line: 1, start: 0, end: 7 }]);
  });
});

describe("helpers", () => {
  it("splits lines keeping terminators", () => {
    expect(splitLines("a\r\nb\nc")).toEqual(["a\r\n", "b\n", "c"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\n")).toEqual(["a\n"]);
  });

  it("detects and converts line endings", () => {
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
    expect(detectLineEnding("a\nb\r\n")).toBe("\n");
    expect(detectLineEnding("no breaks")).toBe("\n");
    expect(convertLineEndings("a\nb\r\nc", "\r\n")).toBe("a\r\nb\r\nc");
    expect(convertLineEndings("a\r\nb", "\n")).toBe("a\nb");
  });

  it("flags binary content", () => {
    expect(isBinaryContent(new TextEncoder().encode("plain text"))).toBe(false);
    expect(isBinaryContent(new Uint8Array([0x61, 0, 0x62]))).toBe(true);
    expect(isBinaryContent(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(true);
  });
});
