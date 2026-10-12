/**
 * One-shot model discovery for GitHub Copilot.
 *
 * Copilot has no documented model listing outside a session, so this opens a throwaway ACP session
 * in an empty directory, reads what it advertises, and closes it. It never answers a login prompt,
 * and any failure just means no models were discovered; models then come from the first real
 * session (see `modelDiscovery.ts`) or from custom models.
 *
 * @module provider-copilot/server/modelProbe
 */
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import { copilotModelsFromSessionSetup, type CopilotAdvertisedModel } from "./modelDiscovery.ts";

const MODEL_PROBE_TIMEOUT = Duration.seconds(20);

export const probeCopilotModels = <E>(input: {
  /** Builds the probe's runtime in the probe's own scope, which closes when the probe ends. */
  readonly makeRuntime: Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    E,
    Scope.Scope
  >;
  readonly timeout?: Duration.Input;
}): Effect.Effect<ReadonlyArray<CopilotAdvertisedModel>> =>
  input.makeRuntime.pipe(
    Effect.flatMap((runtime) => runtime.start()),
    Effect.map((started) => copilotModelsFromSessionSetup(started.sessionSetupResult)),
    Effect.scoped,
    Effect.timeoutOption(input.timeout ?? MODEL_PROBE_TIMEOUT),
    Effect.map(Option.getOrElse((): ReadonlyArray<CopilotAdvertisedModel> => [])),
    // The cause is not logged: launch failures can echo the environment they were given.
    Effect.catch(() =>
      Effect.logDebug("GitHub Copilot model discovery did not complete.").pipe(
        Effect.as<ReadonlyArray<CopilotAdvertisedModel>>([]),
      ),
    ),
  );
