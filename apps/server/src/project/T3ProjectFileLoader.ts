import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { PROJECT_FILE_NAMES, type T3ProjectFile } from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";

const decodeT3ProjectFileJson = Schema.decodeEffect(T3ProjectFileFromJson);

export class T3ProjectFileLoadError extends Schema.TaggedError<T3ProjectFileLoadError>()(
  "T3ProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    fileName: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${this.fileName} at ${this.filePath}.`;
  }
}

/** The first project file present in `folder`, in `PROJECT_FILE_NAMES` order. */
export const findProjectFile = Effect.fn("T3ProjectFileLoader.findProjectFile")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  folder: string,
) {
  for (const fileName of PROJECT_FILE_NAMES) {
    const filePath = path.join(folder, fileName);
    // A file that cannot be probed counts as present, so its read error surfaces over a fallback.
    if (yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => true))) {
      return { fileName, filePath };
    }
  }
  return null;
});

export class T3ProjectFileLoader extends Context.Service<
  T3ProjectFileLoader,
  {
    /** Never fails; missing/unreadable/invalid files return none, with warnings for invalid files. */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<T3ProjectFile>>;
  }
>()("t3/project/T3ProjectFileLoader") {}

const logT3ProjectFileLoadError = (error: T3ProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: T3ProjectFileLoader["Service"]["load"] = Effect.fn("T3ProjectFileLoader.load")(
    function* (workspaceRoot) {
      const found = yield* findProjectFile(fileSystem, path, workspaceRoot);
      if (found === null) return Option.none<T3ProjectFile>();
      const { fileName, filePath } = found;
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.asSome,
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : logT3ProjectFileLoadError(
                  new T3ProjectFileLoadError({
                    operation: "read",
                    workspaceRoot,
                    fileName,
                    filePath,
                    cause: error,
                  }),
                ).pipe(Effect.as(Option.none<string>())),
        }),
      );
      if (Option.isNone(raw)) {
        return Option.none<T3ProjectFile>();
      }
      return yield* decodeT3ProjectFileJson(raw.value).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (error) =>
            logT3ProjectFileLoadError(
              new T3ProjectFileLoadError({
                operation: "decode",
                workspaceRoot,
                fileName,
                filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<T3ProjectFile>())),
        }),
      );
    },
  );

  return T3ProjectFileLoader.of({ load });
});

export const layer = Layer.effect(T3ProjectFileLoader, make);
