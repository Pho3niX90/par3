import type { SpecRemark, SpecRemarkStatus, SpecRemarksView } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canDeleteRemark,
  countOpenRemarks,
  countRemarks,
  isOpenRemark,
  planRemarksSend,
  remarkLedgerFor,
  reviewDocuments,
  remarkExcerpt,
  visibleRemarks,
} from "./specRemarks.ts";

const remark = (id: string, status: SpecRemarkStatus): SpecRemark => ({
  id,
  kind: "comment",
  operation: "comment",
  createdAt: "2026-10-01T10:00:00.000Z",
  section: { heading: "Scope" },
  status,
  events: [],
});
const entries = [
  remark("a", "pending"),
  remark("b", "submitted"),
  remark("c", "addressed"),
  remark("d", "unmatched"),
  remark("e", "deleted"),
  remark("f", "pending"),
];

describe("remark filtering", () => {
  it("treats pending and submitted as open", () => {
    expect(entries.map((entry) => isOpenRemark(entry.status))).toEqual([
      true,
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(countOpenRemarks(entries)).toBe(3);
  });

  it("shows open remarks by default and every remark on request, in ledger order", () => {
    expect(visibleRemarks(entries, "open").map((entry) => entry.id)).toEqual(["a", "b", "f"]);
    expect(visibleRemarks(entries, "all").map((entry) => entry.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(visibleRemarks([], "open")).toEqual([]);
  });

  it("counts every status", () => {
    expect(countRemarks(entries)).toEqual({
      pending: 2,
      submitted: 1,
      addressed: 1,
      unmatched: 1,
      deleted: 1,
      open: 3,
    });
  });

  it("lets only a never-sent remark be withdrawn", () => {
    expect(entries.filter(canDeleteRemark).map((entry) => entry.id)).toEqual(["a", "f"]);
  });
});

describe("planning a send", () => {
  it("cannot send without open remarks", () => {
    expect(planRemarksSend([])).toEqual({ canSend: false, open: 0, resend: 0, warning: null });
    expect(planRemarksSend([remark("c", "addressed"), remark("e", "deleted")]).canSend).toBe(false);
  });

  it("sends pending remarks without a warning", () => {
    expect(planRemarksSend([remark("a", "pending"), remark("c", "addressed")])).toEqual({
      canSend: true,
      open: 1,
      resend: 0,
      warning: null,
    });
  });

  it("warns, with the count, when remarks that were already sent would go again", () => {
    const one = planRemarksSend([remark("a", "pending"), remark("b", "submitted")]);
    expect(one).toMatchObject({ canSend: true, open: 2, resend: 1 });
    expect(one.warning).toMatch(/^1 remark was already sent/);
    const two = planRemarksSend([remark("b", "submitted"), remark("g", "submitted")]);
    expect(two.warning).toMatch(/^2 remarks were already sent/);
  });
});

describe("excerpts", () => {
  it("flattens whitespace and cuts long text at a word", () => {
    expect(remarkExcerpt("a  b\n c")).toBe("a b c");
    const long = "word ".repeat(60);
    const cut = remarkExcerpt(long, 40);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(41);
    expect(cut).not.toMatch(/\swor…$/);
  });
});

describe("review documents", () => {
  const view: SpecRemarksView = {
    documents: [
      { document: "spec.md", exists: true, entries: [] },
      { document: "prd.md", exists: true, text: "# PRD", entries: [] },
      { document: "tech-analysis.md", exists: false, entries: [] },
    ],
  };

  it("offers the spec, and the other documents only once they exist", () => {
    expect(reviewDocuments(view)).toEqual(["spec.md", "prd.md"]);
    expect(reviewDocuments(null)).toEqual(["spec.md"]);
    expect(reviewDocuments(undefined)).toEqual(["spec.md"]);
  });

  it("finds a document's ledger", () => {
    expect(remarkLedgerFor(view, "prd.md")?.text).toBe("# PRD");
    expect(remarkLedgerFor(null, "prd.md")).toBeUndefined();
  });
});
