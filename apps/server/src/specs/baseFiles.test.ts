import { describe, expect, it } from "@effect/vitest";

import {
  appendApproval,
  approvedStatusJson,
  currentApproval,
  detectIndent,
  isoSeconds,
  readStatusTableStatus,
  setStatusTableStatus,
  validatorErrors,
} from "./baseFiles.ts";

const slug = "PROJ-123_short-kebab";
const table = `| Spec | Status | Owner |
| --- | --- | --- |
| [PROJ-100_other](./PROJ-100_other/spec.md) | in-progress | Sam |
| [${slug}](./${slug}/spec.md) | review  | Jane |
| ${slug}-copy | review | Jane |
`;

describe("status table", () => {
  it("reads the slug's status cell, plain or linked", () => {
    expect(readStatusTableStatus(table, slug)).toBe("review");
    expect(readStatusTableStatus(table, "PROJ-100_other")).toBe("in-progress");
    expect(readStatusTableStatus(table, `${slug}-copy`)).toBe("review");
    expect(readStatusTableStatus(table, "PROJ-999_missing")).toBeUndefined();
    expect(readStatusTableStatus("no table here\n", slug)).toBeUndefined();
  });

  it("replaces that cell only and keeps every other byte", () => {
    const next = setStatusTableStatus(table, slug, "approved")!;
    expect(next).toBe(
      table.replace(
        "| review  | Jane |\n| " + slug + "-copy",
        "| approved  | Jane |\n| " + slug + "-copy",
      ),
    );
    expect(setStatusTableStatus(table, "PROJ-999_missing", "approved")).toBeUndefined();
    const plain = "| Spec | Status |\r\n| a | draft |\r\n| b | draft |\r\n";
    expect(setStatusTableStatus(plain, "b", "review")).toBe(
      "| Spec | Status |\r\n| a | draft |\r\n| b | review |\r\n",
    );
    expect(setStatusTableStatus("| a |  | x |\n", "a", "draft")).toBe("| a | draft | x |\n");
  });
});

describe("approval log", () => {
  const entry = {
    confirmedBy: "Jane Doe <jane@example.com>",
    confirmedAt: "2026-10-01T12:00:00Z",
    source: "button" as const,
    artifacts: { "spec.md": "a".repeat(64) },
  };

  it("creates the log with two-space indent and appends without touching old entries", () => {
    expect(appendApproval(null, entry)).toBe(
      JSON.stringify({ approvals: [entry] }, null, 2) + "\n",
    );
    const old = { confirmedBy: "Sam", extra: [1, 2] };
    const existing = JSON.stringify({ approvals: [old], note: "keep" }, null, "\t") + "\n";
    expect(JSON.parse(appendApproval(existing, entry)!)).toEqual({
      approvals: [old, entry],
      note: "keep",
    });
    expect(appendApproval(existing, entry)!.startsWith('{\n\t"approvals"')).toBe(true);
    expect(appendApproval("{}", entry)).toBeUndefined();
    expect(appendApproval("not json", entry)).toBeUndefined();
  });

  it("detects the indent of the first indented line", () => {
    expect(detectIndent('{\n    "a": 1\n}')).toBe("    ");
    expect(detectIndent("{}")).toBe("  ");
  });

  it("recognises only the last entry covering this spec.md", () => {
    const hash = "b".repeat(64);
    const log = (...approvals: unknown[]) => JSON.stringify({ approvals });
    const covering = { confirmedBy: "Sam", confirmedAt: "t", artifacts: { "spec.md": hash } };
    const other = { confirmedBy: "Sam", confirmedAt: "t", artifacts: { "spec.md": "c" } };
    expect(currentApproval(log(other, covering), hash)).toEqual({
      confirmedBy: "Sam",
      confirmedAt: "t",
    });
    expect(currentApproval(log(covering, other), hash)).toBeUndefined();
    expect(currentApproval(log(), hash)).toBeUndefined();
    expect(
      currentApproval(log({ confirmedBy: "Sam", artifacts: { "spec.md": hash } }), hash),
    ).toBeUndefined();
    expect(currentApproval("nope", hash)).toBeUndefined();
  });

  it("strips milliseconds from timestamps", () => {
    expect(isoSeconds("2026-10-01T12:00:00.123Z")).toBe("2026-10-01T12:00:00Z");
  });
});

describe("status.json after approval", () => {
  it("stamps updated and clears awaiting without touching anything else", () => {
    const status = { phase: "requirements", requirements: { awaiting: "approval", n: 1 } };
    expect(approvedStatusJson(status, "T")).toEqual({
      phase: "requirements",
      requirements: { awaiting: "nothing", n: 1 },
      updated: "T",
    });
    expect(approvedStatusJson({ phase: "x", requirements: "text" }, "T")).toEqual({
      phase: "x",
      requirements: "text",
      updated: "T",
    });
  });
});

describe("validator output", () => {
  const out = (stdout: string, code: number | null = 1, stderr = "") => ({ stdout, stderr, code });

  it("collects errors from JSON and ignores warnings", () => {
    expect(
      validatorErrors(
        out(
          JSON.stringify({
            errors: ["Missing section", { message: "Bad AC" }],
            warnings: ["Long"],
            issues: [
              { severity: "warning", message: "style" },
              { severity: "error", message: "Open question" },
            ],
          }),
        ),
      ),
    ).toEqual(["Missing section", "Bad AC", "Open question"]);
    expect(validatorErrors(out('{"errors":[],"warnings":["w"]}', 0))).toEqual([]);
    expect(validatorErrors(out('{"valid":false}', 1))).toEqual([
      "The validator reported that the spec is invalid.",
    ]);
  });

  it("falls back to the output of a failing run without usable JSON", () => {
    expect(validatorErrors(out("", 1, "Traceback\nValueError: nope\n"))).toEqual([
      "Traceback ValueError: nope",
    ]);
    expect(validatorErrors(out("", 2))).toEqual(["The validator exited with code 2."]);
    expect(validatorErrors(out("all good", 0))).toEqual([]);
  });
});
