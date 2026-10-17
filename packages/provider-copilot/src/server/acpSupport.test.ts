import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import { applyCopilotAcpModelSelection } from "./acpSupport.ts";

type SessionSetupResult = AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"];

const makeRuntime = (options?: { readonly rejectSessionModel?: boolean }) => {
  const calls: Array<{ readonly method: "setModel" | "setSessionModel"; readonly model: string }> =
    [];
  return {
    calls,
    runtime: {
      setModel: (model: string) => {
        calls.push({ method: "setModel", model });
        return Effect.void;
      },
      setSessionModel: (model: string) => {
        calls.push({ method: "setSessionModel", model });
        return options?.rejectSessionModel === true
          ? Effect.fail(
              new EffectAcpErrors.AcpRequestError({
                code: -32601,
                errorMessage: "Method not found",
              }),
            )
          : Effect.succeed({});
      },
    },
  };
};

const withModelConfigOption: SessionSetupResult = {
  configOptions: [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "gpt-5.4",
      options: [
        { value: "gpt-5.4", name: "GPT-5.4" },
        { value: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
      ],
    },
  ],
};

const withModelState: SessionSetupResult = {
  models: {
    currentModelId: "gpt-5.4",
    availableModels: [
      { modelId: "gpt-5.4", name: "GPT-5.4" },
      { modelId: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    ],
  },
};

const advertisesNothing: SessionSetupResult = {};

describe("applyCopilotAcpModelSelection", () => {
  it.effect("keeps the CLI default when the product default slug is selected", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      const applied = yield* applyCopilotAcpModelSelection({
        runtime,
        sessionSetupResult: withModelState,
        requestedModelId: "default",
      });
      expect(applied).toBe("gpt-5.4");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("does nothing when the session already runs the requested model", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      const applied = yield* applyCopilotAcpModelSelection({
        runtime,
        sessionSetupResult: withModelConfigOption,
        requestedModelId: "gpt-5.4",
      });
      expect(applied).toBe("gpt-5.4");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("selects through the model config option when the session advertises one", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      const applied = yield* applyCopilotAcpModelSelection({
        runtime,
        sessionSetupResult: withModelConfigOption,
        requestedModelId: "claude-haiku-4.5",
      });
      expect(applied).toBe("claude-haiku-4.5");
      expect(calls).toEqual([{ method: "setModel", model: "claude-haiku-4.5" }]);
    }),
  );

  it.effect("selects through session model state when there is no config option", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      const applied = yield* applyCopilotAcpModelSelection({
        runtime,
        sessionSetupResult: withModelState,
        requestedModelId: "claude-haiku-4.5",
      });
      expect(applied).toBe("claude-haiku-4.5");
      expect(calls).toEqual([{ method: "setSessionModel", model: "claude-haiku-4.5" }]);
    }),
  );

  it.effect("surfaces a rejection when the session advertised model state", () =>
    Effect.gen(function* () {
      const { runtime } = makeRuntime({ rejectSessionModel: true });
      const error = yield* applyCopilotAcpModelSelection({
        runtime,
        sessionSetupResult: withModelState,
        requestedModelId: "claude-haiku-4.5",
      }).pipe(Effect.flip);
      expect(error._tag).toBe("AcpRequestError");
    }),
  );

  it.effect("tries session/set_model when nothing is advertised and applies it if accepted", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime();
      const applied = yield* applyCopilotAcpModelSelection({
        runtime,
        sessionSetupResult: advertisesNothing,
        requestedModelId: "gpt-5.4",
      });
      expect(applied).toBe("gpt-5.4");
      expect(calls).toEqual([{ method: "setSessionModel", model: "gpt-5.4" }]);
    }),
  );

  it.effect("keeps the session alive when an unadvertised model request is rejected", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime({ rejectSessionModel: true });
      const applied = yield* applyCopilotAcpModelSelection({
        runtime,
        sessionSetupResult: advertisesNothing,
        requestedModelId: "gpt-5.4",
      });
      expect(applied).toBeUndefined();
      expect(calls).toEqual([{ method: "setSessionModel", model: "gpt-5.4" }]);
    }),
  );
});
