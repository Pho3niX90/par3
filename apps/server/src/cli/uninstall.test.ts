import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { findOwnedAlias, findOwnedLauncher } from "./uninstall.ts";

it.layer(NodeServices.layer)("par3 uninstall launcher", (it) => {
  it.effect("claims only a launcher that points into this home's runtime tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const versionsDir = path.join(root, "runtime/versions");
      const exe = path.join(versionsDir, "1.0.0/t3");
      const otherExe = path.join(root, "other/runtime/versions/1.0.0/t3");
      const copy = path.join(root, "copy/t3");
      for (const file of [exe, otherExe, copy]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const ours = path.join(root, "bin/par3");
      const theirs = path.join(root, "other/bin/par3");
      yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.symlink(exe, ours);
      yield* fs.symlink(otherExe, theirs);

      assert.equal(yield* findOwnedLauncher({ launchedAs: ours, versionsDir }), ours);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: theirs, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: copy, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: undefined, versionsDir }));
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("claims the p3 alias only when it runs the launcher being removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const launcher = path.join(root, "bin/par3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "");
      assert.isUndefined(yield* findOwnedAlias(launcher));

      yield* fs.symlink("par3", path.join(root, "bin/p3"));
      assert.equal(yield* findOwnedAlias(launcher), path.join(root, "bin/p3"));

      const other = path.join(root, "other/par3");
      yield* fs.makeDirectory(path.dirname(other), { recursive: true });
      yield* fs.symlink(launcher, path.join(root, "other/p3"));
      assert.isUndefined(yield* findOwnedAlias(other));
    }).pipe(Effect.scoped),
  );

  it.effect("claims a p3.cmd alias only when it calls the par3.cmd beside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const launcher = path.join(root, "par3.cmd");
      const alias = path.join(root, "p3.cmd");
      yield* fs.writeFileString(launcher, '@echo off\r\n"C:\\t3.exe" %*');
      yield* fs.writeFileString(alias, '@echo off\r\n"C:\\other.exe" %*');
      assert.isUndefined(yield* findOwnedAlias(launcher));

      yield* fs.writeFileString(alias, '@echo off\r\n"%~dp0par3.cmd" %*');
      assert.equal(yield* findOwnedAlias(launcher), alias);
    }).pipe(Effect.scoped),
  );
});
