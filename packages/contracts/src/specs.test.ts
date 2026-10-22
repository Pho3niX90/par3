import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  SpecMutationInput,
  SpecQueryInput,
  SpecSlug,
  SpecStatus,
  specRoleSupported,
  specSlugAllowed,
} from "./specs.ts";
import { ServerSettings } from "./settings.ts";

const decodeQuery = Schema.decodeUnknownSync(SpecQueryInput);
const decodeStatus = Schema.decodeUnknownSync(SpecStatus);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

describe("Spec contracts", () => {
  it("validates lower kebab-case slugs up to 80 characters", () => {
    const decode = Schema.decodeUnknownSync(SpecSlug);
    expect(decode("api-contracts-v2")).toBe("api-contracts-v2");
    expect(() => decode("Upper-case")).toThrow();
    expect(() => decode("two--hyphens")).toThrow();
    expect(() => decode("a".repeat(81))).toThrow();
  });

  it("also accepts BASE folder names and keeps them out of the par3 layout", () => {
    const decode = Schema.decodeUnknownSync(SpecSlug);
    for (const slug of ["PROJ-123_short-kebab", "AB1-7_x", "2026-short-kebab"]) {
      expect(decode(slug)).toBe(slug);
    }
    for (const slug of [
      "proj-123_short-kebab",
      "PROJ_123_short-kebab",
      "P-123_short-kebab",
      "PROJ-123_Short",
      "PROJ-123_two--hyphens",
      "PROJ-123",
      "PROJ-123_",
      `PROJ-1_${"a".repeat(80)}`,
    ]) {
      expect(() => decode(slug)).toThrow();
    }

    expect(specSlugAllowed("PROJ-123_short-kebab", "base")).toBe(true);
    expect(specSlugAllowed("PROJ-123_short-kebab", "par3")).toBe(false);
    expect(specSlugAllowed("2026-short-kebab", "par3")).toBe(true);
    expect(specSlugAllowed("Upper-case", "base")).toBe(false);
  });

  it("constrains query pagination and exposes all lifecycle states", () => {
    expect(decodeQuery({ projectId: "project-1", offset: 0, limit: 200 }).limit).toBe(200);
    expect(() => decodeQuery({ projectId: "project-1", limit: 201 })).toThrow();
    expect(decodeStatus("blocked")).toBe("blocked");
  });

  it("enables Spec mode by default", () => {
    expect(decodeSettings({}).specModeEnabled).toBe(true);
  });

  it("accepts typed mutation commands and keeps evidence confirmation server-owned", () => {
    const decode = Schema.decodeUnknownSync(SpecMutationInput);
    const mutation = decode({
      action: "evidence",
      projectId: "project-1",
      slug: "api-contracts",
      commandId: "command-1",
      expectedRevision: 0,
      evidence: [
        {
          id: "verify-api",
          acs: ["AC-1"],
          kind: "automated",
          description: "Focused verification passed",
          checkpoint: "checkpoint-1",
          requirementsHash: "req-hash",
          taskHash: "task-hash",
          passed: true,
        },
      ],
    });
    expect(mutation.action).toBe("evidence");
  });

  it("limits roles to the supported provider drivers", () => {
    expect(specRoleSupported("codex", "requirements")).toBe(true);
    expect(specRoleSupported("claudeAgent", "verifier")).toBe(true);
    expect(specRoleSupported("cursor", "requirements")).toBe(false);
    expect(specRoleSupported("antigravity", "test")).toBe(true);
    expect(specRoleSupported("unknown", "implementation")).toBe(false);
  });
});
