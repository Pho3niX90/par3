import {
  type SyncApplyInput,
  type SyncApplyOp,
  type SyncApplyOutcome,
  type SyncApplyResult,
  SyncBaseline,
  type SyncCategory,
  type SyncError,
  type SyncItem,
  SyncParticipation,
  type SyncReadResult,
  type SyncSetParticipationInput,
  type SyncSnapshot,
  splitSyncItemKey,
  syncItemKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VaultService from "../vault/VaultService.ts";
import {
  hashContents,
  makeMcpServersCategory,
  makeVaultCategory,
  type SyncCategoryProvider,
  syncFailure,
} from "./categories.ts";
import { FILE_CATEGORIES, makeFileCategory, resolveProviderHome } from "./fileCategories.ts";
import { readStoredSettings } from "./storedSettings.ts";

export class SyncStore extends Context.Service<
  SyncStore,
  {
    readonly snapshot: Effect.Effect<SyncSnapshot>;
    /** A snapshot now and after every change; watches provider homes only while enabled. */
    readonly subscribe: Stream.Stream<SyncSnapshot>;
    readonly read: (key: string) => Effect.Effect<SyncReadResult, SyncError>;
    readonly apply: (input: SyncApplyInput) => Effect.Effect<SyncApplyResult>;
    readonly setParticipation: (
      input: SyncSetParticipationInput,
    ) => Effect.Effect<SyncSnapshot, SyncError>;
  }
>()("t3/sync/SyncStore") {}

const SyncState = Schema.Struct({
  participation: Schema.NullOr(SyncParticipation),
  baselines: Schema.Record(Schema.String, SyncBaseline),
});
type SyncState = typeof SyncState.Type;
const SyncStateJson = Schema.fromJsonString(SyncState);
const decodeState = Schema.decodeUnknownOption(SyncStateJson);
const encodeState = Schema.encodeSync(SyncStateJson);

const EMPTY_STATE: SyncState = { participation: null, baselines: {} };

/** @public */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const vault = yield* VaultService.VaultService;
  const statePath = path.join(config.stateDir, "sync-state.json");
  const lock = yield* Semaphore.make(1);
  const seq = yield* Ref.make(0);
  const localChanges = yield* PubSub.unbounded<void>();

  const storedSettings = readStoredSettings(fs, config.settingsPath).pipe(Effect.option);
  const providers: ReadonlyArray<SyncCategoryProvider> = [
    makeVaultCategory(vault),
    makeMcpServersCategory({ fs, settingsPath: config.settingsPath, settings }),
    ...FILE_CATEGORIES.map((spec) =>
      makeFileCategory({
        spec,
        fs,
        path,
        home: storedSettings.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(null),
              onSome: (current) =>
                resolveProviderHome(current, spec.home).pipe(
                  Effect.provideService(Path.Path, path),
                ),
            }),
          ),
        ),
      }),
    ),
  ];
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));

  // The state file is created lazily: an environment nobody opts in leaves nothing behind.
  const readState = fs.readFileString(statePath).pipe(
    Effect.map((raw) => Option.getOrElse(decodeState(raw), () => EMPTY_STATE)),
    Effect.orElseSucceed(() => EMPTY_STATE),
  );
  const writeState = (state: SyncState) =>
    writeFileStringAtomically({ filePath: statePath, contents: `${encodeState(state)}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => syncFailure("io", "The sync state could not be saved.")),
    );

  const snapshot = Effect.gen(function* () {
    const state = yield* readState;
    const scans = yield* Effect.forEach(providers, (provider) => provider.scan, {
      concurrency: "unbounded",
    });
    const categories: SyncCategory[] = [];
    const items: SyncItem[] = [];
    providers.forEach((provider, index) => {
      const scan = scans[index]!;
      categories.push({
        id: provider.id,
        label: provider.label,
        available: scan.available,
        ...(scan.unavailableReason === undefined
          ? {}
          : { unavailableReason: scan.unavailableReason }),
        ...(scan.location === undefined ? {} : { location: scan.location }),
      });
      for (const item of scan.items) {
        items.push({
          key: syncItemKey(provider.id, item.name),
          categoryId: provider.id,
          name: item.name,
          hash: item.hash,
          byteLength: item.byteLength,
          ...(item.skipped === undefined ? {} : { skipped: item.skipped }),
        });
      }
    });
    return {
      participation: state.participation,
      categories,
      items,
      baselines: state.baselines,
      seq: yield* Ref.updateAndGet(seq, (value) => value + 1),
    } satisfies SyncSnapshot;
  }).pipe(Effect.withSpan("SyncStore.snapshot"));

  const providerFor = (key: string) => {
    const parts = splitSyncItemKey(key);
    const provider = parts === null ? undefined : providerById.get(parts.categoryId);
    return parts === null || provider === undefined
      ? Effect.fail(syncFailure("not-found", `Nothing syncs under ${key}.`))
      : Effect.succeed({ provider, name: parts.name });
  };

  const read = Effect.fn("SyncStore.read")(function* (key: string) {
    const { provider, name } = yield* providerFor(key);
    const contents = yield* provider.read(name);
    if (contents === null) return yield* syncFailure("not-found", `${name} does not exist here.`);
    return { key, contents, hash: hashContents(contents) } satisfies SyncReadResult;
  });

  const applyOne = Effect.fn("SyncStore.applyOne")(function* (state: SyncState, op: SyncApplyOp) {
    const rejected = (message: string): SyncApplyOutcome => ({
      key: op.key,
      status: "rejected",
      message,
    });
    const parts = splitSyncItemKey(op.key);
    const provider = parts === null ? undefined : providerById.get(parts.categoryId);
    if (parts === null || provider === undefined) return rejected("Unknown item.");
    const participation = state.participation;
    if (participation === null || !participation.enabled) {
      return rejected("Sync is off on this machine.");
    }
    if (!participation.categories.includes(parts.categoryId)) {
      return rejected(`${provider.label} does not sync on this machine.`);
    }
    if (participation.excluded.includes(op.key)) {
      return rejected("This item is excluded from sync on this machine.");
    }
    const current = yield* provider.read(parts.name).pipe(Effect.result);
    if (current._tag === "Failure") return rejected(current.failure.message);
    const currentHash = current.success === null ? null : hashContents(current.success);
    if (currentHash !== op.expectedHash) {
      return { key: op.key, status: "stale", currentHash } satisfies SyncApplyOutcome;
    }
    const action = op.action;
    if (action._tag === "write") {
      if (hashContents(action.contents) !== op.baseline.hash) {
        return rejected("The contents do not match the version being recorded.");
      }
      if (currentHash !== op.baseline.hash) {
        const written = yield* provider.write(parts.name, action.contents).pipe(Effect.result);
        if (written._tag === "Failure") return rejected(written.failure.message);
      }
    } else if (action._tag === "delete") {
      if (op.baseline.hash !== null) return rejected("A deletion must record a deleted version.");
      if (currentHash !== null) {
        const removed = yield* provider.remove(parts.name).pipe(Effect.result);
        if (removed._tag === "Failure") return rejected(removed.failure.message);
      }
    } else if (currentHash !== op.baseline.hash) {
      return rejected("The item here is not the version being adopted.");
    }
    return { key: op.key, status: "applied" } satisfies SyncApplyOutcome;
  });

  const apply = Effect.fn("SyncStore.apply")(function* (input: SyncApplyInput) {
    const results = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* readState;
        const baselines = { ...state.baselines };
        const outcomes: SyncApplyOutcome[] = [];
        for (const op of input.ops) {
          const outcome = yield* applyOne(state, op);
          // Recorded with the write, so the watcher's rescan sees an item at its baseline and
          // nothing bounces back.
          if (outcome.status === "applied") baselines[op.key] = op.baseline;
          outcomes.push(outcome);
        }
        if (outcomes.some((outcome) => outcome.status === "applied")) {
          yield* writeState({ ...state, baselines }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to persist sync baselines", { cause: error }),
            ),
          );
        }
        return outcomes;
      }),
    );
    // A refused or stale op changed nothing, and announcing it would replan the same ops.
    if (results.some((outcome) => outcome.status === "applied")) {
      yield* PubSub.publish(localChanges, undefined);
    }
    return { results } satisfies SyncApplyResult;
  });

  const setParticipation = Effect.fn("SyncStore.setParticipation")(function* (
    input: SyncSetParticipationInput,
  ) {
    const decidedAt = DateTime.formatIso(yield* DateTime.now);
    yield* lock.withPermits(1)(
      readState.pipe(
        Effect.flatMap((state) =>
          writeState({
            ...state,
            participation: {
              enabled: input.enabled,
              categories: [...new Set(input.categories)].filter((id) => providerById.has(id)),
              excluded: [...new Set(input.excluded)],
              decidedAt,
            },
          }),
        ),
      ),
    );
    yield* PubSub.publish(localChanges, undefined);
    return yield* snapshot;
  });

  /** Only the categories this machine syncs are watched, and only while someone listens. */
  const watchedChanges = (state: SyncState) => {
    const participation = state.participation;
    if (participation === null || !participation.enabled) return Stream.empty;
    return Stream.mergeAll(
      providers
        .filter((provider) => participation.categories.includes(provider.id))
        .map((provider) => provider.changes),
      { concurrency: "unbounded" },
    );
  };

  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      const local = yield* PubSub.subscribe(localChanges);
      const localStream = Stream.fromSubscription(local);
      const participationChanges = Stream.make(undefined).pipe(
        Stream.concat(localStream),
        Stream.mapEffect(() => readState),
        Stream.changesWith(
          (a, b) => JSON.stringify(a.participation) === JSON.stringify(b.participation),
        ),
      );
      const external = participationChanges.pipe(Stream.switchMap(watchedChanges));
      return Stream.make(undefined).pipe(
        Stream.concat(
          Stream.merge(Stream.fromPubSub(localChanges), external).pipe(
            Stream.debounce(Duration.millis(150)),
          ),
        ),
        Stream.mapEffect(() => snapshot),
      );
    }),
  );

  return SyncStore.of({ snapshot, subscribe, read, apply, setParticipation });
});

export const layer = Layer.effect(SyncStore, make);
