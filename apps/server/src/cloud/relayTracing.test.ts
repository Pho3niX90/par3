import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TelemetryConsent from "../telemetry/TelemetryConsent.ts";
import { allowedFor, headlessRelayLayer, relayLayer } from "./relayTracing.ts";

const TRACING_CONFIG = {
  tracesUrl: "https://traces.example.com",
  tracesDataset: "relay",
  tracesToken: "token",
} as const;

const consentLayer = (
  policy?: ManagedPolicyDocument,
  telemetryEnabled = false,
  env: NodeJS.ProcessEnv = {},
) => {
  const layerSettings = ServerSettings.ServerSettingsService.layerTest({ telemetryEnabled });
  const layerPolicy = ManagedPolicy.layerTest(policy);
  const layerConsent = TelemetryConsent.layer.pipe(
    Layer.provide(layerSettings),
    Layer.provide(layerPolicy),
  );
  return Layer.mergeAll(layerSettings, layerPolicy, layerConsent).pipe(
    Layer.provide(Layer.succeed(HostProcess.Environment, env)),
  );
};

const tracesTo = (policy?: ManagedPolicyDocument) =>
  Effect.service(RelayTracing.RelayClientTracer).pipe(
    Effect.provide(
      relayLayer(
        { serviceName: "t3code-server", runtime: "node", client: "environment-server" },
        TRACING_CONFIG,
      ).pipe(Layer.provide(consentLayer(policy)), Layer.provide(FetchHttpClient.layer)),
    ),
    Effect.map(Option.isSome),
  );

it.effect("a policy with telemetry off stops relay tracing to Parity Connect", () =>
  Effect.gen(function* () {
    assert.isTrue(yield* tracesTo());
    assert.isFalse(
      yield* tracesTo({
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { telemetry: false },
      }),
    );
  }),
);

it.effect("relay tracing follows settings opt-in live and waits for desktop shell consent", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const environment: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
  const layerBase = consentLayer(undefined, false, environment);
  return Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* Effect.void.pipe(
      Effect.withSpan("relay.before-shell"),
      RelayTracing.withRelayClientTracing,
    );
    assert.isFalse(allowedFor(environment, undefined, true));
    delete environment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;

    // Still off after shell discovery until opted in.
    yield* Effect.void.pipe(
      Effect.withSpan("relay.default-off"),
      RelayTracing.withRelayClientTracing,
    );

    yield* settings.updateSettings({ telemetryEnabled: true }).pipe(Effect.orDie);
    yield* Effect.yieldNow;
    yield* Effect.void.pipe(Effect.withSpan("relay.while-on"), RelayTracing.withRelayClientTracing);
    // Flush the batch while opted in; turning off afterward drops any still-queued batch.
    yield* TestClock.adjust("5 seconds");

    yield* settings.updateSettings({ telemetryEnabled: false }).pipe(Effect.orDie);
    yield* Effect.yieldNow;
    yield* Effect.void.pipe(
      Effect.withSpan("relay.after-off"),
      RelayTracing.withRelayClientTracing,
    );
    yield* TestClock.adjust("5 seconds");
  }).pipe(
    Layer.effectDiscard,
    Layer.provide(
      relayLayer(
        { serviceName: "t3code-server", runtime: "node", client: "environment-server" },
        TRACING_CONFIG,
      ),
    ),
    Layer.provide(layerBase),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    Layer.build,
    Effect.scoped,
    Effect.andThen(
      Effect.sync(() => {
        const sent = fetchFn.mock.calls
          .map((call) => new TextDecoder().decode(call[1]?.body as Uint8Array))
          .join("\n");
        assert.notInclude(sent, "relay.before-shell");
        assert.notInclude(sent, "relay.default-off");
        assert.include(sent, "relay.while-on");
        assert.notInclude(sent, "relay.after-off");
      }),
    ),
  );
});

it.effect(
  "headless relay tracing defaults off and honors persisted settings, env, and policy",
  () =>
    Effect.gen(function* () {
      const runHeadless = (input: {
        readonly persisted?: string;
        readonly env?: NodeJS.ProcessEnv;
        readonly policy?: ManagedPolicyDocument;
      }) => {
        const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
        return Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          if (input.persisted !== undefined) {
            yield* fs.writeFileString(config.settingsPath, input.persisted);
          }
          yield* Effect.void.pipe(
            Effect.withSpan("relay.headless"),
            RelayTracing.withRelayClientTracing,
            Effect.provide(
              headlessRelayLayer(
                { serviceName: "t3code-server", runtime: "node", client: "headless-cli" },
                TRACING_CONFIG,
              ),
            ),
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-headless-relay-" }),
              ManagedPolicy.layerTest(input.policy),
              FetchHttpClient.layer.pipe(
                Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
              ),
              Layer.succeed(HostProcess.Environment, { ...input.env }),
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
          Effect.as(fetchFn),
        );
      };

      assert.strictEqual((yield* runHeadless({})).mock.calls.length, 0);
      assert.strictEqual(
        (yield* runHeadless({ persisted: JSON.stringify({ telemetryEnabled: true }) })).mock.calls
          .length,
        1,
      );
      assert.strictEqual(
        (yield* runHeadless({
          persisted: JSON.stringify({ telemetryEnabled: true }),
          env: { T3CODE_TELEMETRY_ENABLED: "false" },
        })).mock.calls.length,
        0,
      );
      assert.strictEqual(
        (yield* runHeadless({
          persisted: JSON.stringify({ telemetryEnabled: false }),
          env: { T3CODE_TELEMETRY_ENABLED: "true" },
        })).mock.calls.length,
        1,
      );
      assert.strictEqual(
        (yield* runHeadless({
          persisted: JSON.stringify({ telemetryEnabled: true }),
          env: { T3CODE_TELEMETRY_ENABLED: "true" },
          policy: {
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { telemetry: false },
          },
        })).mock.calls.length,
        0,
      );
    }),
);

it("reports the server's relay tracing policy to clients", () => {
  assert.isFalse(allowedFor({}, undefined, false));
  assert.isTrue(allowedFor({}, undefined, true));
  assert.isFalse(allowedFor({ T3CODE_TELEMETRY_ENABLED: "false" }, undefined, true));
  assert.isTrue(allowedFor({ T3CODE_TELEMETRY_ENABLED: "true" }, undefined, false));
  assert.isFalse(
    allowedFor({ DO_NOT_TRACK: "1", T3CODE_TELEMETRY_ENABLED: "true" }, undefined, true),
  );
  assert.isFalse(allowedFor({ CI: "true" }, undefined, true));
  assert.isTrue(allowedFor({ CI: "true", T3CODE_TELEMETRY_ENABLED: "true" }, undefined, false));
  assert.isFalse(
    allowedFor(
      { T3CODE_TELEMETRY_ENABLED: "true" },
      { organization: "Example Corp", lockedSettings: [], limits: { telemetry: false } },
      true,
    ),
  );
});
