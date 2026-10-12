import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import { probeCopilotModels } from "./modelProbe.ts";

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
type StartResult = AcpSessionRuntime.AcpSessionRuntimeStartResult;
type UpdateHandler = Parameters<Runtime["handleSessionUpdate"]>[0];

const started = (sessionSetupResult: unknown) =>
  Effect.succeed({ sessionSetupResult } as unknown as StartResult);

const modelOption = (ids: ReadonlyArray<string>) => [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: ids[0],
    options: ids.map((value) => ({ value, name: value })),
  },
];

/**
 * A runtime fake. `start` runs after the probe registered its update handler, so a test can
 * deliver a notification from inside it, the way an agent's update follows a session opening.
 */
const makeRuntime = (options: {
  readonly start: (notify: UpdateHandler) => Effect.Effect<StartResult, EffectAcpErrors.AcpError>;
  readonly configOptions?: ReadonlyArray<unknown>;
}) => {
  let handler: UpdateHandler | undefined;
  return {
    handleSessionUpdate: (next: UpdateHandler) => {
      handler = next;
      return Effect.void;
    },
    start: () => options.start((notification) => handler!(notification)),
    getConfigOptions: Effect.succeed(options.configOptions ?? []),
  } as unknown as Runtime;
};

const configUpdate = { sessionId: "s", update: { sessionUpdate: "config_option_update" } } as never;

describe("probeCopilotModels", () => {
  it.effect("returns the models the throwaway session advertises", () =>
    Effect.gen(function* () {
      const models = yield* probeCopilotModels({
        makeRuntime: Effect.succeed(
          makeRuntime({
            start: () =>
              started({
                models: {
                  currentModelId: "gpt-5.4",
                  availableModels: [
                    { modelId: "gpt-5.4", name: "GPT-5.4" },
                    { modelId: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
                  ],
                },
              }),
          }),
        ),
      });
      expect(models.map((model) => model.slug)).toEqual(["gpt-5.4", "claude-haiku-4.5"]);
    }),
  );

  it.effect("picks up models the agent lists in a config update after the session opens", () =>
    Effect.gen(function* () {
      const models = yield* probeCopilotModels({
        makeRuntime: Effect.succeed(
          makeRuntime({
            start: (notify) => notify(configUpdate).pipe(Effect.andThen(started({}))),
            configOptions: modelOption(["gpt-5.4", "claude-haiku-4.5"]),
          }),
        ),
      });
      expect(models.map((model) => model.slug)).toEqual(["gpt-5.4", "claude-haiku-4.5"]);
    }),
  );

  it.effect("finds nothing once the grace for a config update has passed", () =>
    Effect.gen(function* () {
      const fiber = yield* probeCopilotModels({
        makeRuntime: Effect.succeed(makeRuntime({ start: () => started({}) })),
        configUpdateGrace: "2 seconds",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(fiber)).toEqual([]);
    }),
  );

  it.effect("finds nothing, without failing, when the session fails to start", () =>
    Effect.gen(function* () {
      const models = yield* probeCopilotModels({
        makeRuntime: Effect.succeed(
          makeRuntime({
            start: () =>
              Effect.fail(
                new EffectAcpErrors.AcpRequestError({
                  code: -32000,
                  errorMessage: "Not signed in",
                }),
              ),
          }),
        ),
      });
      expect(models).toEqual([]);
    }),
  );

  it.effect("finds nothing when the runtime cannot be built", () =>
    Effect.gen(function* () {
      const models = yield* probeCopilotModels({ makeRuntime: Effect.fail("spawn failed") });
      expect(models).toEqual([]);
    }),
  );

  it.effect("gives up on a session that never answers", () =>
    Effect.gen(function* () {
      const fiber = yield* probeCopilotModels({
        makeRuntime: Effect.succeed(makeRuntime({ start: () => Effect.never })),
        timeout: "5 seconds",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toEqual([]);
    }),
  );
});
