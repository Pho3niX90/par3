import { describe, expect, it } from "@effect/vitest";

import {
  countFrontmatterKey,
  readFrontmatterLifecycleStatus,
  readFrontmatterStatus,
  setFrontmatterStatus,
  setFrontmatterUpdated,
  withoutFrontmatter,
  withoutVolatileFrontmatter,
} from "./specFrontmatter.ts";

const STATUS_COMMENT =
  "# draft | review | approved | in-progress | blocked | implemented | done | rejected";
const commented = `---
id: PROJ-123_short-kebab
status: draft            ${STATUS_COMMENT}
updated: 2026-10-20T00:00:00Z
epic:
  id: PROJ-100
  status: done
tracking:
  - status: blocked
---
# Example

## Summary
Body mentions status: review in prose.
`;

describe("frontmatter status", () => {
  it("reads the top-level value and ignores the trailing comment", () => {
    expect(readFrontmatterStatus(commented)).toBe("draft");
    expect(readFrontmatterLifecycleStatus(commented)).toBe("draft");
    expect(readFrontmatterStatus('---\nstatus: "review"\n---\n')).toBe("review");
    expect(readFrontmatterStatus("---\nstatus: wip\n---\n")).toBe("wip");
    expect(readFrontmatterLifecycleStatus("---\nstatus: wip\n---\n")).toBeUndefined();
    expect(readFrontmatterStatus("---\nstatus:   # comment only\n---\n")).toBeUndefined();
    expect(readFrontmatterStatus("---\nepic:\n  status: done\n---\n")).toBeUndefined();
    expect(readFrontmatterStatus("# Example\nstatus: review\n")).toBeUndefined();
    expect(readFrontmatterStatus("---\nstatus: review\n")).toBeUndefined();
  });

  it("replaces only the value token and keeps padding and the comment byte for byte", () => {
    const next = setFrontmatterStatus(commented, "in-progress");
    expect(next).toBe(commented.replace("status: draft  ", "status: in-progress  "));
    expect(next).toContain(`status: in-progress            ${STATUS_COMMENT}\n`);
    expect(next).toContain("epic:\n  id: PROJ-100\n  status: done\n");
    expect(next).toContain("  - status: blocked\n");
    expect(next).toContain("Body mentions status: review in prose.");
    expect(readFrontmatterStatus(next)).toBe("in-progress");
    expect(setFrontmatterStatus(commented, "draft")).toBe(commented);
  });

  it("keeps quotes, fills an empty value, and appends a missing key before the closing fence", () => {
    expect(setFrontmatterStatus('---\nstatus: "draft" # note\n---\nBody\n', "review")).toBe(
      '---\nstatus: "review" # note\n---\nBody\n',
    );
    expect(setFrontmatterStatus("---\nstatus:   # note\n---\nBody\n", "review")).toBe(
      "---\nstatus: review # note\n---\nBody\n",
    );
    expect(setFrontmatterStatus("---\nid: PROJ-123_x\n---\nBody\n", "review")).toBe(
      "---\nid: PROJ-123_x\nstatus: review\n---\nBody\n",
    );
    expect(setFrontmatterStatus("---\nepic:\n  status: done\n---\nBody\n", "review")).toBe(
      "---\nepic:\n  status: done\nstatus: review\n---\nBody\n",
    );
    expect(setFrontmatterStatus("---\n---\nBody\n", "review")).toBe(
      "---\nstatus: review\n---\nBody\n",
    );
  });

  it("does not add frontmatter and keeps CRLF line endings", () => {
    const plain = "# Example\n\nstatus: draft\n";
    expect(setFrontmatterStatus(plain, "review")).toBe(plain);
    expect(setFrontmatterStatus("---\nid: x\n---\n# Example\n", "review")).toBe(
      "---\nid: x\nstatus: review\n---\n# Example\n",
    );
    expect(setFrontmatterStatus("---\r\nid: x\r\nstatus: draft # c\r\n---\r\nBody", "done")).toBe(
      "---\r\nid: x\r\nstatus: done # c\r\n---\r\nBody",
    );
    expect(setFrontmatterStatus("---\r\nid: x\r\n---\r\nBody", "done")).toBe(
      "---\r\nid: x\r\nstatus: done\r\n---\r\nBody",
    );
  });

  it("hashes the same whatever the status and updated lines say", () => {
    const stripped = withoutVolatileFrontmatter(commented);
    expect(stripped).not.toContain("status: draft");
    expect(stripped).not.toContain("updated:");
    expect(stripped).toContain("  status: done\n");
    expect(stripped).toContain("id: PROJ-123_short-kebab\n");
    expect(withoutVolatileFrontmatter(setFrontmatterStatus(commented, "done"))).toBe(stripped);
    expect(withoutVolatileFrontmatter(commented.replace("status: draft", "status: review"))).toBe(
      stripped,
    );
    expect(
      withoutVolatileFrontmatter(
        commented.replace("updated: 2026-10-20T00:00:00Z", "updated: 2026-10-22T16:00:00+02:00"),
      ),
    ).toBe(stripped);
    expect(
      withoutVolatileFrontmatter(
        commented
          .replace("status: draft", "status: done")
          .replace("2026-10-20T00:00:00Z", "2026-10-22T16:00:00+02:00"),
      ),
    ).toBe(stripped);
    expect(
      withoutVolatileFrontmatter(commented.replace("id: PROJ", "title: x\nid: PROJ")),
    ).not.toBe(stripped);
    expect(
      withoutVolatileFrontmatter(commented.replace("  id: PROJ-100", "  id: PROJ-101")),
    ).not.toBe(stripped);
    expect(withoutVolatileFrontmatter("# Example\nstatus: draft\nupdated: now\n")).toBe(
      "# Example\nstatus: draft\nupdated: now\n",
    );
  });

  it("returns the body after the frontmatter", () => {
    expect(withoutFrontmatter(commented).startsWith("# Example\n")).toBe(true);
    expect(withoutFrontmatter("# Example\n")).toBe("# Example\n");
  });
});

describe("frontmatter updated", () => {
  it("replaces only the value of a single top-level updated key", () => {
    expect(setFrontmatterUpdated(commented, "2026-10-01T12:00:00Z")).toBe(
      commented.replace("2026-10-20T00:00:00Z", "2026-10-01T12:00:00Z"),
    );
    const quoted = '---\nupdated: "2026-10-20"   # touched by tooling\nstatus: review\n---\n';
    expect(setFrontmatterUpdated(quoted, "2026-10-01T12:00:00Z")).toBe(
      '---\nupdated: "2026-10-01T12:00:00Z"   # touched by tooling\nstatus: review\n---\n',
    );
    const crlf = "---\r\nupdated: 2026-10-20\r\nstatus: review\r\n---\r\nBody\r\n";
    expect(setFrontmatterUpdated(crlf, "x")).toBe(crlf.replace("2026-10-20", "x"));
  });

  it("leaves content alone when there is not exactly one updated key", () => {
    const none = "---\nstatus: review\n---\nBody\n";
    expect(setFrontmatterUpdated(none, "x")).toBe(none);
    const nested = "---\nepic:\n  updated: 2026-10-20\n---\nBody\n";
    expect(setFrontmatterUpdated(nested, "x")).toBe(nested);
    const twice = "---\nupdated: a\nupdated: b\n---\nBody\n";
    expect(setFrontmatterUpdated(twice, "x")).toBe(twice);
    expect(setFrontmatterUpdated("updated: a\nBody\n", "x")).toBe("updated: a\nBody\n");
  });

  it("counts only top-level keys inside the frontmatter", () => {
    expect(countFrontmatterKey(commented, "status")).toBe(1);
    expect(countFrontmatterKey("---\nstatus: a\nstatus: b\n---\n", "status")).toBe(2);
    expect(countFrontmatterKey("status: a\n", "status")).toBe(0);
    expect(countFrontmatterKey(commented, "updated")).toBe(1);
  });
});
