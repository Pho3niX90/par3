import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import type * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import { makeCopilotJsonRunner } from "./textGeneration.ts";

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
type UpdateHandler = Parameters<Runtime["handleSessionUpdate"]>[0];
type PermissionHandler = Parameters<Runtime["handleRequestPermission"]>[0];

const OutputSchema = Schema.Struct({ subject: Schema.String, body: Schema.String });

const request = (model: string): TextGenerationOperations.Request<typeof OutputSchema> => ({
  operation: "generateCommitMessage",
  cwd: "/repo",
  prompt: "Write a commit message.",
  outputSchema: OutputSchema,
  modelSelection: { instanceId: ProviderInstanceId.make("copilot"), model } as ModelSelection,
});

interface FakeOptions {
  /** Text chunks the agent streams while answering the prompt. */
  readonly chunks?: ReadonlyArray<string>;
  readonly failStart?: boolean;
  readonly advertisedModels?: ReadonlyArray<string>;
}

const makeFake = (options: FakeOptions = {}) => {
  const calls: Array<string> = [];
  let onUpdate: UpdateHandler | undefined;
  let onPermission: PermissionHandler | undefined;
  const runtime = {
    handleRequestPermission: (handler: PermissionHandler) => {
      onPermission = handler;
      return Effect.void;
    },
    handleSessionUpdate: (handler: UpdateHandler) => {
      onUpdate = handler;
      return Effect.void;
    },
    start: () => {
      calls.push("start");
      return options.failStart === true
        ? Effect.fail(
            new EffectAcpErrors.AcpRequestError({ code: -32000, errorMessage: "Not signed in" }),
          )
        : Effect.succeed({
            sessionSetupResult: {
              models: {
                currentModelId: "gpt-5.4",
                availableModels: (options.advertisedModels ?? ["gpt-5.4"]).map((modelId) => ({
                  modelId,
                  name: modelId,
                })),
              },
            },
          });
    },
    setModel: (model: string) => {
      calls.push(`setModel:${model}`);
      return Effect.void;
    },
    setSessionModel: (model: string) => {
      calls.push(`setSessionModel:${model}`);
      return Effect.succeed({});
    },
    prompt: () =>
      Effect.gen(function* () {
        calls.push("prompt");
        for (const text of options.chunks ?? []) {
          yield* onUpdate!({
            sessionId: "s",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          } as never);
        }
        return { stopReason: "end_turn" };
      }),
  } as unknown as Runtime;
  return {
    calls,
    runner: makeCopilotJsonRunner(() => Effect.succeed(runtime)),
    permissionHandler: () => onPermission,
  };
};

describe("makeCopilotJsonRunner", () => {
  it.effect("decodes the JSON the model streams, even when it is wrapped in prose", () =>
    Effect.gen(function* () {
      const { runner } = makeFake({
        chunks: ['Here you go: {"subject":"Fix', ' crash","body":"Handles null."} Done.'],
      });
      const result = yield* runner(request("default"));
      expect(result).toEqual({ subject: "Fix crash", body: "Handles null." });
    }),
  );

  it.effect("keeps the CLI's own model for the product default", () =>
    Effect.gen(function* () {
      const { runner, calls } = makeFake({ chunks: ['{"subject":"a","body":"b"}'] });
      yield* runner(request("default"));
      expect(calls).toEqual(["start", "prompt"]);
    }),
  );

  it.effect("selects the requested model before prompting", () =>
    Effect.gen(function* () {
      const { runner, calls } = makeFake({
        chunks: ['{"subject":"a","body":"b"}'],
        advertisedModels: ["gpt-5.4", "claude-haiku-4.5"],
      });
      yield* runner(request("claude-haiku-4.5"));
      expect(calls).toEqual(["start", "setSessionModel:claude-haiku-4.5", "prompt"]);
    }),
  );

  it.effect("declines every permission request so the model cannot use a tool", () =>
    Effect.gen(function* () {
      const { runner, permissionHandler } = makeFake({ chunks: ['{"subject":"a","body":"b"}'] });
      yield* runner(request("default"));
      const handler = permissionHandler();
      expect(handler).toBeDefined();
      const response = yield* handler!({} as never, {} as never);
      expect(response).toEqual({ outcome: { outcome: "cancelled" } });
    }),
  );

  it.effect("fails with a text generation error when the model returns nothing", () =>
    Effect.gen(function* () {
      const { runner } = makeFake({ chunks: ["   "] });
      const error = yield* runner(request("default")).pipe(Effect.flip);
      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toBe("GitHub Copilot returned empty output.");
    }),
  );

  it.effect("fails with a text generation error when the reply is not valid JSON", () =>
    Effect.gen(function* () {
      const { runner } = makeFake({ chunks: ["I cannot help with that."] });
      const error = yield* runner(request("default")).pipe(Effect.flip);
      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toBe("GitHub Copilot returned invalid structured output.");
    }),
  );

  it.effect("wraps a session that cannot start, for example when not signed in", () =>
    Effect.gen(function* () {
      const { runner } = makeFake({ failStart: true });
      const error = yield* runner(request("default")).pipe(Effect.flip);
      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toBe("GitHub Copilot text generation failed.");
    }),
  );
});
