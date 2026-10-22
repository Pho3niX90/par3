import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

/**
 * Settings as written on disk: saved secrets are redaction markers and `vault:` references are
 * inline. That is the form a settings patch echoes back, and the only form that may leave the
 * machine; the settings service hands out settings with secrets filled in.
 */
export const readStoredSettings = Effect.fn("sync.readStoredSettings")(function* (
  fs: FileSystem.FileSystem,
  settingsPath: string,
) {
  const raw = yield* fs
    .readFileString(settingsPath)
    .pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
      ),
    );
  if (raw === null) return DEFAULT_SERVER_SETTINGS;
  return yield* decodeSettings(raw);
});
