/**
 * Commit messages, branch names, PR content and titles through GitHub Copilot's ACP server. Each request
 * is one throwaway session whose permission requests are always cancelled, so it cannot change anything;
 * requests to investigate the checkout are refused because no read-only mode can guarantee that.
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import type { CopilotSettings } from "../settings.ts";
import {
  applyCopilotAcpModelSelection,
  makeCopilotAcpRuntime,
  resolveCopilotAcpBaseModelId,
} from "./acpSupport.ts";

const COPILOT_TEXT_GENERATION_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

type CopilotRuntimeFactory = (
  cwd: string,
) => Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
>;

/** Sends one prompt to a fresh Copilot session and decodes its JSON reply. */
export const makeCopilotJsonRunner =
  (makeRuntime: CopilotRuntimeFactory): TextGenerationOperations.Runner =>
  (request) => {
    const { operation, cwd, prompt, modelSelection } = request;
    return Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeRuntime(cwd);

      // Nothing here needs a tool, so every permission request is declined.
      yield* runtime.handleRequestPermission(() =>
        Effect.succeed({ outcome: { outcome: "cancelled" } } as const),
      );
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
          return Effect.void;
        }
        const { text } = update.content;
        return Ref.update(outputRef, (current) => current + text);
      });

      const promptResult = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        yield* applyCopilotAcpModelSelection({
          runtime,
          sessionSetupResult: started.sessionSetupResult,
          requestedModelId: resolveCopilotAcpBaseModelId(modelSelection.model),
        });
        return yield* runtime.prompt({ prompt: [{ type: "text", text: prompt }] });
      }).pipe(
        Effect.timeoutOption(COPILOT_TEXT_GENERATION_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "GitHub Copilot request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "GitHub Copilot request was cancelled."
              : "GitHub Copilot returned empty output.",
        });
      }

      return yield* TextGenerationOperations.decodeJsonReply(request, "GitHub Copilot", trimmed);
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "GitHub Copilot text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );
  };

export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const makeRuntime: CopilotRuntimeFactory = (cwd) =>
    makeCopilotAcpRuntime({
      copilotSettings,
      environment,
      cwd,
      clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      // Never start a login flow for a background generation.
      authenticateOnAuthRequired: false,
    }).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
    );

  return TextGenerationOperations.fromRunner(
    "CopilotTextGeneration",
    TextGenerationOperations.withoutInvestigation(
      "GitHub Copilot",
      makeCopilotJsonRunner(makeRuntime),
    ),
  );
});
