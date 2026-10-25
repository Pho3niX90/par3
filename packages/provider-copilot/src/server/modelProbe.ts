/**
 * One-shot GitHub Copilot model discovery: opens a throwaway ACP session in an empty directory, reads
 * what it advertises and closes it, never answering a login prompt. Failure just means no models;
 * they then come from the first real session (`modelDiscovery.ts`) or custom models.
 */
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import { copilotModelsFromSessionSetup, type CopilotAdvertisedModel } from "./modelDiscovery.ts";

// A cold CLI start can be slow, and more so behind a proxy.
const MODEL_PROBE_TIMEOUT = Duration.seconds(45);
// Agents often list config options in an update shortly after the session opens.
const CONFIG_UPDATE_GRACE = Duration.seconds(3);

/** A bounded, secret-free summary of a failure, for the log. */
const describeProbeFailure = (cause: unknown) => {
  const record =
    typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>) : {};
  const message = record.errorMessage;
  return {
    errorTag: typeof record._tag === "string" ? record._tag : "Unknown",
    ...(typeof record.code === "number" || typeof record.code === "string"
      ? { code: String(record.code) }
      : {}),
    ...(typeof message === "string" ? { agentMessage: message.slice(0, 200) } : {}),
  };
};

export const probeCopilotModels = <E>(input: {
  /** Builds the probe's runtime in the probe's own scope, which closes when the probe ends. */
  readonly makeRuntime: Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    E,
    Scope.Scope
  >;
  readonly timeout?: Duration.Input;
  readonly configUpdateGrace?: Duration.Input;
}): Effect.Effect<ReadonlyArray<CopilotAdvertisedModel>> =>
  input.makeRuntime.pipe(
    Effect.flatMap((runtime) =>
      Effect.gen(function* () {
        const configUpdated = yield* Deferred.make<void>();
        yield* runtime.handleSessionUpdate((notification) =>
          notification.update.sessionUpdate === "config_option_update"
            ? Deferred.succeed(configUpdated, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );

        const started = yield* runtime.start();
        const fromStart = copilotModelsFromSessionSetup(started.sessionSetupResult);
        if (fromStart.length > 0) return fromStart;

        // Nothing at session start: wait briefly for a config update, then read what the
        // runtime has accumulated.
        yield* Deferred.await(configUpdated).pipe(
          Effect.timeoutOption(input.configUpdateGrace ?? CONFIG_UPDATE_GRACE),
        );
        return copilotModelsFromSessionSetup({ configOptions: yield* runtime.getConfigOptions });
      }),
    ),
    Effect.scoped,
    Effect.timeoutOption(input.timeout ?? MODEL_PROBE_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning("GitHub Copilot model discovery timed out.").pipe(
            Effect.as<ReadonlyArray<CopilotAdvertisedModel>>([]),
          ),
        onSome: (models) =>
          models.length > 0
            ? Effect.succeed(models)
            : Effect.logInfo(
                "GitHub Copilot did not advertise models to the discovery session.",
              ).pipe(Effect.as<ReadonlyArray<CopilotAdvertisedModel>>([])),
      }),
    ),
    // Only the error's tag, code, and the agent's own message are logged: launch failures can
    // echo the environment they were given.
    Effect.catch((cause) =>
      Effect.logWarning(
        "GitHub Copilot model discovery did not complete.",
        describeProbeFailure(cause),
      ).pipe(Effect.as<ReadonlyArray<CopilotAdvertisedModel>>([])),
    ),
  );
