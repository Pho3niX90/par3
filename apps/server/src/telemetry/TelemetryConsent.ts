import type { ManagedPolicySummary, ServerObservability } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";

const TELEMETRY_ENABLED_ENV_VAR = "T3CODE_TELEMETRY_ENABLED";
const DO_NOT_TRACK_ENV_VAR = "DO_NOT_TRACK";

export type TelemetryObservabilityFields = Pick<
  ServerObservability,
  "telemetrySource" | "telemetryVariable" | "telemetryEnabled"
> & {
  readonly relayTracingAllowed: boolean;
};

function analyticsAllowedFor(
  env: Readonly<Record<string, string | undefined>>,
  policy: ManagedPolicySummary | undefined,
  optedIn: boolean,
): boolean {
  if (policy?.limits?.telemetry === false) return false;
  if (env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING === "1") return false;
  if (OtelEnvironment.isDoNotTrackSet(env)) return false;
  const envOverride = OtelEnvironment.readTelemetryEnvOverride(env);
  return envOverride !== undefined ? envOverride : optedIn && !OtelEnvironment.isCiEnvironment(env);
}

/**
 * `false` unless the user opted in (or `T3CODE_TELEMETRY_ENABLED=true`) and neither managed
 * policy, `DO_NOT_TRACK`, CI, OTEL SDK kill switches, nor pending desktop shell discovery veto it.
 */
export function relayTracingAllowedFor(
  env: Readonly<Record<string, string | undefined>>,
  policy: ManagedPolicySummary | undefined,
  optedIn: boolean,
): boolean {
  return (
    policy?.limits?.telemetry !== false &&
    env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING !== "1" &&
    OtelEnvironment.isRelayTracingEnabled(env, optedIn)
  );
}

function telemetryObservabilityFields(
  env: Readonly<Record<string, string | undefined>>,
  policy: ManagedPolicySummary | undefined,
  optedIn: boolean,
): TelemetryObservabilityFields {
  const relayTracingAllowed = relayTracingAllowedFor(env, policy, optedIn);
  if (OtelEnvironment.isDoNotTrackSet(env)) {
    return {
      relayTracingAllowed,
      telemetrySource: "environment",
      telemetryVariable: DO_NOT_TRACK_ENV_VAR,
      telemetryEnabled: false,
    };
  }
  const envOverride = OtelEnvironment.readTelemetryEnvOverride(env);
  if (envOverride !== undefined) {
    return {
      relayTracingAllowed,
      telemetrySource: "environment",
      telemetryVariable: TELEMETRY_ENABLED_ENV_VAR,
      telemetryEnabled: envOverride,
    };
  }
  const ciVariable = OtelEnvironment.ciEnvironmentVariable(env);
  if (ciVariable !== undefined) {
    return {
      relayTracingAllowed,
      telemetrySource: "environment",
      telemetryVariable: ciVariable,
      telemetryEnabled: false,
    };
  }
  return {
    relayTracingAllowed,
    telemetrySource: "settings",
  };
}

export class TelemetryConsent extends Context.Service<
  TelemetryConsent,
  {
    readonly isAnalyticsEnabled: Effect.Effect<boolean>;
    readonly isRelayTracingEnabledSync: () => boolean;
    readonly withdrawals: () => number;
    readonly observabilityFor: (optedIn: boolean) => TelemetryObservabilityFields;
  }
>()("t3/telemetry/TelemetryConsent") {}

const make = Effect.gen(function* () {
  const hostEnvironment = yield* HostProcess.Environment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const policySummary = policy.summary;
  const awaitingShellConsent = hostEnvironment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING === "1";
  const startupEnvOverride = Option.getOrUndefined(
    yield* Config.Boolean(TELEMETRY_ENABLED_ENV_VAR).pipe(Config.option),
  );

  // Subscribe before the initial read so a change between the two is queued and applied after.
  const changes = yield* serverSettings.subscribeChanges;
  let optedIn = yield* serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.telemetryEnabled),
    Effect.orElseSucceed(() => false),
  );
  let withdrawalCount = 0;

  // Desktop shell discovery mutates `hostEnvironment` in place; tests may only set `ConfigProvider`.
  const effectiveEnv = (): Readonly<Record<string, string | undefined>> =>
    awaitingShellConsent ||
    OtelEnvironment.readTelemetryEnvOverride(hostEnvironment) !== undefined ||
    startupEnvOverride === undefined
      ? hostEnvironment
      : { ...hostEnvironment, [TELEMETRY_ENABLED_ENV_VAR]: String(startupEnvOverride) };

  yield* changes.pipe(
    Stream.runForEach((settings) =>
      Effect.sync(() => {
        optedIn = settings.telemetryEnabled;
        if (!analyticsAllowedFor(effectiveEnv(), policySummary, settings.telemetryEnabled)) {
          withdrawalCount += 1;
        }
      }),
    ),
    Effect.forkScoped,
  );

  const isAnalyticsEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) =>
      analyticsAllowedFor(effectiveEnv(), policySummary, settings.telemetryEnabled),
    ),
    Effect.orElseSucceed(() => false),
  );

  const isRelayTracingEnabledSync = () =>
    relayTracingAllowedFor(effectiveEnv(), policySummary, optedIn);

  const withdrawals = () => withdrawalCount;

  const observabilityFor = (settingEnabled: boolean) =>
    telemetryObservabilityFields(effectiveEnv(), policySummary, settingEnabled);

  return TelemetryConsent.of({
    isAnalyticsEnabled,
    isRelayTracingEnabledSync,
    withdrawals,
    observabilityFor,
  });
});

export const layer = Layer.effect(TelemetryConsent, make);
