import { describe, expect, it } from "vite-plus/test";

import {
  defaultSpecContent,
  resolveSpecActions,
  seedSpecContent,
  specModeCreateDisabledReason,
  specPageLimit,
  specRoleRefusal,
} from "./specs.logic";

const base = { canMutate: true, findingCount: 0, approvalValid: true, hasError: false };
const ids = (input: Parameters<typeof resolveSpecActions>[0]) =>
  resolveSpecActions(input).map((entry) => entry.id);

describe("resolveSpecActions", () => {
  it("offers the review actions for each status", () => {
    expect(ids({ ...base, status: "draft" })).toEqual([
      "edit",
      "request-review",
      "start-requirements",
    ]);
    expect(ids({ ...base, status: "review" })).toEqual([
      "approve",
      "request-changes",
      "reject",
      "start-requirements",
    ]);
    expect(ids({ ...base, status: "approved" })).toEqual(["start-implementation"]);
    for (const status of ["rejected", "done", "implemented", "blocked"] as const) {
      expect(ids({ ...base, status })).toEqual(["reopen"]);
    }
  });

  it("blocks approval while readiness findings remain", () => {
    const approve = resolveSpecActions({ ...base, status: "review", findingCount: 2 })[0]!;
    expect(approve.disabledReason).toContain("2 readiness findings");
  });

  it("blocks implementation on a stale approval and offers reopen", () => {
    const actions = resolveSpecActions({ ...base, status: "approved", approvalValid: false });
    expect(actions.map((entry) => entry.id)).toEqual(["start-implementation", "reopen"]);
    expect(actions[0]!.disabledReason).not.toBeNull();
    expect(actions[1]!.disabledReason).toBeNull();
  });

  it("disables every action without permission", () => {
    const actions = resolveSpecActions({ ...base, status: "review", canMutate: false });
    expect(actions.every((entry) => entry.disabledReason !== null)).toBe(true);
  });

  it("offers reopen when the spec has an error", () => {
    expect(ids({ ...base, status: "in-progress", hasError: true })).toEqual(["reopen"]);
  });
});

describe("specRoleRefusal", () => {
  it("allows implementation everywhere and requirements only on Codex and Claude", () => {
    expect(specRoleRefusal("cursor", "implementation")).toBeNull();
    expect(specRoleRefusal("claudeAgent", "requirements")).toBeNull();
    expect(specRoleRefusal("cursor", "requirements")).toContain("Cursor");
    expect(specRoleRefusal(null, "requirements")).not.toBeNull();
  });
});

describe("specModeCreateDisabledReason", () => {
  it("explains why creation is unavailable", () => {
    expect(specModeCreateDisabledReason({ specModeEnabled: false, canMutate: true })).toContain(
      "Spec mode",
    );
    expect(
      specModeCreateDisabledReason({ specModeEnabled: true, canMutate: false }),
    ).not.toBeNull();
    expect(specModeCreateDisabledReason({ specModeEnabled: true, canMutate: true })).toBeNull();
  });
});

describe("spec content and paging", () => {
  it("seeds every required heading and an AC bullet", () => {
    const content = defaultSpecContent("Dark mode");
    for (const heading of [
      "Summary",
      "Scope",
      "Users and scenarios",
      "Acceptance criteria",
      "Constraints",
      "Open questions",
      "Design notes",
    ]) {
      expect(content).toContain(`## ${heading}`);
    }
    expect(content).toContain("- AC-1:");
  });

  it("seeds a BASE checkout's template verbatim and Par3's sections otherwise", () => {
    const template = "## Context\n\n## Acceptance criteria\n";
    expect(seedSpecContent("Dark mode", template)).toBe(template);
    expect(seedSpecContent("Dark mode", undefined)).toBe(defaultSpecContent("Dark mode"));
  });

  it("caps the page limit at the server maximum", () => {
    expect(specPageLimit(1)).toBe(25);
    expect(specPageLimit(100)).toBe(200);
  });
});
