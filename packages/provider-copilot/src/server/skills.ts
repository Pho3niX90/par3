/**
 * Lists the skills GitHub Copilot CLI loads, for the `$` picker. Copilot names its skills only
 * inside a session, mixed in with its own slash commands, so the folders are read here the way
 * Copilot 1.0.111 reads them. Plugin skills and `disabledSkills` are not read.
 *
 * @module provider-copilot/server/skills
 */
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { matchInlineSkills } from "@t3tools/shared/inlineSkills";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const PROJECT_SKILL_FOLDERS = [".github", ".agents", ".claude"] as const;
// Copilot drops a skill whose description is longer than this.
const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_SKILL_BYTES = 1_000_000;
const MAX_DEPTH = 10;
const MAX_DIRECTORIES = 10_000;

interface SkillRoot {
  readonly directory: string;
  readonly scope: "project" | "user" | "custom";
}

/** Copilot ignores a SKILL.md without frontmatter; `name` falls back to the folder's name. */
function parseCopilotSkill(
  contents: string,
  folderName: string,
  path: string,
  scope: SkillRoot["scope"],
): ServerProviderSkill | undefined {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (match === null) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return undefined;
  }
  const record =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const name = (typeof record.name === "string" ? record.name.trim() : "") || folderName;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (description.length > MAX_DESCRIPTION_LENGTH) return undefined;
  const userInvocable = record["user-invocable"];
  return {
    name,
    path,
    scope,
    enabled: true,
    ...(description ? { description } : {}),
    ...(userInvocable === false || userInvocable === "false" ? { userInvocable: false } : {}),
  };
}

/** In Copilot's first-found-wins order. */
const copilotSkillRoots = Effect.fn("copilotSkillRoots")(function* (
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots: Array<SkillRoot> = [];
  if (cwd !== undefined) {
    const ancestors: Array<string> = [];
    for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
      ancestors.push(directory);
      if (path.dirname(directory) === directory) break;
    }
    // Copilot climbs to the git root, or to the drive root outside a repository.
    let searched = ancestors;
    for (const [index, directory] of ancestors.entries()) {
      const isGitRoot = yield* fileSystem
        .exists(path.join(directory, ".git"))
        .pipe(Effect.orElseSucceed(() => false));
      if (isGitRoot) {
        searched = ancestors.slice(0, index + 1);
        break;
      }
    }
    for (const directory of searched) {
      for (const folder of PROJECT_SKILL_FOLDERS) {
        roots.push({ directory: path.join(directory, folder, "skills"), scope: "project" });
      }
    }
  }
  // With COPILOT_HOME set, Copilot no longer reads ~/.agents/skills.
  const copilotHome = environment.COPILOT_HOME?.trim();
  if (copilotHome) {
    roots.push({ directory: path.join(copilotHome, "skills"), scope: "user" });
  } else {
    const platform = yield* HostProcess.Platform;
    const home =
      (platform === "win32" ? environment.USERPROFILE : environment.HOME)?.trim() ||
      (yield* HostProcess.HomeDirectory);
    roots.push(
      { directory: path.join(home, ".copilot", "skills"), scope: "user" },
      { directory: path.join(home, ".agents", "skills"), scope: "user" },
    );
  }
  for (const directory of (environment.COPILOT_SKILLS_DIRS ?? "").split(",")) {
    if (directory.trim()) roots.push({ directory: directory.trim(), scope: "custom" });
  }
  return roots;
});

/** Never fails: an unreadable folder or file only leaves its skills out. */
export const discoverCopilotSkills = Effect.fn("discoverCopilotSkills")(function* (
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills = new Map<string, ServerProviderSkill>();
  const visited = new Set<string>();
  let remainingDirectories = MAX_DIRECTORIES;

  // Untraced: one span per scanned folder would swamp the discovery span.
  const visit: (
    directory: string,
    depth: number,
    scope: SkillRoot["scope"],
  ) => Effect.Effect<void> = Effect.fnUntraced(
    function* (directory: string, depth: number, scope: SkillRoot["scope"]) {
      const real = yield* fileSystem.realPath(directory);
      if (visited.has(real) || remainingDirectories <= 0) return;
      visited.add(real);
      remainingDirectories -= 1;
      const skillPath = path.join(directory, "SKILL.md");
      const skillInfo = yield* fileSystem.stat(skillPath).pipe(Effect.option);
      // A skill's own subfolders hold its resources, and Copilot does not look inside them.
      if (Option.isSome(skillInfo) && skillInfo.value.type === "File") {
        if (skillInfo.value.size > MAX_SKILL_BYTES) return;
        const skill = parseCopilotSkill(
          yield* fileSystem.readFileString(skillPath),
          path.basename(directory),
          skillPath,
          scope,
        );
        if (skill !== undefined && !skills.has(skill.name)) skills.set(skill.name, skill);
        return;
      }
      if (depth >= MAX_DEPTH) return;
      const entries = yield* fileSystem.readDirectory(directory);
      for (const entry of [...entries].sort()) {
        if (entry.startsWith(".")) continue;
        const child = path.join(directory, entry);
        const info = yield* fileSystem.stat(child).pipe(Effect.option);
        if (Option.isSome(info) && info.value.type === "Directory") {
          yield* visit(child, depth + 1, scope);
        }
      }
    },
    (effect) => Effect.ignore(effect),
  );

  for (const root of yield* copilotSkillRoots(cwd, environment)) {
    yield* visit(root.directory, 0, root.scope);
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
});

/** Copilot runs a skill named as `/name` anywhere in a prompt; the `$` picker inserts `$name`. */
export function rewriteCopilotSkillMentions(
  prompt: string,
  skills: ReadonlyArray<ServerProviderSkill>,
): string {
  const invocable = skills.filter((skill) => skill.enabled && skill.userInvocable !== false);
  let rewritten = "";
  let cursor = 0;
  for (const mention of matchInlineSkills(prompt, invocable)) {
    rewritten += `${prompt.slice(cursor, mention.start)}/${mention.skill.name}`;
    cursor = mention.end;
  }
  return rewritten + prompt.slice(cursor);
}
