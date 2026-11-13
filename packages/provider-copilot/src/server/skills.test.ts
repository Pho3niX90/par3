import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverCopilotSkills, rewriteCopilotSkillMentions } from "./skills.ts";

const writeSkill = Effect.fn("writeSkill")(function* (directory: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), contents);
});

const skillFile = (name: string, description = `${name} skill`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`;

const tempRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "copilot-skills-" }),
  );
});

const summary = (skills: ReadonlyArray<ServerProviderSkill>) =>
  skills.map(({ name, description, scope, userInvocable }) => ({
    name,
    description,
    scope,
    userInvocable,
  }));

describe("discoverCopilotSkills", () => {
  it.effect("reads the folders Copilot reads, nearest first, up to the git root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* tempRoot;
      const home = path.join(root, "home");
      const repo = path.join(root, "outer", "repo");
      const cwd = path.join(repo, "pkg");
      yield* fileSystem.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      const projectSkills = path.join(repo, ".agents", "skills");

      yield* writeSkill(
        path.join(root, "outer", ".agents", "skills", "above-root"),
        skillFile("above-root"),
      );
      yield* writeSkill(
        path.join(cwd, ".claude", "skills", "triage"),
        skillFile("triage", "package triage"),
      );
      yield* writeSkill(
        path.join(repo, ".github", "skills", "triage"),
        skillFile("triage", "repo triage"),
      );
      yield* writeSkill(
        path.join(home, ".copilot", "skills", "triage"),
        skillFile("triage", "user triage"),
      );
      yield* writeSkill(path.join(home, ".agents", "skills", "pdf"), skillFile("pdf"));
      yield* writeSkill(path.join(projectSkills, "folder"), "---\nname: renamed\n---\n");
      yield* writeSkill(path.join(projectSkills, "unnamed"), "---\ndescription: no name\n---\n");
      yield* writeSkill(path.join(projectSkills, "group", "nested"), skillFile("nested"));
      yield* writeSkill(path.join(projectSkills, "group", "nested", "inner"), skillFile("inner"));
      yield* writeSkill(path.join(projectSkills, ".hidden", "secret"), skillFile("secret"));
      yield* writeSkill(path.join(projectSkills, "plain"), "No frontmatter\n");
      yield* writeSkill(path.join(projectSkills, "loop"), skillFile("loop"));
      yield* writeSkill(path.join(projectSkills, "my-review"), skillFile("review"));
      yield* writeSkill(path.join(projectSkills, "wordy"), skillFile("wordy", "a".repeat(1_025)));
      yield* writeSkill(
        path.join(projectSkills, "agent-only"),
        "---\nname: agent-only\nuser-invocable: false\n---\n",
      );

      const skills = yield* discoverCopilotSkills(cwd, { HOME: home, USERPROFILE: home });

      expect(summary(skills)).toEqual([
        { name: "agent-only", scope: "project", userInvocable: false },
        { name: "nested", description: "nested skill", scope: "project" },
        { name: "pdf", description: "pdf skill", scope: "user" },
        { name: "renamed", scope: "project" },
        { name: "triage", description: "package triage", scope: "project" },
        { name: "unnamed", description: "no name", scope: "project" },
      ]);
      expect(skills.find((skill) => skill.name === "triage")?.path).toBe(
        path.join(cwd, ".claude", "skills", "triage", "SKILL.md"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads COPILOT_HOME in place of the personal folders, then COPILOT_SKILLS_DIRS", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* tempRoot;
      const home = path.join(root, "home");
      yield* writeSkill(path.join(home, ".agents", "skills", "personal"), skillFile("personal"));
      yield* writeSkill(
        path.join(root, "copilot-home", "skills", "configured"),
        skillFile("configured"),
      );
      yield* writeSkill(path.join(root, "extra-one", "one"), skillFile("one"));
      yield* writeSkill(path.join(root, "extra-two", "two"), skillFile("two"));

      const skills = yield* discoverCopilotSkills(undefined, {
        HOME: home,
        USERPROFILE: home,
        COPILOT_HOME: path.join(root, "copilot-home"),
        COPILOT_SKILLS_DIRS: `${path.join(root, "extra-one")}, ${path.join(root, "extra-two")}`,
      });

      expect(summary(skills)).toEqual([
        { name: "configured", description: "configured skill", scope: "user" },
        { name: "one", description: "one skill", scope: "custom" },
        { name: "two", description: "two skill", scope: "custom" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("rewriteCopilotSkillMentions", () => {
  const skills: ReadonlyArray<ServerProviderSkill> = [
    { name: "triage", path: "/skills/triage/SKILL.md", enabled: true },
    {
      name: "agent-only",
      path: "/skills/agent-only/SKILL.md",
      enabled: true,
      userInvocable: false,
    },
  ];

  it.each([
    ["$triage the diff", "/triage the diff"],
    ["first $triage, then\n$triage again", "first $triage, then\n/triage again"],
    ["$triage then $triage", "/triage then /triage"],
    ["costs $5, $HOME and $agent-only stay", "costs $5, $HOME and $agent-only stay"],
  ])("rewrites %j", (prompt, expected) => {
    expect(rewriteCopilotSkillMentions(prompt, skills)).toBe(expected);
  });
});
