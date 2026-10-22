import { describe, expect, it } from "@effect/vitest";

import { toggleChecklistLine, withoutCheckboxState } from "./markdownChecklist.ts";

const doc = [
  "# Title",
  "",
  "- [ ] AC-1: Saves the setting.",
  "- [x] AC-2: Restores it.",
  "  * [X] Nested   with  spaces  ",
  "1. [ ] Ordered item",
  "- Plain bullet [ ] not a task",
  "```",
  "- [ ] inside code",
  "```",
  "Done.",
].join("\n");

describe("toggling a checklist line", () => {
  it("changes only the box and every other byte survives", () => {
    const ticked = toggleChecklistLine(doc, 3, "- [ ] AC-1: Saves the setting.", true);
    expect(ticked).toEqual({
      ok: true,
      changed: true,
      content: doc.replace("- [ ] AC-1", "- [x] AC-1"),
    });
    const unticked = toggleChecklistLine(doc, 5, "  * [X] Nested   with  spaces  ", false);
    expect(unticked).toEqual({
      ok: true,
      changed: true,
      content: doc.replace("* [X] Nested", "* [ ] Nested"),
    });
    const ordered = toggleChecklistLine(doc, 6, "1. [ ] Ordered item", true);
    expect(ordered.ok && ordered.content).toBe(doc.replace("1. [ ]", "1. [x]"));
  });

  it("keeps CRLF and a missing final newline", () => {
    const crlf = "- [ ] one\r\n- [ ] two\r\n- [ ] three";
    const result = toggleChecklistLine(crlf, 3, "- [ ] three", true);
    expect(result.ok && result.content).toBe("- [ ] one\r\n- [ ] two\r\n- [x] three");
    const second = toggleChecklistLine(crlf, 2, "- [ ] two", true);
    expect(second.ok && second.content).toBe("- [ ] one\r\n- [x] two\r\n- [ ] three");
  });

  it("is a no-op when the box already has the wanted state", () => {
    expect(toggleChecklistLine(doc, 4, "- [x] AC-2: Restores it.", true)).toEqual({
      ok: true,
      changed: false,
      content: doc,
    });
    // The caller saw it unticked; someone ticked it meanwhile. Ticking again is harmless.
    expect(toggleChecklistLine(doc, 4, "- [ ] AC-2: Restores it.", true)).toMatchObject({
      ok: true,
      changed: false,
    });
  });

  it("refuses a line that changed, moved or is not a task", () => {
    expect(toggleChecklistLine(doc, 3, "- [ ] AC-1: Saves it.", true)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(toggleChecklistLine(doc, 4, "- [ ] AC-1: Saves the setting.", true)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(toggleChecklistLine(doc, 99, "- [ ] x", true)).toEqual({ ok: false, reason: "missing" });
    expect(toggleChecklistLine(doc, 0, "# Title", true)).toEqual({ ok: false, reason: "missing" });
    expect(toggleChecklistLine(doc, 1, "# Title", true)).toEqual({ ok: false, reason: "not-task" });
    expect(toggleChecklistLine(doc, 7, "- Plain bullet [ ] not a task", true)).toEqual({
      ok: false,
      reason: "not-task",
    });
    expect(toggleChecklistLine(doc, 9, "- [ ] inside code", true)).toEqual({
      ok: false,
      reason: "not-task",
    });
  });
});

describe("checkbox state in the hash", () => {
  it("unticks every box after a list marker and nothing else", () => {
    expect(withoutCheckboxState(doc)).toBe(
      doc.replace("- [x] AC-2", "- [ ] AC-2").replace("* [X] Nested", "* [ ] Nested"),
    );
    expect(withoutCheckboxState("[x] not a list item\n- [x] item")).toBe(
      "[x] not a list item\n- [ ] item",
    );
    expect(withoutCheckboxState("- [x] a\n- [ ] a")).toBe(withoutCheckboxState("- [ ] a\n- [x] a"));
    expect(withoutCheckboxState("- [x] a")).not.toBe(withoutCheckboxState("- [x] b"));
  });
});
