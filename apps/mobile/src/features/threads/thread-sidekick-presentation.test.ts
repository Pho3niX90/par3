import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ModelSelection, type ServerProvider } from "@t3tools/contracts";

import { resolveSidekickRow, sidekickPickerGroups } from "./thread-sidekick-presentation";

function provider(
  instanceId: string,
  driver: string,
  displayName: string,
  slugs: ReadonlyArray<string>,
  extra: Partial<Record<string, unknown>> = {},
): ServerProvider {
  return {
    instanceId,
    driver,
    displayName,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: slugs.map((slug) => ({ slug, name: slug.toUpperCase(), isCustom: false })),
    ...extra,
  } as unknown as ServerProvider;
}

const codex = provider("codex", "codex", "Codex", ["gpt-6", "gpt-6-luna"]);
const copilot = provider("copilot", "copilot", "Copilot", ["default", "gpt-6-mini"]);
const pi = provider("pi", "pi", "Pi", ["pi-1"]);
const providers = [codex, copilot, pi];
const lead: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };
const allEnabled = () => true;

describe("sidekickPickerGroups", () => {
  it("offers other models grouped by provider, without the lead or Copilot Default", () => {
    const groups = sidekickPickerGroups({ providers, lead, isInstanceEnabled: allEnabled });
    expect(
      groups.map((group) => ({
        label: group.label,
        models: group.models.map((model) => model.selection.model),
        billingHint: group.billingHint !== null,
      })),
    ).toEqual([
      { label: "Codex", models: ["gpt-6-luna"], billingHint: false },
      { label: "Copilot", models: ["gpt-6-mini"], billingHint: true },
      { label: "Pi", models: ["pi-1"], billingHint: false },
    ]);
  });

  it("skips providers turned off for the project", () => {
    const groups = sidekickPickerGroups({
      providers,
      lead,
      isInstanceEnabled: (instanceId) => instanceId === "codex",
    });
    expect(groups.map((group) => group.instanceId)).toEqual(["codex"]);
  });
});

describe("resolveSidekickRow", () => {
  const input = { providers, lead, isInstanceEnabled: allEnabled, supported: true };

  it("is hidden when the environment lacks sidekick support", () => {
    expect(resolveSidekickRow({ ...input, supported: false, sidekick: null })).toBeNull();
  });

  it("shows None, or the pairing label", () => {
    expect(resolveSidekickRow({ ...input, sidekick: null })).toEqual({
      value: "Off",
      problem: null,
    });
    expect(
      resolveSidekickRow({
        ...input,
        sidekick: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
      }),
    ).toEqual({ value: "GPT-6-LUNA · Codex", problem: null });
  });

  it("is hidden for a lead that cannot lead, unless a stale selection needs clearing", () => {
    const piLead = { instanceId: ProviderInstanceId.make("pi"), model: "pi-1" };
    expect(resolveSidekickRow({ ...input, lead: piLead, sidekick: null })).toBeNull();
    expect(resolveSidekickRow({ ...input, lead: piLead, sidekick: lead })?.problem).toContain(
      "cannot lead",
    );
  });

  it("keeps an unusable selection visible with its reason", () => {
    const signedOut = provider("copilot", "copilot", "Copilot", ["gpt-6-mini"], {
      auth: { status: "unauthenticated" },
    });
    expect(
      resolveSidekickRow({
        ...input,
        providers: [codex, signedOut],
        sidekick: { instanceId: ProviderInstanceId.make("copilot"), model: "gpt-6-mini" },
      }),
    ).toEqual({ value: "GPT-6-MINI · Copilot", problem: "Copilot is signed out." });
    expect(
      resolveSidekickRow({
        ...input,
        isInstanceEnabled: (instanceId) => instanceId !== "copilot",
        sidekick: { instanceId: ProviderInstanceId.make("copilot"), model: "gpt-6-mini" },
      })?.problem,
    ).toBe("Copilot is turned off for this project.");
  });
});
