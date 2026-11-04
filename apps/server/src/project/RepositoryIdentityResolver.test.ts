// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) => normalizePathSeparators(value);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

const clone = (parent: string, name: string, remoteUrl: string | null) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = path.join(parent, name);
    yield* fileSystem.makeDirectory(cwd);
    yield* git(cwd, ["init"]);
    if (remoteUrl !== null) yield* git(cwd, ["remote", "add", "origin", remoteUrl]);
    return cwd;
  });

const FRONTEND = "git@github.com:Acme/frontend.git";
const BACKEND = "https://gitlab.com/Acme/backend.git";
const WORKSPACE_KEY = "workspace:github.com/acme/frontend|gitlab.com/acme/backend";

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("identifies a folder of clones by its member repositories, wherever it lives", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const makeFolder = () =>
        fileSystem.makeTempDirectoryScoped({ prefix: "t3-repository-identity-workspace-" });
      const folder = yield* makeFolder();
      yield* clone(folder, "frontend", FRONTEND);
      yield* clone(folder, "backend", BACKEND);
      yield* clone(folder, "no-remote", null);
      yield* fileSystem.makeDirectory(`${folder}/docs`);
      yield* clone(folder, ".hidden", "git@github.com:Acme/hidden.git");

      const otherMachine = yield* makeFolder();
      yield* clone(otherMachine, "z-web", FRONTEND);
      yield* clone(otherMachine, "a-api", BACKEND);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(folder);

      expect(identity).toEqual({
        canonicalKey: WORKSPACE_KEY,
        locator: { source: "git-remote", remoteName: "workspace", remoteUrl: WORKSPACE_KEY },
        rootPath: folder,
        displayName: "Acme/backend + Acme/frontend",
        members: [
          {
            path: "backend",
            canonicalKey: "gitlab.com/acme/backend",
            remoteUrl: BACKEND,
            displayName: "Acme/backend",
          },
          {
            path: "frontend",
            canonicalKey: "github.com/acme/frontend",
            remoteUrl: FRONTEND,
            displayName: "Acme/frontend",
          },
        ],
      });
      expect((yield* resolver.resolve(otherMachine))?.canonicalKey).toBe(WORKSPACE_KEY);
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns null for a folder with no member repositories or too many of them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const empty = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-workspace-empty-",
      });
      yield* clone(empty, "no-remote", null);
      yield* fileSystem.makeDirectory(`${empty}/docs`);

      const crowded = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-workspace-crowded-",
      });
      for (let index = 0; index < 65; index += 1) {
        yield* fileSystem.makeDirectory(`${crowded}/repo-${index}/.git`, { recursive: true });
      }

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve(empty)).toBeNull();
      expect(yield* resolver.resolve(crowded)).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect(
    "takes members from a par3.json manifest over what is on disk, without running git",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const folder = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-workspace-manifest-",
        });
        yield* clone(folder, "unlisted", "git@github.com:Acme/unlisted.git");
        yield* fileSystem.writeFileString(
          `${folder}/par3.json`,
          JSON.stringify({
            repositories: [
              { path: "services\\web", url: FRONTEND },
              { path: "api", url: BACKEND },
              { path: "local", url: "/srv/git/local.git" },
            ],
          }),
        );

        const runner = yield* ProcessRunner.ProcessRunner;
        const memberRuns: Array<string> = [];
        const resolver = yield* RepositoryIdentityResolver.make().pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              Effect.suspend(() => {
                if (input.args[1] !== folder) memberRuns.push(input.args[1] ?? "");
                return runner.run(input);
              }),
          }),
        );
        const identity = yield* resolver.resolve(folder);

        expect(identity?.canonicalKey).toBe(WORKSPACE_KEY);
        expect(identity?.members?.map((member) => member.path)).toEqual(["api", "services/web"]);
        expect(memberRuns).toEqual([]);
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("reads a manifest from t3.json when no par3.json exists, and prefers par3.json", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const folder = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-workspace-t3-manifest-",
      });
      yield* fileSystem.writeFileString(
        `${folder}/t3.json`,
        JSON.stringify({ repositories: [{ path: "web", url: FRONTEND }] }),
      );

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect((yield* resolver.resolve(folder))?.canonicalKey).toBe(
        "workspace:github.com/acme/frontend",
      );

      yield* fileSystem.writeFileString(
        `${folder}/par3.json`,
        JSON.stringify({ repositories: [{ path: "api", url: BACKEND }] }),
      );
      expect((yield* resolver.resolve(folder, { refresh: true }))?.canonicalKey).toBe(
        "workspace:gitlab.com/acme/backend",
      );
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("ignores a par3.json manifest in a folder that is itself a repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-workspace-repo-",
      });
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", FRONTEND]);
      yield* fileSystem.writeFileString(
        `${cwd}/par3.json`,
        JSON.stringify({ repositories: [{ path: "api", url: BACKEND }] }),
      );

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/acme/frontend");
      expect(identity?.members).toBeUndefined();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("re-reads members on refresh, including a member whose remote changed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const folder = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-workspace-refresh-",
      });
      const frontend = yield* clone(folder, "frontend", "git@github.com:Acme/old.git");

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect((yield* resolver.resolve(folder))?.canonicalKey).toBe("workspace:github.com/acme/old");

      yield* git(frontend, ["remote", "set-url", "origin", FRONTEND]);
      yield* clone(folder, "backend", BACKEND);
      expect((yield* resolver.resolve(folder))?.canonicalKey).toBe("workspace:github.com/acme/old");
      expect((yield* resolver.resolve(folder, { refresh: true }))?.canonicalKey).toBe(
        WORKSPACE_KEY,
      );
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("skips the provider refine hook for a workspace, keeping it for its members", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const folder = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-workspace-refine-",
      });
      yield* clone(folder, "frontend", FRONTEND);

      const refined: Array<string> = [];
      const resolver = yield* RepositoryIdentityResolver.make({
        refine: (identity) =>
          Effect.sync(() => {
            refined.push(identity.canonicalKey);
            return identity;
          }),
      });
      yield* resolver.resolve(folder);

      expect(refined).toEqual(["github.com/acme/frontend"]);
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      // Native realpath matches git's long paths when Windows temp dirs use 8.3 names.
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedCwd = NodeFS.realpathSync.native(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(normalizeResolvedPath(resolvedCwd));
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
      expect(yield* resolver.resolve(path.join(cwd, ".git"))).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("identifies the host of an SSH remote that leaves its user to ssh config", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-userless-remote-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.displayName).toBe("T3Tools/t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("resolves the fetch remote of a partial clone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-partial-clone-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
      yield* git(cwd, ["remote", "set-url", "--push", "origin", "git@github.com:T3Tools/push.git"]);
      yield* git(cwd, ["config", "remote.origin.promisor", "true"]);
      yield* git(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);

      const remotes = yield* git(cwd, ["remote", "-v"]);
      expect(remotes.stdout).toContain("(fetch) [blob:none]");

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.locator.remoteUrl).toBe("git@github.com:T3Tools/t3code.git");
      expect(identity?.locator.remoteName).toBe("origin");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns the git top-level root path when resolving from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-root-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "packages", "web");

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedRepoRoot = NodeFS.realpathSync.native(repoRoot);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
        normalizeResolvedPath(resolvedRepoRoot),
      );
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["bare clone", "dot-bare"] as const)(
    "resolves a %s to its Git directory and the same identity as a checkout",
    (layout) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const checkout = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-checkout-",
        });
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-bare-",
        });
        const bareGitDir = layout === "dot-bare" ? path.join(root, ".bare") : root;

        yield* git(checkout, ["init"]);
        yield* git(checkout, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
        yield* git(root, ["init", "--bare", bareGitDir]);
        if (layout === "dot-bare") {
          yield* fileSystem.writeFileString(path.join(root, ".git"), "gitdir: ./.bare\n");
        }
        yield* git(root, [
          "--git-dir",
          bareGitDir,
          "remote",
          "add",
          "origin",
          "https://github.com/T3Tools/t3code.git",
        ]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const checkoutIdentity = yield* resolver.resolve(checkout);
        expect(checkoutIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        const resolvedBareGitDir = NodeFS.realpathSync.native(bareGitDir);
        const projectRoots = layout === "dot-bare" ? [root, bareGitDir] : [root];

        for (const projectRoot of projectRoots) {
          const identity = yield* resolver.resolve(projectRoot);
          const resolvedIdentityRoot =
            identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);

          expect(identity).not.toBeNull();
          expect(identity?.canonicalKey).toBe(checkoutIdentity?.canonicalKey);
          expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
            normalizeResolvedPath(resolvedBareGitDir),
          );
        }

        yield* git(root, ["--git-dir", bareGitDir, "remote", "remove", "origin"]);
        for (const projectRoot of projectRoots) {
          expect(yield* resolver.resolve(projectRoot, { refresh: true })).toBeNull();
        }
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect(
    "returns null for non-git, missing and no-remote folders, probing only what can exist",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-non-git-",
        });
        const gitDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-no-remote-",
        });

        yield* git(gitDir, ["init"]);

        const runner = yield* ProcessRunner.ProcessRunner;
        const runs: Array<ReadonlyArray<string>> = [];
        const resolver = yield* RepositoryIdentityResolver.make().pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              Effect.suspend(() => {
                runs.push(input.args);
                return runner.run(input);
              }),
          }),
        );
        const bareProbes = () =>
          runs.filter((args) => args.some((arg) => arg.startsWith("--git-dir=")));

        expect(yield* resolver.resolve(path.join(nonGitDir, "deleted"))).toBeNull();
        expect(runs).toEqual([]);

        expect(yield* resolver.resolve(nonGitDir)).toBeNull();
        expect(bareProbes()).toEqual([]);

        expect(yield* resolver.resolve(gitDir)).toBeNull();
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("ignores local-path remotes such as GitButler's gb-local", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const localOnlyDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-local-remote-",
      });
      const mixedDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-mixed-remote-",
      });

      yield* git(localOnlyDir, ["init"]);
      yield* git(localOnlyDir, ["remote", "add", "gb-local", "."]);
      yield* git(localOnlyDir, ["remote", "add", "backup", "/srv/git/repo.git"]);
      yield* git(localOnlyDir, ["remote", "add", "archive", "file:///srv/git/repo.git"]);
      yield* git(mixedDir, ["init"]);
      yield* git(mixedDir, ["remote", "add", "gb-local", "."]);
      yield* git(mixedDir, ["remote", "add", "mirror", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve(localOnlyDir)).toBeNull();

      const mixedIdentity = yield* resolver.resolve(mixedDir);
      expect(mixedIdentity?.locator.remoteName).toBe("mirror");
      expect(mixedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["add", "replace"] as const)(
    "refreshes the primary upstream after %s before cache expiry",
    (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-upstream-test-",
        });

        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code.git"]);
        if (change === "replace") {
          yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/previous.git"]);
        }

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity?.canonicalKey).toBe(
          change === "add" ? "github.com/julius/t3code" : "github.com/t3tools/previous",
        );

        yield* git(cwd, [
          "remote",
          change === "add" ? "add" : "set-url",
          "upstream",
          "git@github.com:T3Tools/t3code.git",
        ]);
        expect(yield* resolver.resolve(cwd)).toEqual(initialIdentity);
        const identity = yield* resolver.resolve(cwd, { refresh: true });

        expect(identity).not.toBeNull();
        expect(identity?.locator.remoteName).toBe("upstream");
        expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(identity?.displayName).toBe("T3Tools/t3code");
        expect(yield* resolver.resolve(cwd)).toEqual(identity);
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("reports a fork's own remote as origin next to the upstream identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-fork-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.origin).toEqual({
        canonicalKey: "github.com/julius/t3code-fork",
        remoteUrl: "git@github.com:julius/t3code-fork.git",
        displayName: "julius/t3code-fork",
      });
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:T3Tools/platform/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/platform/t3code");
      expect(identity?.displayName).toBe("T3Tools/platform/t3code");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );
});
