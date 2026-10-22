import { describe, expect, it } from "@effect/vitest";
import type { SpecDocument, SpecRole } from "@t3tools/contracts";

import { specInstructions, specIntakeInstructions } from "./specInstructions.ts";

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
      expect(text).toContain("spec_validate");
    }
    expect(specInstructions(document("par3"), "requirements")).not.toContain("spec_validate");
  });

  it("tells a new-spec turn to choose a KEY-123_short-kebab folder in BASE and ask when there is no key", () => {
    const text = specIntakeInstructions({
      layout: "base",
      workspacePath: "/checkout",
      year: "2026",
    });
    expect(text).toContain("KEY-123_short-kebab");
    expect(text).toContain("ask the user for it");
    expect(text).toContain("2026-short-kebab");
    expect(text).toContain("specs/_template.md");
    expect(text).toContain("spec_create");
    expect(text).toContain("You cannot approve");
    expect(text).toContain("spec_validate");
    expect(text).not.toMatch(/constitution/i);
  });

  it("tells a new-spec turn in a Par3 checkout to use lowercase words and the default sections", () => {
    const text = specIntakeInstructions({
      layout: "par3",
      workspacePath: "/checkout",
      year: "2026",
    });
    expect(text).toContain("dark-mode-toggle");
    expect(text).toContain("specs/constitution.md");
    expect(text).not.toContain("spec_validate");
    expect(text).toContain("Acceptance criteria");
    expect(text).not.toContain("KEY-123");
    expect(text).not.toContain("_template.md");
  });
});
