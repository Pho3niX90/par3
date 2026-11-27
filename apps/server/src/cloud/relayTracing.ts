import type { ManagedPolicySummary } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
} from "@t3tools/shared/observability";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import { parsePersistedServerTelemetryEnabled } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as TelemetryConsent from "../telemetry/TelemetryConsent.ts";
import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

const relayClientTracingConfig = resolveRelayClientTracingConfig();

export const allowedFor = (
  env: Readonly<Record<string, string | undefined>>,
  policy: ManagedPolicySummary | undefined,
  optedIn: boolean,
) => TelemetryConsent.relayTracingAllowedFor(env, policy, optedIn);

/** Relay traces leave the machine for T3 Connect, so a policy with `telemetry: false` stops them. */
export const relayLayer = (
  resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
  tracingConfig = relayClientTracingConfig,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const policy = yield* ManagedPolicy.ManagedPolicy;
      const consent = yield* TelemetryConsent.TelemetryConsent;
      return RelayTracing.layer(
        ManagedPolicy.deniedBy(policy, "telemetry") === undefined ? tracingConfig : null,
        // Never the operator's own `service.instance.id`: it names their machine for their receiver.
        { ...resource, serviceInstanceId: processServiceInstanceId() },
        { isEnabled: consent.isRelayTracingEnabledSync },
      );
    }),
  );

export const headlessRelayLayer = (
  resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
  tracingConfig = relayClientTracingConfig,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const policy = yield* ManagedPolicy.ManagedPolicy;
      const environment = yield* HostProcess.Environment;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const rawSettings = yield* fs.readFileString(config.settingsPath).pipe(Effect.option);
      const optedIn = Option.match(rawSettings, {
        onNone: () => false,
        onSome: parsePersistedServerTelemetryEnabled,
      });
      return RelayTracing.layer(
        ManagedPolicy.deniedBy(policy, "telemetry") === undefined ? tracingConfig : null,
        { ...resource, serviceInstanceId: processServiceInstanceId() },
        { isEnabled: () => allowedFor(environment, policy.summary, optedIn) },
      );
    }),
  );

export const layerHeadlessRelayClient = headlessRelayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});
