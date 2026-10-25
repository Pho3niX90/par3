import {
  ClaudeSettings,
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerSettings,
  SyncError,
  type SyncSkipReason,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  ANTIGRAVITY_USER_SKILL_SUBPATHS,
  resolveAntigravityUserHome,
} from "../provider/Drivers/AntigravitySkills.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import {
  type CategoryScan,
  hashContents,
  type ScannedSyncItem,
  type SyncCategoryProvider,
  syncFailure,
} from "./categories.ts";

/** Same cap as copying a project's ignored files between machines. */
const SYNC_FILE_MAX_BYTES = 1024 * 1024;
const SCAN_MAX_FILES = 2_000;
const SCAN_MAX_BYTES = 8 * 1024 * 1024;

interface FileRoot {
  /** Relative to the provider home; a single file or a directory. */
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly extension?: string;
  /** Directories inside this root the provider manages itself. */
  readonly ignore?: ReadonlyArray<string>;
}

/** Whose folder a category lives in. `agents` is `~/.agents`, which no single provider owns. */
export type SyncHome =
  | "claudeAgent"
  | "codex"
  | "opencode"
  | "antigravity"
  | "cursor"
  | "grok"
  | "pi"
  | "copilot"
  | "agents";

export interface FileCategorySpec {
  readonly id: string;
  readonly label: string;
  readonly home: SyncHome;
  readonly roots: ReadonlyArray<FileRoot>;
}

const HOME_NAMES: Readonly<Record<SyncHome, string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  cursor: "Cursor",
  grok: "Grok",
  pi: "Pi",
  copilot: "Copilot",
  agents: "Shared agents",
};

const unavailableReasonFor = (home: SyncHome) =>
  home === "agents"
    ? "There is no ~/.agents folder on this machine."
    : `${HOME_NAMES[home]} is not set up on this machine.`;

const markdownRoots = (...directories: ReadonlyArray<string>): ReadonlyArray<FileRoot> =>
  directories.map((path) => ({ path, kind: "directory", extension: ".md" }));

/**
 * Only these paths ever sync; settings, credentials, plugins and sessions stay on their machine.
 * Providers whose rules are not file-based (Cursor user rules, Muse, ACP registry agents) have none.
 * Each shared folder (`~/.claude/skills`, `~/.codex/skills`) has one owner, so no two categories write a file.
 */
export const FILE_CATEGORIES: ReadonlyArray<FileCategorySpec> = [
  {
    id: "claude.instructions",
    label: "Claude instructions and rules",
    home: "claudeAgent",
    roots: [{ path: "CLAUDE.md", kind: "file" }, ...markdownRoots("rules")],
  },
  {
    id: "claude.agents",
    label: "Claude agents",
    home: "claudeAgent",
    roots: markdownRoots("agents"),
  },
  {
    id: "claude.commands",
    label: "Claude commands",
    home: "claudeAgent",
    roots: markdownRoots("commands"),
  },
  {
    id: "claude.skills",
    label: "Claude skills",
    home: "claudeAgent",
    roots: [{ path: "skills", kind: "directory" }],
  },
  {
    id: "codex.instructions",
    label: "Codex instructions",
    home: "codex",
    roots: [{ path: "AGENTS.md", kind: "file" }],
  },
  {
    id: "codex.prompts",
    label: "Codex prompts",
    home: "codex",
    roots: markdownRoots("prompts"),
  },
  {
    id: "codex.skills",
    label: "Codex skills",
    home: "codex",
    // Codex installs its bundled skills here and replaces them on update.
    roots: [{ path: "skills", kind: "directory", ignore: [".system"] }],
  },
  // OpenCode accepts both the singular and plural folder names. opencode.json stays local: it
  // holds provider keys and MCP credentials, and plugins/tools are code.
  {
    id: "opencode.instructions",
    label: "OpenCode instructions",
    home: "opencode",
    roots: [{ path: "AGENTS.md", kind: "file" }],
  },
  {
    id: "opencode.agents",
    label: "OpenCode agents",
    home: "opencode",
    roots: markdownRoots("agents", "agent"),
  },
  {
    id: "opencode.commands",
    label: "OpenCode commands",
    home: "opencode",
    roots: markdownRoots("commands", "command"),
  },
  {
    id: "opencode.skills",
    label: "OpenCode skills",
    home: "opencode",
    roots: [
      { path: "skills", kind: "directory" },
      { path: "skill", kind: "directory" },
    ],
  },
  // Antigravity reads only these two skill folders from the user's real ~/.gemini (its profile
  // links them back); everything else there is credentials, history, or machine state.
  {
    id: "antigravity.skills",
    label: "Antigravity skills",
    home: "antigravity",
    roots: ANTIGRAVITY_USER_SKILL_SUBPATHS.map((path) => ({ path, kind: "directory" as const })),
  },
  // Cursor's user rules live in the app's own state, not in files, so only skills sync.
  {
    id: "cursor.skills",
    label: "Cursor skills",
    home: "cursor",
    roots: [{ path: "skills", kind: "directory" }],
  },
  // Grok keeps config.toml (settings), auth, sessions, and installed plugins beside these.
  {
    id: "grok.instructions",
    label: "Grok instructions",
    home: "grok",
    roots: [{ path: "AGENTS.md", kind: "file" }],
  },
  {
    id: "grok.skills",
    label: "Grok skills",
    home: "grok",
    roots: [{ path: "skills", kind: "directory" }],
  },
  // Pi's settings.json, auth.json, models.json, sessions, and extensions (code) stay local.
  {
    id: "pi.instructions",
    label: "Pi instructions",
    home: "pi",
    roots: [{ path: "AGENTS.md", kind: "file" }],
  },
  {
    id: "pi.prompts",
    label: "Pi prompts",
    home: "pi",
    roots: markdownRoots("prompts"),
  },
  {
    id: "pi.skills",
    label: "Pi skills",
    home: "pi",
    roots: [{ path: "skills", kind: "directory" }],
  },
  // Copilot's config.json holds sign-in state and installed plugins, so it never syncs.
  {
    id: "copilot.instructions",
    label: "Copilot instructions",
    home: "copilot",
    roots: [
      { path: "copilot-instructions.md", kind: "file" },
      { path: "instructions", kind: "directory", extension: ".instructions.md" },
    ],
  },
  {
    id: "copilot.agents",
    label: "Copilot agents",
    home: "copilot",
    roots: markdownRoots("agents"),
  },
  {
    id: "copilot.skills",
    label: "Copilot skills",
    home: "copilot",
    roots: [{ path: "skills", kind: "directory" }],
  },
  // Cursor, Grok, Codex and OpenCode all read ~/.agents, so it syncs once here instead of once
  // per provider.
  {
    id: "agents.skills",
    label: "Shared agent skills (~/.agents)",
    home: "agents",
    roots: [{ path: "skills", kind: "directory" }],
  },
  {
    id: "agents.commands",
    label: "Shared agent commands (~/.agents)",
    home: "agents",
    roots: markdownRoots("commands"),
  },
];

const isSyncError = Schema.is(SyncError);
const decodeClaude = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodex = Schema.decodeUnknownOption(CodexSettings);

function defaultInstance(settings: ServerSettings, driver: string) {
  const kind = ProviderDriverKind.make(driver);
  return (
    settings.providerInstances[defaultInstanceIdForDriver(kind)] ??
    Object.values(settings.providerInstances).find((candidate) => candidate.driver === kind)
  );
}

/**
 * Providers with no home setting locate theirs from the environment. `overrides` are the
 * variables that would move it: an instance that sets one has its own setup, like a custom
 * `homePath`, so it is left alone.
 */
interface EnvironmentHome {
  readonly driver: string;
  readonly overrides: ReadonlyArray<string>;
  readonly resolve: (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly home: string;
    readonly platform: NodeJS.Platform;
    readonly path: Path.Path;
  }) => string;
}

const trimmed = (value: string | undefined) => value?.trim() ?? "";

/** The home variable if set, expanded like a shell would not for a spawned CLI. */
const homeVariable =
  (variable: string, fallback: ReadonlyArray<string>): EnvironmentHome["resolve"] =>
  ({ environment, home, path }) => {
    const value = trimmed(environment[variable]);
    return value.length > 0
      ? path.resolve(expandHomePath(value, home))
      : path.join(home, ...fallback);
  };

const ENVIRONMENT_HOMES: Readonly<
  Record<Exclude<SyncHome, "claudeAgent" | "codex" | "agents">, EnvironmentHome>
> = {
  opencode: {
    driver: "opencode",
    overrides: ["XDG_CONFIG_HOME"],
    resolve: ({ environment, home, path }) => {
      const xdg = trimmed(environment.XDG_CONFIG_HOME);
      return path.join(path.isAbsolute(xdg) ? xdg : path.join(home, ".config"), "opencode");
    },
  },
  grok: { driver: "grok", overrides: ["GROK_HOME"], resolve: homeVariable("GROK_HOME", [".grok"]) },
  pi: {
    driver: "pi",
    overrides: ["PI_CODING_AGENT_DIR"],
    resolve: homeVariable("PI_CODING_AGENT_DIR", [".pi", "agent"]),
  },
  copilot: {
    driver: "copilot",
    overrides: ["COPILOT_HOME"],
    resolve: homeVariable("COPILOT_HOME", [".copilot"]),
  },
  cursor: {
    driver: "cursor",
    overrides: [],
    resolve: ({ home, path }) => path.join(home, ".cursor"),
  },
  antigravity: {
    driver: "antigravity",
    overrides: ["HOME", "USERPROFILE"],
    resolve: ({ environment, home, platform, path }) =>
      path.join(resolveAntigravityUserHome(platform, environment, home), ".gemini"),
  },
};

/**
 * The default instance's home. Instances with their own home are left alone: they exist to keep
 * a separate setup, which syncing would undo.
 */
export const resolveProviderHome = Effect.fn("sync.resolveProviderHome")(function* (
  settings: ServerSettings,
  target: SyncHome,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  if (target === "agents") return path.join(home, ".agents");
  if (target === "claudeAgent") {
    const decoded = decodeClaude(defaultInstance(settings, target)?.config ?? {});
    return Option.isSome(decoded)
      ? yield* resolveClaudeHomePath(decoded.value, yield* HostProcess.Environment)
      : null;
  }
  if (target === "codex") {
    const decoded = decodeCodex(defaultInstance(settings, target)?.config ?? {});
    return Option.isSome(decoded)
      ? (yield* resolveCodexHomeLayout(decoded.value)).sharedHomePath
      : null;
  }
  const spec = ENVIRONMENT_HOMES[target];
  const instanceEnvironment = defaultInstance(settings, spec.driver)?.environment ?? [];
  if (instanceEnvironment.some((variable) => spec.overrides.includes(variable.name))) return null;
  return spec.resolve({
    environment: yield* HostProcess.Environment,
    home,
    platform: yield* HostProcess.Platform,
    path,
  });
});

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return textDecoder.decode(bytes);
  } catch {
    return null;
  }
}

function isSafeRelativePath(name: string): boolean {
  if (name.length === 0 || name.startsWith("/") || name.includes("\\")) return false;
  return name.split("/").every((segment) => segment.length > 0 && !segment.startsWith("."));
}

function rootFor(spec: FileCategorySpec, name: string): FileRoot | undefined {
  return spec.roots.find((root) => {
    if (root.kind === "file") return name === root.path;
    if (!name.startsWith(`${root.path}/`)) return false;
    const rest = name.slice(root.path.length + 1);
    if (root.ignore?.some((ignored) => rest === ignored || rest.startsWith(`${ignored}/`))) {
      return false;
    }
    return root.extension === undefined || name.endsWith(root.extension);
  });
}

/** Whether `name` is a path this category may read or write. */
function isAllowedSyncPath(spec: FileCategorySpec, name: string): boolean {
  return isSafeRelativePath(name) && rootFor(spec, name) !== undefined;
}

export function makeFileCategory(input: {
  readonly spec: FileCategorySpec;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly home: Effect.Effect<string | null>;
}): SyncCategoryProvider {
  const { spec, fs, path } = input;

  const unavailable = (): CategoryScan => ({
    available: false,
    unavailableReason: unavailableReasonFor(spec.home),
    items: [],
  });

  const existingHome = input.home.pipe(
    Effect.flatMap((home) =>
      home === null
        ? Effect.succeed(null)
        : fs.exists(home).pipe(
            Effect.map((exists) => (exists ? home : null)),
            Effect.orElseSucceed(() => null),
          ),
    ),
  );

  const requireHome = existingHome.pipe(
    Effect.flatMap((home) =>
      home === null
        ? Effect.fail(syncFailure("category-unavailable", unavailable().unavailableReason!))
        : Effect.succeed(home),
    ),
  );

  /** Resolves `name` inside the home, refusing anything that escapes it through a link. */
  const guardedPath = Effect.fn("sync.fileCategory.guardedPath")(function* (
    home: string,
    name: string,
  ) {
    if (!isAllowedSyncPath(spec, name)) {
      return yield* syncFailure("not-allowed", `${name} is not a path ${spec.label} syncs.`);
    }
    const target = path.join(home, ...name.split("/"));
    const realHome = yield* fs.realPath(home).pipe(Effect.orElseSucceed(() => home));
    let ancestor = path.dirname(target);
    while (!(yield* fs.exists(ancestor).pipe(Effect.orElseSucceed(() => false)))) {
      ancestor = path.dirname(ancestor);
    }
    const realAncestor = yield* fs.realPath(ancestor).pipe(Effect.orElseSucceed(() => ancestor));
    if (realAncestor !== realHome && !realAncestor.startsWith(`${realHome}${path.sep}`)) {
      return yield* syncFailure("not-allowed", `${name} leads outside the provider's home.`);
    }
    const info = yield* fs.stat(target).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type !== "File") {
      return yield* syncFailure("not-allowed", `${name} is not a regular file here.`);
    }
    if (Option.isSome(info)) {
      const realTarget = yield* fs.realPath(target).pipe(Effect.orElseSucceed(() => target));
      if (realTarget !== path.join(realAncestor, path.relative(ancestor, target))) {
        return yield* syncFailure("not-allowed", `${name} is a link and is not synced.`);
      }
    }
    return target;
  });

  /** Null only when the path is gone; any other failure must not look like an absent file. */
  const orAbsent = <A>(
    effect: Effect.Effect<A, PlatformError.PlatformError>,
    failure: string,
  ): Effect.Effect<A | null, SyncError> =>
    effect.pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.logWarning(failure, { cause }).pipe(
              Effect.andThen(Effect.fail(syncFailure("io", failure))),
            ),
      ),
    );

  const scanFile = Effect.fn("sync.fileCategory.scanFile")(function* (home: string, name: string) {
    const target = path.join(home, ...name.split("/"));
    // Measured against the home's real location: a home that is itself a link (a dotfiles
    // checkout) is fine; only links inside it are skipped.
    const realHome = yield* fs.realPath(home).pipe(Effect.orElseSucceed(() => home));
    const linked = yield* fs.realPath(target).pipe(
      Effect.map((real) => real !== path.join(realHome, ...name.split("/"))),
      Effect.orElseSucceed(() => false),
    );
    const failure = `Could not read ${spec.label}.`;
    const info = yield* orAbsent(fs.stat(target), failure);
    if (info === null || info.type !== "File") return null;
    const size = Number(info.size);
    const skipped = (reason: SyncSkipReason): ScannedSyncItem => ({
      name,
      hash: "",
      byteLength: size,
      skipped: reason,
    });
    if (linked) return skipped("symlink");
    if (size > SYNC_FILE_MAX_BYTES) return skipped("too-large");
    const bytes = yield* orAbsent(fs.readFile(target), failure);
    if (bytes === null) return null;
    const text = decodeText(bytes);
    if (text === null) return skipped("binary");
    return { name, hash: hashContents(text), byteLength: size } satisfies ScannedSyncItem;
  });

  // The planner reads an item missing from a scan as deleted, so a scan that could not see
  // everything is reported unavailable rather than returned short.
  const scan = Effect.gen(function* () {
    const home = yield* existingHome;
    if (home === null) return unavailable();
    const items: ScannedSyncItem[] = [];
    let bytes = 0;
    for (const root of spec.roots) {
      const names =
        root.kind === "file"
          ? [root.path]
          : ((yield* orAbsent(
              fs.readDirectory(path.join(home, root.path), { recursive: true }),
              `Could not read ${spec.label}.`,
            ))
              ?.map((entry) => `${root.path}/${entry.split(path.sep).join("/")}`)
              .filter((name) => isAllowedSyncPath(spec, name))
              .sort() ?? []);
      for (const name of names) {
        if (items.length >= SCAN_MAX_FILES) {
          return yield* syncFailure(
            "too-large",
            `Too many files in ${spec.label} to sync (over ${SCAN_MAX_FILES.toLocaleString("en-US")}).`,
          );
        }
        if (bytes >= SCAN_MAX_BYTES) {
          return yield* syncFailure(
            "too-large",
            `${spec.label} is too large to sync (over ${SCAN_MAX_BYTES / (1024 * 1024)} MB).`,
          );
        }
        const item = yield* scanFile(home, name);
        if (item === null) continue;
        // Skipped files are never read, so they cost nothing against the budget.
        if (item.skipped === undefined) bytes += item.byteLength;
        items.push(item);
      }
    }
    return { available: true, location: home, items } satisfies CategoryScan;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed<CategoryScan>({
        available: false,
        unavailableReason: error.message,
        items: [],
      }),
    ),
    Effect.withSpan("sync.fileCategory.scan", { attributes: { category: spec.id } }),
  );

  const read = Effect.fn("sync.fileCategory.read")(function* (name: string) {
    const home = yield* requireHome;
    const target = yield* guardedPath(home, name);
    const bytes = yield* orAbsent(fs.readFile(target), `${name} could not be read.`);
    if (bytes === null) return null;
    if (bytes.byteLength > SYNC_FILE_MAX_BYTES) {
      return yield* syncFailure("too-large", `${name} is larger than 1 MB.`);
    }
    const text = decodeText(bytes);
    if (text === null) return yield* syncFailure("not-allowed", `${name} is not a text file.`);
    return text;
  });

  const write = Effect.fn("sync.fileCategory.write")(
    function* (name: string, contents: string) {
      if (Buffer.byteLength(contents, "utf8") > SYNC_FILE_MAX_BYTES) {
        return yield* syncFailure("too-large", `${name} is larger than 1 MB.`);
      }
      const home = yield* requireHome;
      const target = yield* guardedPath(home, name);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* writeFileStringAtomically({ filePath: target, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    },
    (effect, name) =>
      effect.pipe(
        Effect.mapError((error) =>
          isSyncError(error) ? error : syncFailure("io", `${name} could not be written.`),
        ),
      ),
  );

  const remove = Effect.fn("sync.fileCategory.remove")(
    function* (name: string) {
      const home = yield* requireHome;
      const target = yield* guardedPath(home, name);
      yield* fs
        .remove(target)
        .pipe(
          Effect.catch((cause) =>
            cause.reason._tag === "NotFound" ? Effect.void : Effect.fail(cause),
          ),
        );
      // Leave no empty folders behind, but never remove a category root itself.
      const stops = new Set(spec.roots.map((root) => path.join(home, root.path)));
      let directory = path.dirname(target);
      while (directory.startsWith(`${home}${path.sep}`) && !stops.has(directory)) {
        const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => ["?"]));
        if (entries.length > 0) break;
        yield* fs.remove(directory).pipe(Effect.ignore);
        directory = path.dirname(directory);
      }
    },
    (effect, name) =>
      effect.pipe(
        Effect.mapError((error) =>
          isSyncError(error) ? error : syncFailure("io", `${name} could not be removed.`),
        ),
      ),
  );

  const changes = Stream.unwrap(
    existingHome.pipe(
      Effect.flatMap((home) =>
        Effect.gen(function* () {
          if (home === null) return Stream.empty;
          const watches: Array<Stream.Stream<void>> = [
            fs.watch(home).pipe(
              Stream.map(() => undefined),
              Stream.ignore,
            ),
          ];
          for (const root of spec.roots) {
            if (root.kind !== "directory") continue;
            const directory = path.join(home, root.path);
            if (!(yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false)))) continue;
            watches.push(
              fs.watch(directory, { recursive: true }).pipe(
                Stream.map(() => undefined),
                Stream.ignore,
              ),
            );
          }
          return Stream.mergeAll(watches, { concurrency: "unbounded" });
        }),
      ),
    ),
  );

  return { id: spec.id, label: spec.label, scan, read, write, remove, changes };
}
