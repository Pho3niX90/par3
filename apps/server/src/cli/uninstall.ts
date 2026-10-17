// @effect-diagnostics nodeBuiltinImport:off
// The Windows cleanup shell must outlive this process (it deletes the
// directory this executable runs from), which Effect's scoped ChildProcess
// cannot express: it kills the child when the scope closes.
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import * as BootService from "../cloud/bootService.ts";
import { pinnedRuntimeVersionsDir } from "../cloud/pinnedRuntime.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";
import {
  findWindowsShim,
  launcherAliasPath,
  launcherOwnsVersionsDir,
  resolveLauncherPath,
} from "./update.ts";

export class CliUninstallError extends Schema.TaggedError<CliUninstallError>()(
  "CliUninstallError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface UninstallPlan {
  readonly service: boolean;
  /** The `par3` launcher (symlink or `.cmd` shim) that points into this home's runtime tree. */
  readonly launcher: string | undefined;
  /** The `p3` alias beside the launcher, when it runs that launcher. */
  readonly launcherAlias: string | undefined;
  /** `<home>/runtime`, holding every downloaded version, when it exists. */
  readonly runtimeDir: string | undefined;
  readonly userdataDir: string;
}

/**
 * Only a launcher that points into this home's `runtime/versions` is claimed: a plain copy of the
 * executable, or a launcher for another home, is not ours to delete.
 */
export const findOwnedLauncher = Effect.fn("cli.uninstall.find_launcher")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly versionsDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  if (input.launchedAs === undefined) return undefined;
  if (platform === "win32") {
    const shimPath = yield* findWindowsShim(input.launchedAs);
    if (shimPath === undefined) return undefined;
    const contents = yield* fs.readFileString(shimPath).pipe(Effect.option);
    const target = Option.isSome(contents) ? /^"([^"]+)"/m.exec(contents.value)?.[1] : undefined;
    return target !== undefined && launcherOwnsVersionsDir(path, input.versionsDir, target)
      ? shimPath
      : undefined;
  }
  const linkTarget = yield* fs.readLink(input.launchedAs).pipe(Effect.option);
  if (Option.isNone(linkTarget)) return undefined;
  const resolved = path.resolve(path.dirname(input.launchedAs), linkTarget.value);
  return launcherOwnsVersionsDir(path, input.versionsDir, resolved) ? input.launchedAs : undefined;
});

/** The `p3` alias next to `launcher`, when it is the one the install scripts wrote for it. */
export const findOwnedAlias = Effect.fn("cli.uninstall.find_alias")(function* (launcher: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const alias = launcherAliasPath(path, launcher);
  if (path.extname(launcher) === ".cmd") {
    const contents = yield* fs.readFileString(alias).pipe(Effect.option);
    return Option.isSome(contents) && contents.value.includes(`"%~dp0${path.basename(launcher)}"`)
      ? alias
      : undefined;
  }
  const target = yield* fs.readLink(alias).pipe(Effect.option);
  return Option.isSome(target) && path.resolve(path.dirname(alias), target.value) === launcher
    ? alias
    : undefined;
});

const planUninstall = Effect.fn("cli.uninstall.plan")(function* (input: {
  readonly baseDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  const servesThisHome =
    status.installedBaseDir !== undefined &&
    path.resolve(status.installedBaseDir) === path.resolve(input.baseDir);
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const runtimeDir = path.dirname(versionsDir);
  const launchedAs = (yield* HostProcess.IsExecutable) ? yield* resolveLauncherPath : undefined;
  const launcher = yield* findOwnedLauncher({ launchedAs, versionsDir });
  const plan: UninstallPlan = {
    service: status.supported && status.installed && servesThisHome,
    launcher,
    launcherAlias: launcher === undefined ? undefined : yield* findOwnedAlias(launcher),
    runtimeDir: (yield* fs.exists(runtimeDir).pipe(Effect.orElseSucceed(() => false)))
      ? runtimeDir
      : undefined,
    userdataDir: path.join(input.baseDir, "userdata"),
  };
  return plan;
});

export const uninstallCommand = Command.make("uninstall", {
  ...projectLocationFlags,
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Remove everything without asking. Required from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Remove Par3 from this machine: the background service, the launcher, and every downloaded version. Your projects and threads are kept.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* runUninstall({ baseDir: config.baseDir, assumeYes: flags.yes }).pipe(
        Effect.provide(CliService.layer(config)),
      );
    }),
  ),
);

const runUninstall = Effect.fn("cli.uninstall.run")(function* (input: {
  readonly baseDir: string;
  readonly assumeYes: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const service = yield* BootService.BootService;
  const plan = yield* planUninstall({ baseDir: input.baseDir });

  if (!plan.service && plan.launcher === undefined && plan.runtimeDir === undefined) {
    yield* Console.log(`Nothing to remove: Par3 is not installed for ${input.baseDir}.`);
    if (!(yield* HostProcess.IsExecutable)) {
      yield* Console.log(
        "  This Par3 runs from a Node script, so it was installed by npm or built from source. Remove it the same way (`npm uninstall -g @paritylabs/par3`, or delete the checkout).",
      );
    }
    return;
  }

  yield* Console.log("This will remove:");
  if (plan.service) yield* Console.log("  the background service (stopping it first)");
  if (plan.launcher !== undefined) yield* Console.log(`  the launcher at ${plan.launcher}`);
  if (plan.launcherAlias !== undefined) yield* Console.log(`  its alias at ${plan.launcherAlias}`);
  if (plan.runtimeDir !== undefined) {
    yield* Console.log(`  every downloaded version under ${plan.runtimeDir}`);
  }
  yield* Console.log(
    `Your projects, threads, and settings under ${plan.userdataDir} are kept. Delete that directory yourself if you want them gone too.`,
  );

  if (!input.assumeYes) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      return yield* new CliUninstallError({
        reason:
          "Not a terminal, so nothing was removed. Rerun with --yes to confirm from a script.",
      });
    }
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({ message: "Remove Par3 from this machine?", initial: false }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) {
      yield* Console.log("Left as is.");
      return;
    }
  }

  if (plan.service) {
    yield* service.uninstall;
    yield* Console.log("Removed the background service.");
  }
  if (plan.launcher !== undefined) {
    yield* fs
      .remove(plan.launcher, { force: true })
      .pipe(
        Effect.mapError(
          () =>
            new CliUninstallError({ reason: `Could not remove the launcher at ${plan.launcher}.` }),
        ),
      );
    yield* Console.log(`Removed ${plan.launcher}.`);
  }
  if (plan.launcherAlias !== undefined) {
    const alias = plan.launcherAlias;
    yield* fs
      .remove(alias, { force: true })
      .pipe(
        Effect.mapError(
          () => new CliUninstallError({ reason: `Could not remove the alias at ${alias}.` }),
        ),
      );
    yield* Console.log(`Removed ${alias}.`);
  }
  if (plan.runtimeDir !== undefined) {
    // This process runs from inside runtimeDir. POSIX unlinks a running
    // executable fine; Windows refuses, so the tree is removed after this
    // process exits by a detached shell, and the user is told either way.
    if (platform === "win32") {
      const runtimeDir = plan.runtimeDir;
      const comspec = environment["ComSpec"] ?? environment["COMSPEC"] ?? "cmd.exe";
      yield* Effect.try({
        try: () => {
          const child = NodeChildProcess.spawn(
            comspec,
            ["/d", "/c", `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${runtimeDir}"`],
            { detached: true, stdio: "ignore", windowsHide: true },
          );
          child.unref();
        },
        catch: () =>
          new CliUninstallError({
            reason: `Could not schedule removal of ${runtimeDir}. Delete it yourself once this window is closed.`,
          }),
      });
      yield* Console.log(`${runtimeDir} will be removed once Par3 exits.`);
    } else {
      yield* fs
        .remove(plan.runtimeDir, { recursive: true, force: true })
        .pipe(
          Effect.mapError(
            () => new CliUninstallError({ reason: `Could not remove ${plan.runtimeDir}.` }),
          ),
        );
      yield* Console.log(`Removed ${plan.runtimeDir}.`);
    }
  }
  yield* Console.log("");
  yield* Console.log("Par3 is uninstalled. Thanks for trying it.");
});
