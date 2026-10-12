import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import { probeCopilotModels } from "./modelProbe.ts";

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
type StartResult = AcpSessionRuntime.AcpSessionRuntimeStartResult;

const runtimeWith = (start: Runtime["start"]) => ({ start }) as unknown as Runtime;

const started = (sessionSetupResult: unknown) =>
  Effect.succeed({ sessionSetupResult } as unknown as StartResult);

describe("probeCopilotModels", () => {
  it.effect("returns the models the throwaway session advertises", () =>
    Effect.gen(function* () {
      const models = yield* probeCopilotModels({
        makeRuntime: Effect.succeed(
          runtimeWith(() =>
            started({
              models: {
                currentModelId: "gpt-5.4",
                availableModels: [
                  { modelId: "gpt-5.4", name: "GPT-5.4" },
                  { modelId: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
                ],
              },
            }),
          ),
        ),
      });
      expect(models.map((model) => model.slug)).toEqual(["gpt-5.4", "claude-haiku-4.5"]);
    }),
  );

  it.effect("finds nothing, without failing, when the session fails to start", () =>
    Effect.gen(function* () {
      const models = yield* probeCopilotModels({
        makeRuntime: Effect.succeed(
          runtimeWith(() =>
            Effect.fail(
              new EffectAcpErrors.AcpRequestError({ code: -32000, errorMessage: "Not signed in" }),
            ),
          ),
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
        makeRuntime: Effect.succeed(runtimeWith(() => Effect.never)),
        timeout: "5 seconds",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toEqual([]);
    }),
  );
});
