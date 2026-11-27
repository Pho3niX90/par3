import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";

import { connectionTracesEnabled, setConnectionTracesEnabled } from "./diagnosticsSetting";
import * as Tracing from "./tracing";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

const layerTracingTo = (fetchFn: typeof fetch) =>
  Tracing.layerFromConfig(
    {
      tracesUrl: "https://api.axiom.test/v1/traces",
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    },
    {
      appVariant: "test",
      serviceInstanceId: "test-instance",
      serviceVersion: "1.2.3",
    },
  ).pipe(Layer.provide(layerRemoteHttpClient(fetchFn)));

it("defaults connection traces off when the saved preference is unset", async () => {
  const loadDiagnosticsSetting = async (preferences: Record<string, unknown>) => {
    vi.resetModules();
    let resolveLoaded!: () => void;
    const loaded = new Promise<void>((resolve) => {
      resolveLoaded = resolve;
    });
    vi.doMock("../../persistence/imperative", () => ({
      loadPreferences: async () => {
        resolveLoaded();
        return preferences;
      },
    }));
    const mod = await import("./diagnosticsSetting");
    const beforeLoad = mod.connectionTracesEnabled();
    await loaded;
    // Drain the dynamic-import `.then(({ loadPreferences }) => loadPreferences()).then(...)` chain.
    for (let tick = 0; tick < 4; tick += 1) {
      await Promise.resolve();
    }
    return { beforeLoad, afterLoad: mod.connectionTracesEnabled() };
  };

  expect(await loadDiagnosticsSetting({})).toEqual({ beforeLoad: false, afterLoad: false });
  expect(await loadDiagnosticsSetting({ connectionTracesEnabled: true })).toEqual({
    beforeLoad: false,
    afterLoad: true,
  });
  vi.doUnmock("../../persistence/imperative");
  expect(typeof connectionTracesEnabled()).toBe("boolean");
});

it.effect.each([false, true])("gates relay sends and preserves typed failures (%s)", (enabled) => {
  setConnectionTracesEnabled(enabled);
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const layerTracing = layerTracingTo(fetchFn);
  const failure = { durationNanos: 1n };
  const layerTracedApplication = Layer.effectDiscard(
    Effect.fail(failure).pipe(
      Effect.withSpan("mobile.test.failed-span"),
      withRelayClientTracing,
      Effect.exit,
      Effect.flatMap((exit) => {
        const reason = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined;
        return reason && Cause.isFailReason(reason)
          ? Effect.sync(() => {
              expect(reason.error).toBe(failure);
            })
          : Effect.die(new Error("Expected the original typed failure."));
      }),
    ),
  ).pipe(Layer.provide(layerTracing));

  return Layer.build(layerTracedApplication).pipe(
    Effect.scoped,
    Effect.andThen(
      Effect.sync(() => {
        expect(fetchFn).toHaveBeenCalledTimes(Number(enabled));
        if (!enabled) return;
        expect(new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array)).toContain(
          "mobile.test.failed-span",
        );
      }),
    ),
  );
});
