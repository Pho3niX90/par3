/**
 * Spawn and communication primitives for GitHub Copilot's ACP server.
 *
 * @module provider-copilot/server/acpSupport
 */
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpErrors from "effect-acp/errors";
import {
  type ProviderApprovalOption,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { CopilotSettings } from "../settings.ts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const COPILOT_DRIVER_KIND = ProviderDriverKind.make("copilot");

type CopilotAcpRuntimeSettings = Pick<CopilotSettings, "binaryPath">;

export interface CopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "spawn"
> {
  readonly copilotSettings: CopilotAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export const COPILOT_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

function copilotAcpSpawnArgs(): ReadonlyArray<string> {
  return ["--acp"];
}

function buildCopilotAcpSpawnInput(
  copilotSettings: CopilotAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: copilotSettings?.binaryPath || "copilot",
    args: [...copilotAcpSpawnArgs()],
    cwd,
    ...(environment !== undefined ? { env: environment } : {}),
  };
}

export const COPILOT_DEFAULT_MODEL_SLUG = "default";

export function resolveCopilotAcpBaseModelId(raw: string | undefined): string {
  const normalized = normalizeModelSlug(raw ?? COPILOT_DEFAULT_MODEL_SLUG, COPILOT_DRIVER_KIND);
  return normalized || COPILOT_DEFAULT_MODEL_SLUG;
}

/**
 * Applies the selected model to a new session and returns the model it runs on, following what the
 * session advertises (`model` config option, then model state). Otherwise `session/set_model` is
 * still tried; a rejection keeps the current model and is logged rather than failing the session.
 */
export function applyCopilotAcpModelSelection(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setModel" | "setSessionModel"
  >;
  readonly sessionSetupResult: AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"];
  readonly requestedModelId: string;
}): Effect.Effect<string | undefined, EffectAcpErrors.AcpError> {
  const { runtime, sessionSetupResult, requestedModelId } = input;
  const modelOption = sessionSetupResult.configOptions?.find(
    (option) => option.category === "model",
  );
  const currentModelId =
    sessionSetupResult.models?.currentModelId.trim() ||
    (typeof modelOption?.currentValue === "string" ? modelOption.currentValue : undefined);

  // The product slug is never sent over the wire; it keeps the CLI's own default model.
  if (requestedModelId === COPILOT_DEFAULT_MODEL_SLUG || requestedModelId === currentModelId) {
    return Effect.succeed(currentModelId);
  }
  const useSessionModelState =
    sessionSetupResult.models != null &&
    modelOption?.type === "select" &&
    modelOption.options.every((entry) => !("value" in entry) && entry.options.length === 0);
  if (modelOption !== undefined && !useSessionModelState) {
    return runtime.setModel(requestedModelId).pipe(Effect.as(requestedModelId));
  }
  const setSessionModel = runtime
    .setSessionModel(requestedModelId)
    .pipe(Effect.as<string | undefined>(requestedModelId));
  if (sessionSetupResult.models != null) {
    return setSessionModel;
  }
  return setSessionModel.pipe(
    Effect.catch((cause) =>
      Effect.logWarning(
        "GitHub Copilot did not accept the selected model; keeping its current one.",
        {
          model: requestedModelId,
          errorTag: cause._tag,
        },
      ).pipe(Effect.as(currentModelId)),
    ),
  );
}

export function copilotApprovalOptions(
  _request?: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  return [
    { decision: "cancel", label: "Cancel" },
    { decision: "decline", label: "Decline" },
    { decision: "accept", label: "Approve" },
  ];
}

export const makeCopilotAcpRuntime = Effect.fn("makeCopilotAcpRuntime")(function* (
  input: CopilotAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  const acpContext = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      spawn: buildCopilotAcpSpawnInput(
        input.copilotSettings,
        input.cwd ?? process.cwd(),
        input.environment,
      ),
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(acpContext),
  );
});
