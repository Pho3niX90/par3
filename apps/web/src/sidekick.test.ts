import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "./providerInstances";
import { resolveSidekickPairing, sidekickOptionGroups } from "./sidekick";

function provider(
  instanceId: string,
  driver: string,
  models: ReadonlyArray<string>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName: instanceId[0]!.toUpperCase() + instanceId.slice(1),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-20T00:00:00.000Z",
    models: models.map((slug) => ({
      slug,
      name: slug.toUpperCase(),
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const codex = provider("codex", "codex", ["gpt-lead", "gpt-mini"]);
const copilot = provider("copilot", "copilot", ["default", "claude-small"]);
const signedOut = provider("claude", "claudeAgent", ["haiku"], {
  auth: { status: "unauthenticated" },
});
const pi = provider("pi", "pi", ["pi-model"]);
const entries = deriveProviderInstanceEntries([codex, copilot, signedOut, pi]);
const lead = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-lead" };

describe("sidekickOptionGroups", () => {
  it("offers healthy models other than the lead, skipping Copilot Default", () => {
    const groups = sidekickOptionGroups({ entries, lead });
    expect(
      groups.map((group) => [
        group.entry.instanceId,
        group.perRequest,
        group.options.map((option) => option.model),
      ]),
    ).toEqual([
      ["codex", false, ["gpt-mini"]],
      ["copilot", true, ["claude-small"]],
      ["pi", false, ["pi-model"]],
    ]);
  });

  it("follows the user's visible models and drops unavailable ones", () => {
    const groups = sidekickOptionGroups({
      entries,
      lead,
      modelOptionsByInstance: new Map([
        [
          ProviderInstanceId.make("codex"),
          [
            { slug: "gpt-lead", name: "Lead" },
            { slug: "gpt-mini", name: "Mini", isUnavailable: true },
          ],
        ],
      ]),
    });
    expect(groups.map((group) => group.entry.instanceId)).not.toContain("codex");
  });

  it("leaves out instances disabled for the project", () => {
    // applyProviderInstanceSettings turns a per-project disable into `enabled: false`.
    const projectEntries = entries.map((entry) =>
      entry.instanceId === "copilot" ? { ...entry, enabled: false } : entry,
    );
    const groups = sidekickOptionGroups({ entries: projectEntries, lead });
    expect(groups.map((group) => group.entry.instanceId)).toEqual(["codex", "pi"]);
  });
});

describe("resolveSidekickPairing", () => {
  it("labels an active pairing and flags per-request billing", () => {
    expect(
      resolveSidekickPairing({
        selection: { instanceId: ProviderInstanceId.make("copilot"), model: "claude-small" },
        lead,
        entries,
      }),
    ).toMatchObject({ label: "CLAUDE-SMALL · Copilot", problem: null, perRequest: true });
  });

  it("keeps a stale sidekick visible with the reason it is inactive", () => {
    const pairing = resolveSidekickPairing({
      selection: { instanceId: ProviderInstanceId.make("claude"), model: "haiku" },
      lead,
      entries,
    });
    expect(pairing?.label).toBe("HAIKU · Claude");
    expect(pairing?.problem).toBe("Claude is signed out.");
  });

  it("marks the pairing inactive when the lead cannot lead", () => {
    const pairing = resolveSidekickPairing({
      selection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-mini" },
      lead: { instanceId: ProviderInstanceId.make("pi"), model: "pi-model" },
      entries,
    });
    expect(pairing?.problem).toBe("Pi cannot lead with a sidekick.");
  });

  it("returns null when sidekick mode is off", () => {
    expect(resolveSidekickPairing({ selection: null, lead, entries })).toBeNull();
  });
});
