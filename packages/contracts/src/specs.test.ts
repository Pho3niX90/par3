import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope } from "./auth.ts";
import { CLIENT_GUARDED_RPC_SCOPES } from "./clientRpcPermissions.ts";
import { OrchestrationV2ThreadLaunchInput } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";
import {
  SpecIntakeInput,
  SpecQueryResult,
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

  it("takes the intake actions only from a client that may operate threads", () => {
    const decode = Schema.decodeUnknownSync(SpecIntakeInput);
    const base = { projectId: "project-1", threadId: "thread-1" };
    expect(decode({ ...base, action: "mark" }).action).toBe("mark");
    expect(decode({ ...base, action: "cancel" }).action).toBe("cancel");
    expect(() => decode({ ...base, action: "create" })).toThrow();
    expect(() => decode({ projectId: "project-1", action: "mark" })).toThrow();
    expect(CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.specsIntake]).toBe(AuthOrchestrationOperateScope);
  });

  it("reports a pending intake only when the thread is waiting for its spec", () => {
    const decode = Schema.decodeUnknownSync(SpecQueryResult);
    expect(decode({ specs: [] }).intake).toBeUndefined();
    expect(decode({ specs: [], intake: { createdAt: "2026-10-20T00:00:00.000Z" } }).intake).toEqual(
      {
        createdAt: "2026-10-20T00:00:00.000Z",
      },
    );
  });

  it("lets a thread launch ask for spec intake but nothing else", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput);
    const launch = {
      commandId: "command-1",
      projectId: "project-1",
      title: "Add dark mode",
      modelSelection: { instanceId: "codex", model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    };
    expect(decode(launch).specIntake).toBeUndefined();
    expect(decode({ ...launch, specIntake: true }).specIntake).toBe(true);
    expect(() => decode({ ...launch, specIntake: false })).toThrow();
  });
});
