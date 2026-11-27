import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";

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

it.effect(
  "keeps relay tracing off after opt-out and prevents a stale settings read from re-enabling it",
  () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const consent = yield* TelemetryConsent.TelemetryConsent;
        const settings = yield* ServerSettings.ServerSettingsService;
        assert.isFalse(consent.isRelayTracingEnabledSync());

        yield* settings.updateSettings({ telemetryEnabled: true }).pipe(Effect.orDie);
        yield* Effect.yieldNow;
        assert.isTrue(consent.isRelayTracingEnabledSync());

        yield* settings.updateSettings({ telemetryEnabled: false }).pipe(Effect.orDie);
        yield* Effect.yieldNow;
        assert.isFalse(consent.isRelayTracingEnabledSync());
        assert.isFalse(yield* consent.isAnalyticsEnabled);
        assert.isFalse(consent.isRelayTracingEnabledSync());
      }).pipe(Effect.provide(consentLayer(undefined, false, {})));

      // A getSettings call that started before an opt-out must not overwrite optedIn when it finishes.
      const changes = yield* PubSub.unbounded<ServerSettingsValue>();
      const releaseStaleRead = yield* Deferred.make<void>();
      let readCount = 0;
      const fakeSettings = Layer.succeed(ServerSettings.ServerSettingsService, {
        managedPolicy: undefined,
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.gen(function* () {
          readCount += 1;
          if (readCount === 2) {
            yield* Deferred.await(releaseStaleRead);
          }
          return { ...DEFAULT_SERVER_SETTINGS, telemetryEnabled: true };
        }),
        updateSettings: () => Effect.die(new Error("unused")),
        updateProviderInstance: () => Effect.die(new Error("unused")),
        withSettingsSnapshot: () => Effect.die(new Error("unused")),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      });
      const layer = TelemetryConsent.layer.pipe(
        Layer.provide(fakeSettings),
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(Layer.succeed(HostProcess.Environment, {})),
      );
      yield* Effect.gen(function* () {
        const consent = yield* TelemetryConsent.TelemetryConsent;
        assert.isTrue(consent.isRelayTracingEnabledSync());

        const staleRead = yield* consent.isAnalyticsEnabled.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* PubSub.publish(changes, { ...DEFAULT_SERVER_SETTINGS, telemetryEnabled: false });
        yield* Effect.yieldNow;
        assert.isFalse(consent.isRelayTracingEnabledSync());

        yield* Deferred.succeed(releaseStaleRead, undefined);
        assert.isTrue(yield* Fiber.join(staleRead));
        assert.isFalse(consent.isRelayTracingEnabledSync());
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "observabilityFor reports CI variables as environment-forced while T3CODE_TELEMETRY_ENABLED overrides CI",
  () =>
    Effect.gen(function* () {
      const readObservability = (env: NodeJS.ProcessEnv, optedIn: boolean) =>
        Effect.gen(function* () {
          const consent = yield* TelemetryConsent.TelemetryConsent;
          return consent.observabilityFor(optedIn);
        }).pipe(Effect.provide(consentLayer(undefined, optedIn, env)));

      assert.deepStrictEqual(yield* readObservability({ GITHUB_ACTIONS: "true" }, true), {
        relayTracingAllowed: false,
        telemetrySource: "environment",
        telemetryVariable: "GITHUB_ACTIONS",
        telemetryEnabled: false,
      });
      assert.deepStrictEqual(yield* readObservability({ CI: "false", GITLAB_CI: "true" }, true), {
        relayTracingAllowed: false,
        telemetrySource: "environment",
        telemetryVariable: "GITLAB_CI",
        telemetryEnabled: false,
      });
      assert.deepStrictEqual(
        yield* readObservability(
          { GITHUB_ACTIONS: "true", T3CODE_TELEMETRY_ENABLED: "true" },
          false,
        ),
        {
          relayTracingAllowed: true,
          telemetrySource: "environment",
          telemetryVariable: "T3CODE_TELEMETRY_ENABLED",
          telemetryEnabled: true,
        },
      );
      assert.deepStrictEqual(
        yield* readObservability(
          { GITHUB_ACTIONS: "true", T3CODE_TELEMETRY_ENABLED: "false" },
          true,
        ),
        {
          relayTracingAllowed: false,
          telemetrySource: "environment",
          telemetryVariable: "T3CODE_TELEMETRY_ENABLED",
          telemetryEnabled: false,
        },
      );
      assert.deepStrictEqual(
        yield* readObservability(
          { GITHUB_ACTIONS: "true", DO_NOT_TRACK: "1", T3CODE_TELEMETRY_ENABLED: "true" },
          true,
        ),
        {
          relayTracingAllowed: false,
          telemetrySource: "environment",
          telemetryVariable: "DO_NOT_TRACK",
          telemetryEnabled: false,
        },
      );
      assert.deepStrictEqual(yield* readObservability({}, false), {
        relayTracingAllowed: false,
        telemetrySource: "settings",
      });
    }),
);
