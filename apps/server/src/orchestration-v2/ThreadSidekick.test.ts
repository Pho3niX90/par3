import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadSidekick from "./ThreadSidekick.ts";

const projectId = ProjectId.make("project:sidekick");
const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const lead = { instanceId: claude, model: "opus" };
const sidekick = { instanceId: codex, model: "luna" };

const provider = (
  instanceId: ProviderInstanceId,
  driver: string,
  model: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  displayName: driver === "codex" ? "Codex" : "Claude",
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-20T00:00:00.000Z",
  models: [{ slug: model, name: model.toUpperCase(), isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const layer = (providers: ReadonlyArray<ServerProvider>) =>
  ThreadSidekick.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([claude, codex]),
        }),
        ServerSettings.layerTest({}),
      ),
    ),
  );

it.effect("a usable sidekick reaches the lead's turn with its label", () =>
  Effect.gen(function* () {
    const sidekicks = yield* ThreadSidekick.ThreadSidekick;
    yield* sidekicks.validate({ projectId, lead, sidekick });
    const state = yield* sidekicks.leadStateForTurn({
      projectId,
      modelSelection: lead,
      sidekickModelSelection: sidekick,
    });
    assert.deepEqual(state, { label: "LUNA · Codex", billingModel: "per_token" });
  }).pipe(
    Effect.provide(
      layer([provider(claude, "claudeAgent", "opus"), provider(codex, "codex", "luna")]),
    ),
  ),
);

it.effect("a signed-out sidekick is refused and stays inactive with its reason", () =>
  Effect.gen(function* () {
    const sidekicks = yield* ThreadSidekick.ThreadSidekick;
    const error = yield* sidekicks.validate({ projectId, lead, sidekick }).pipe(Effect.flip);
    assert.include(error.message, "signed out");
    const thread = { projectId, modelSelection: lead, sidekickModelSelection: sidekick };
    assert.include((yield* sidekicks.status(thread))?.inactiveReason, "signed out");
    assert.isNull(yield* sidekicks.leadStateForTurn(thread));
  }).pipe(
    Effect.provide(
      layer([
        provider(claude, "claudeAgent", "opus"),
        provider(codex, "codex", "luna", { auth: { status: "unauthenticated" } }),
      ]),
    ),
  ),
);

it.effect("a lead switched to the sidekick's model makes the pairing inactive", () =>
  Effect.gen(function* () {
    const sidekicks = yield* ThreadSidekick.ThreadSidekick;
    const state = yield* sidekicks.leadStateForTurn({
      projectId,
      modelSelection: sidekick,
      sidekickModelSelection: sidekick,
    });
    assert.isNull(state);
    const error = yield* sidekicks
      .validate({ projectId, lead: sidekick, sidekick })
      .pipe(Effect.flip);
    assert.include(error.message, "same model");
  }).pipe(
    Effect.provide(
      layer([provider(claude, "claudeAgent", "opus"), provider(codex, "codex", "luna")]),
    ),
  ),
);

it.effect("Copilot Default is refused because its real model is unknown", () =>
  Effect.gen(function* () {
    const sidekicks = yield* ThreadSidekick.ThreadSidekick;
    const copilot = ProviderInstanceId.make("copilot");
    const error = yield* sidekicks
      .validate({ projectId, lead, sidekick: { instanceId: copilot, model: "default" } })
      .pipe(Effect.flip);
    assert.include(error.message, "Copilot Default");
  }).pipe(
    Effect.provide(
      layer([
        provider(claude, "claudeAgent", "opus"),
        provider(ProviderInstanceId.make("copilot"), "copilot", "default"),
      ]),
    ),
  ),
);
