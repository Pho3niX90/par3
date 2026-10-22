import { describe, expect, it } from "@effect/vitest";
import type { SpecDocument, SpecRole } from "@t3tools/contracts";

import { specInstructions } from "./specInstructions.ts";

const document = (layout?: "par3" | "base") =>
  ({
    slug: "PROJ-123_short-kebab",
    workspacePath: "/checkout",
    status: "draft",
    revision: 1,
    specHash: "spec-hash",
    taskHash: "task-hash",
    ...(layout ? { layout } : {}),
  }) as SpecDocument;

const roles: SpecRole[] = ["requirements", "implementation", "test", "researcher", "verifier"];

describe("specInstructions", () => {
  it("points Par3 specs at the constitution and the server-owned files", () => {
    for (const role of roles) {
      expect(specInstructions(document(), role)).toBe(specInstructions(document("par3"), role));
    }
    const text = specInstructions(document("par3"), "requirements");
    expect(text).toContain("specs/constitution.md");
    expect(text).toContain("Never write status.json, tasks.json, or approval.json directly.");
  });

  it("tells BASE agents to follow the project's template without Par3's files or constitution", () => {
    for (const role of roles) {
      const text = specInstructions(document("base"), role);
      expect(text).not.toMatch(/constitution|tasks\.json|approval\.json/i);
      expect(text).toContain("specs/_template.md");
      expect(text).toContain("prd.md, tech-analysis.md and status.json");
      expect(text).toContain("spec_write_artifact");
    }
  });
});
