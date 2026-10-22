import { describe, expect, it } from "@effect/vitest";

import { detectIndent, serializeJson } from "./baseFiles.ts";
import {
  appendEntry,
  appendEvent,
  buildEntry,
  documentPath,
  emptyLedger,
  entryStatus,
  ledgerPath,
  openEntries,
  parseLedger,
  remarkProblem,
  remarksPrompt,
  viewEntries,
} from "./remarkLedger.ts";

const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-01T10:05:00.123Z";

const event = (type: string, eventId: string, extra: object = {}) => ({
  eventId,
  type,
  timestamp: T0,
  ...extra,
});
const entry = (id: string, events: object[], extra: object = {}) => ({
  id,
  kind: "comment",
  operation: "comment",
  createdAt: T0,
  section: { heading: "Open questions" },
  comment: "Answer: (a)",
  events,
  ...extra,
});

describe("remark ledger paths", () => {
  it("keeps the ledger beside its document, named after the stem", () => {
    expect(documentPath("PROJ-123_short-title", "tech-analysis.md")).toBe(
      "specs/PROJ-123_short-title/tech-analysis.md",
    );
    expect(ledgerPath("PROJ-123_short-title", "spec.md")).toBe(
      "specs/PROJ-123_short-title/spec-comments.json",
    );
    expect(ledgerPath("PROJ-123_short-title", "prd.md")).toBe(
      "specs/PROJ-123_short-title/prd-comments.json",
    );
    expect(ledgerPath("PROJ-123_short-title", "tech-analysis.md")).toBe(
      "specs/PROJ-123_short-title/tech-analysis-comments.json",
    );
  });
});

describe("status", () => {
  it("is the type of the last event, and created means pending", () => {
    expect(entryStatus(entry("a", [event("created", "1")]))).toBe("pending");
    expect(entryStatus(entry("a", [event("created", "1"), event("submitted", "2")]))).toBe(
      "submitted",
    );
    expect(
      entryStatus(
        entry("a", [event("created", "1"), event("submitted", "2"), event("addressed", "3")]),
      ),
    ).toBe("addressed");
    expect(entryStatus(entry("a", [event("created", "1"), event("unmatched", "2")]))).toBe(
      "unmatched",
    );
    expect(entryStatus(entry("a", [event("created", "1"), event("deleted", "2")]))).toBe("deleted");
    expect(entryStatus(entry("a", []))).toBe("pending");
  });

  it("lists open entries in ledger order and skips closed and malformed ones", () => {
    const ledger = {
      ...emptyLedger("specs/x/spec.md", T0),
      entries: [
        entry("a", [event("created", "1")]),
        entry("b", [event("created", "1"), event("addressed", "2")]),
        { note: "not an entry" },
        entry("c", [event("created", "1"), event("submitted", "2")]),
        entry("d", [event("created", "1"), event("deleted", "2")]),
      ],
    };
    expect(openEntries(ledger)).toEqual([
      { id: "a", status: "pending" },
      { id: "c", status: "submitted" },
    ]);
    expect(viewEntries(ledger).map((item) => [item.id, item.status])).toEqual([
      ["a", "pending"],
      ["b", "addressed"],
      ["c", "submitted"],
      ["d", "deleted"],
    ]);
  });

  it("shows the response of the last addressed or unmatched event", () => {
    const [view] = viewEntries({
      entries: [
        entry("a", [
          event("created", "1"),
          event("submitted", "2"),
          event("addressed", "3", { response: "Boundary confirmed." }),
        ]),
      ],
    });
    expect(view?.response).toBe("Boundary confirmed.");
    expect(view?.events.map((item) => item.type)).toEqual(["created", "submitted", "addressed"]);
  });
});

describe("rewriting a ledger", () => {
  const original = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schemaVersion: "1.0.0",
    documentPath: "specs/x/spec.md",
    createdAt: T0,
    updatedAt: T0,
    reviewer: { name: "Jane Doe", tags: ["a"] },
    entries: [
      entry("old", [event("created", "1")], {
        futureField: { keep: true },
        selection: { text: "quoted", prefix: "before ", extra: 1 },
      }),
      { unknownEntryShape: true },
    ],
  };
  const text = serializeJson(original, "    ");

  it("keeps unknown fields, unknown entries and the file's indent", () => {
    const ledger = parseLedger(text)!;
    const created = buildEntry(
      {
        kind: "comment",
        operation: "comment",
        section: { heading: "Scope" },
        comment: "Why?",
      },
      { id: "new", eventId: "e1" },
      T1,
    );
    const next = appendEntry(ledger, created, T1);
    const rewritten = serializeJson(next, detectIndent(text));
    const parsed = JSON.parse(rewritten);
    expect(parsed.reviewer).toEqual(original.reviewer);
    expect(parsed.updatedAt).toBe(T1);
    expect(parsed.createdAt).toBe(T0);
    expect(parsed.entries[0]).toEqual(original.entries[0]);
    expect(parsed.entries[1]).toEqual({ unknownEntryShape: true });
    expect(parsed.entries[2].id).toBe("new");
    expect(rewritten.startsWith('{\n    "$schema"')).toBe(true);
    expect(rewritten.endsWith("}\n")).toBe(true);
  });

  it("appends events to one entry and leaves the rest of it untouched", () => {
    const result = appendEvent(
      parseLedger(text)!,
      "old",
      { eventId: "e2", type: "submitted" },
      ["pending"],
      T1,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(serializeJson(result.ledger, "    "));
    expect(parsed.entries[0].futureField).toEqual({ keep: true });
    expect(parsed.entries[0].selection).toEqual({ text: "quoted", prefix: "before ", extra: 1 });
    expect(parsed.entries[0].events).toEqual([
      event("created", "1"),
      { eventId: "e2", type: "submitted", timestamp: T1 },
    ]);
    expect(parsed.entries[1]).toEqual({ unknownEntryShape: true });
    expect(result.entry.status).toBe("submitted");
  });

  it("refuses an event from a status it does not apply to, and for an unknown id", () => {
    const ledger = {
      entries: [
        entry("sent", [event("created", "1"), event("submitted", "2")]),
        entry("done", [event("created", "1"), event("addressed", "2", { response: "ok" })]),
      ],
    };
    const deleted = { eventId: "e", type: "deleted" as const };
    expect(appendEvent(ledger, "sent", deleted, ["pending"], T1)).toEqual({
      ok: false,
      reason: "closed",
      status: "submitted",
    });
    expect(
      appendEvent(
        ledger,
        "done",
        { eventId: "e", type: "addressed", response: "again" },
        ["pending", "submitted"],
        T1,
      ),
    ).toEqual({ ok: false, reason: "closed", status: "addressed" });
    expect(appendEvent(ledger, "nope", deleted, ["pending"], T1)).toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});

describe("a new remark", () => {
  it("is written the way the review panel writes it, milliseconds included", () => {
    const created = buildEntry(
      {
        kind: "text-edit",
        operation: "reword",
        section: { heading: "Scope", text: "Section body" },
        selection: { text: "old words", prefix: "the ", suffix: " here" },
        comment: "Clearer",
        value: "new words",
      },
      { id: "id-1", eventId: "ev-1" },
      T1,
    );
    expect(created).toEqual({
      id: "id-1",
      kind: "text-edit",
      operation: "reword",
      createdAt: T1,
      section: { heading: "Scope", text: "Section body" },
      selection: { text: "old words", prefix: "the ", suffix: " here" },
      comment: "Clearer",
      value: "new words",
      events: [{ eventId: "ev-1", type: "created", timestamp: T1 }],
    });
    expect(Object.keys(created)).toEqual([
      "id",
      "kind",
      "operation",
      "createdAt",
      "section",
      "selection",
      "comment",
      "value",
      "events",
    ]);
    const minimal = buildEntry(
      { kind: "comment", operation: "comment", section: { heading: "Scope" }, comment: "Why?" },
      { id: "id-2", eventId: "ev-2" },
      T1,
    );
    expect(Object.keys(minimal)).not.toContain("selection");
    expect(Object.keys(minimal)).not.toContain("value");
  });

  it("must make sense for its kind and operation", () => {
    const base = { section: { heading: "Scope" } };
    expect(remarkProblem({ ...base, kind: "comment", operation: "comment" })).toBeDefined();
    expect(
      remarkProblem({ ...base, kind: "comment", operation: "comment", comment: "Why?" }),
    ).toBeUndefined();
    expect(remarkProblem({ ...base, kind: "text-edit", operation: "delete" })).toBeDefined();
    expect(
      remarkProblem({
        ...base,
        kind: "text-edit",
        operation: "delete",
        selection: { text: "gone" },
      }),
    ).toBeUndefined();
    expect(
      remarkProblem({
        ...base,
        kind: "text-edit",
        operation: "reword",
        selection: { text: "x" },
      }),
    ).toBeDefined();
    expect(remarkProblem({ ...base, kind: "text-edit", operation: "add", value: "new" })).toBe(
      undefined,
    );
    expect(
      remarkProblem({
        section: { heading: " " },
        kind: "comment",
        operation: "comment",
        comment: "x",
      }),
    ).toBeDefined();
  });
});

describe("remarks prompt", () => {
  it("names the document, its ledger and exactly the listed ids", () => {
    const prompt = remarksPrompt({
      documentPath: "specs/PROJ-123_short-title/spec.md",
      commentsPath: "specs/PROJ-123_short-title/spec-comments.json",
      ids: ["id-1", "id-2"],
    });
    expect(prompt.startsWith("This request was sent from the BASE document review panel.")).toBe(
      true,
    );
    expect(prompt).toContain("`process-document-comments` skill");
    expect(prompt).toContain("specs/PROJ-123_short-title/spec.md");
    expect(prompt).toContain("specs/PROJ-123_short-title/spec-comments.json");
    expect(prompt).toContain("open request UUIDs:\nid-1\nid-2\n");
    expect(prompt).toMatch(/addressed/);
    expect(prompt).toMatch(/unmatched/);
    expect(prompt).toMatch(/Never delete ledger history/);
    expect(prompt).toContain("spec_resolve_remark");
  });
});
