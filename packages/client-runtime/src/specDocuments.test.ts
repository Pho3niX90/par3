import { describe, expect, it } from "vite-plus/test";

import {
  lineAtOffset,
  locateSelection,
  markdownHeadings,
  sectionHeadingAt,
  sectionHeadings,
  selectionContext,
  splitDocumentSegments,
  splitFrontmatter,
} from "./specDocuments.ts";

const doc = [
  "---",
  "id: PROJ-123_short-title",
  "status: draft",
  "---",
  "# Title",
  "",
  "## Context",
  "Save and restore a setting.",
  "",
  "### Detail",
  "Sub-heading text.",
  "",
  "## Acceptance criteria",
  "- [ ] AC-1: The setting is saved.",
  "- [x] AC-2: The setting is restored.",
  "  - [ ] nested item",
  "",
  "```",
  "## not a heading",
  "- [ ] not a task",
  "```",
].join("\n");

describe("frontmatter", () => {
  it("is removed and its lines counted, so source lines can be restored", () => {
    const { body, lineOffset } = splitFrontmatter(doc);
    expect(lineOffset).toBe(4);
    expect(body.startsWith("# Title")).toBe(true);
    expect(lineAtOffset(body, body.indexOf("- [ ] AC-1")).line + lineOffset).toBe(14);
    expect(doc.split("\n")[13]).toBe("- [ ] AC-1: The setting is saved.");
  });

  it("leaves documents without it alone", () => {
    expect(splitFrontmatter("# Title\n")).toEqual({ body: "# Title\n", lineOffset: 0 });
    expect(splitFrontmatter("---\nno end\n")).toEqual({ body: "---\nno end\n", lineOffset: 0 });
  });

  it("handles CRLF", () => {
    const crlf = "---\r\nid: x\r\n---\r\n# T\r\n- [ ] one";
    const { body, lineOffset } = splitFrontmatter(crlf);
    expect(body).toBe("# T\r\n- [ ] one");
    expect(lineOffset).toBe(3);
  });
});

describe("lineAtOffset", () => {
  it("returns the 1-based line and its text for any offset on it", () => {
    const source = "one\ntwo\r\nthree\rfour";
    expect(lineAtOffset(source, 0)).toEqual({ line: 1, text: "one" });
    expect(lineAtOffset(source, 3)).toEqual({ line: 1, text: "one" });
    expect(lineAtOffset(source, 4)).toEqual({ line: 2, text: "two" });
    expect(lineAtOffset(source, 9)).toEqual({ line: 3, text: "three" });
    expect(lineAtOffset(source, source.length)).toEqual({ line: 4, text: "four" });
  });
});

describe("sections", () => {
  it("lists headings outside code with their levels", () => {
    expect(markdownHeadings(doc).map((heading) => [heading.level, heading.text])).toEqual([
      [1, "Title"],
      [2, "Context"],
      [3, "Detail"],
      [2, "Acceptance criteria"],
    ]);
    expect(sectionHeadings(doc)).toEqual(["Context", "Acceptance criteria"]);
  });

  it("names the nearest preceding second-level heading", () => {
    expect(sectionHeadingAt(doc, doc.indexOf("Save and restore"))).toBe("Context");
    expect(sectionHeadingAt(doc, doc.indexOf("Sub-heading text"))).toBe("Context");
    expect(sectionHeadingAt(doc, doc.indexOf("AC-2"))).toBe("Acceptance criteria");
    expect(sectionHeadingAt(doc, doc.indexOf("# Title") + 2)).toBe("Title");
    expect(sectionHeadingAt("plain text", 3)).toBeUndefined();
  });
});

describe("locating a selection", () => {
  const source = "## A\nthe cat sat\n\n## B\nthe cat\nsat";

  it("finds rendered text even where the source wrapped the line", () => {
    const found = locateSelection(source, "cat sat")!;
    expect(source.slice(found.start, found.end)).toBe("cat sat");
    const wrapped = locateSelection(source, "the cat sat", "## B ")!;
    expect(source.slice(wrapped.start, wrapped.end)).toBe("the cat\nsat");
  });

  it("uses the preceding text to choose between repeats", () => {
    const second = locateSelection(source, "the cat", "B")!;
    expect(sectionHeadingAt(source, second.start)).toBe("B");
    const first = locateSelection(source, "the cat")!;
    expect(sectionHeadingAt(source, first.start)).toBe("A");
  });

  it("gives up on text that is not in the source", () => {
    expect(locateSelection(source, "dog")).toBeNull();
    expect(locateSelection(source, "   ")).toBeNull();
    expect(locateSelection("a (b) c", "(b)")).toEqual({ start: 2, end: 5 });
  });

  it("takes context from the same line only", () => {
    const start = source.indexOf("cat sat");
    const context = selectionContext(source, start, start + 7, 30);
    expect(context).toEqual({ prefix: "the ", suffix: "" });
    const wide = selectionContext("0123456789abcdef", 6, 8, 3);
    expect(wide).toEqual({ prefix: "345", suffix: "89a" });
  });
});

describe("document segments", () => {
  it("separates checklist items from the markdown around them, keeping source lines", () => {
    const { body, lineOffset } = splitFrontmatter(doc);
    const segments = splitDocumentSegments(body);
    const tasks = segments.flatMap((segment) => (segment.kind === "task" ? [segment] : []));
    expect(
      tasks.map((task) => [task.line + lineOffset, task.label, task.checked, task.depth]),
    ).toEqual([
      [14, "AC-1: The setting is saved.", false, 0],
      [15, "AC-2: The setting is restored.", true, 0],
      [16, "nested item", false, 1],
    ]);
    expect(tasks[0]?.text).toBe("- [ ] AC-1: The setting is saved.");
    expect(segments.map((segment) => segment.kind)).toEqual([
      "markdown",
      "task",
      "task",
      "task",
      "markdown",
    ]);
    expect(segments.map((segment) => (segment.kind === "markdown" ? segment.line : null))).toEqual([
      1,
      null,
      null,
      null,
      13,
    ]);
    const last = segments.at(-1);
    expect(last?.kind === "markdown" && last.text).toContain("- [ ] not a task");
  });

  it("returns no segments for an empty document", () => {
    expect(splitDocumentSegments("")).toEqual([]);
    expect(splitDocumentSegments("\n\n")).toEqual([]);
  });
});
