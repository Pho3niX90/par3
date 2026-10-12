import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { CopilotSettings } from "../settings.ts";
import { applyAdvertisedCopilotModels, checkCopilotProviderStatus } from "./status.ts";

const decodeSettings = Schema.decodeSync(CopilotSettings);

const enabledSettings = (overrides: Record<string, unknown> = {}) =>
  decodeSettings({ enabled: true, ...overrides });

const processSpawner = (result: { readonly stdout: string; readonly code: number }) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(result.stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

const missingBinarySpawner = ChildProcessSpawner.make(() =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      description: "copilot",
    }),
  ),
);

const probe = (
  settings: ReturnType<typeof enabledSettings>,
  spawner: ReturnType<typeof processSpawner>,
) =>
  checkCopilotProviderStatus(settings, {}).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );

describe("checkCopilotProviderStatus", () => {
  it.effect("reports a disabled instance without spawning the CLI", () =>
    Effect.gen(function* () {
      const result = yield* checkCopilotProviderStatus(decodeSettings({}), {}).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("a disabled instance must not spawn")),
        ),
      );
      expect(result.enabled).toBe(false);
      expect(result.status).toBe("disabled");
    }),
  );

  it.effect("is ready with the version, only the CLI default model, and /compact", () =>
    Effect.gen(function* () {
      const result = yield* probe(
        enabledSettings(),
        processSpawner({ stdout: "GitHub Copilot CLI 1.0.95\n", code: 0 }),
      );
      expect(result.installed).toBe(true);
      expect(result.status).toBe("ready");
      expect(result.version).toBe("1.0.95");
      expect(result.models.map((model) => model.slug)).toEqual(["default"]);
      expect(result.slashCommands?.map((command) => command.name)).toEqual(["compact"]);
    }),
  );

  it.effect("lists custom models after the default", () =>
    Effect.gen(function* () {
      const result = yield* probe(
        enabledSettings({ customModels: ["gpt-5.4", "claude-haiku-4.5"] }),
        processSpawner({ stdout: "1.0.95", code: 0 }),
      );
      expect(result.models.map((model) => [model.slug, model.isCustom])).toEqual([
        ["default", false],
        ["gpt-5.4", true],
        ["claude-haiku-4.5", true],
      ]);
    }),
  );

  it.effect("does not claim to know whether the login or token is valid", () =>
    Effect.gen(function* () {
      const withToken = yield* probe(
        enabledSettings({ enterpriseToken: "github_pat_x" }),
        processSpawner({ stdout: "1.0.95", code: 0 }),
      );
      expect(withToken.auth.status).toBe("unknown");
      expect(withToken.message).toContain("access token from settings");

      const withoutToken = yield* probe(
        enabledSettings(),
        processSpawner({ stdout: "1.0.95", code: 0 }),
      );
      expect(withoutToken.auth.status).toBe("unknown");
      expect(withoutToken.message).toContain("copilot login");
    }),
  );

  it.effect("names the enterprise host it targets", () =>
    Effect.gen(function* () {
      const result = yield* probe(
        enabledSettings({ enterpriseUrl: "https://Company.ghe.com/" }),
        processSpawner({ stdout: "1.0.95", code: 0 }),
      );
      expect(result.message).toContain("Targeting company.ghe.com.");
    }),
  );

  it.effect("reports a missing CLI as not installed", () =>
    Effect.gen(function* () {
      const result = yield* probe(enabledSettings(), missingBinarySpawner);
      expect(result.installed).toBe(false);
      expect(result.status).toBe("error");
      expect(result.message).toContain("not installed");
    }),
  );

  it.effect("reports a non-zero exit as an error with the exit code", () =>
    Effect.gen(function* () {
      const result = yield* probe(enabledSettings(), processSpawner({ stdout: "", code: 2 }));
      expect(result.installed).toBe(true);
      expect(result.status).toBe("error");
      expect(result.message).toContain("exited with code 2");
    }),
  );
});

describe("applyAdvertisedCopilotModels", () => {
  const advertised = [
    { slug: "gpt-5.4", name: "GPT-5.4" },
    { slug: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
  ];

  it.effect("lists the default, then advertised models, then custom models not advertised", () =>
    Effect.gen(function* () {
      const settings = enabledSettings({
        customModels: ["claude-haiku-4.5", "my-private-model"],
      });
      const base = yield* probe(settings, processSpawner({ stdout: "1.0.95", code: 0 }));
      const merged = applyAdvertisedCopilotModels(base, advertised, settings.customModels);
      expect(merged.models.map((model) => [model.slug, model.isCustom])).toEqual([
        ["default", false],
        ["gpt-5.4", false],
        ["claude-haiku-4.5", false],
        ["my-private-model", true],
      ]);
    }),
  );

  it.effect("leaves the snapshot alone until a session has advertised something", () =>
    Effect.gen(function* () {
      const base = yield* probe(enabledSettings(), processSpawner({ stdout: "1.0.95", code: 0 }));
      expect(applyAdvertisedCopilotModels(base, [], [])).toBe(base);
    }),
  );
});
