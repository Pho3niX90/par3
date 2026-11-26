import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const RESET_UNIT_MS = { day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1_000 };

/**
 * Antigravity can end a turn with "Usage Limit Reached … Your limit will reset in
 * 3 days, 21 hours." in its ACP text stream. Distinct from AntigravityTurnOutcome's
 * Go-duration error-step parser. Returns the reset epoch in milliseconds.
 */
export function parseAntigravityLimitReached(text: string, now: number): number | undefined {
  if (!/reached your current quota/i.test(text)) return undefined;
  const phrase = /limit will reset in ([^.\n]+)/i.exec(text)?.[1];
  if (!phrase) return undefined;
  let total = 0;
  for (const [, amount, unit] of phrase.matchAll(/(\d+)\s*(day|hour|minute|second)s?/gi)) {
    total += Number(amount) * RESET_UNIT_MS[unit!.toLowerCase() as keyof typeof RESET_UNIT_MS];
  }
  return total > 0 ? now + total : undefined;
}

/**
 * Tracks an agent-reported Antigravity limit reset time locally in the instance's
 * profile directory without calling any external API or reading credentials.
 */
export const makeAntigravityAgentLimit = Effect.fn("makeAntigravityAgentLimit")(function* (input: {
  readonly profileDirectory: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const limitPath = path.join(input.profileDirectory, "agent-limit-resets-at");
  let reportedLimitResetsAt = yield* fs.readFileString(limitPath).pipe(
    Effect.map((text) => {
      const resetsAt = Number(text.trim());
      return Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );
  const forget = Effect.suspend(() => {
    reportedLimitResetsAt = undefined;
    return fs.remove(limitPath, { force: true }).pipe(Effect.ignore);
  });

  const read: Effect.Effect<ServerProviderUsageLimits | undefined> = Effect.gen(function* () {
    if (reportedLimitResetsAt === undefined) return undefined;
    const now = yield* Clock.currentTimeMillis;
    if (reportedLimitResetsAt <= now) {
      yield* forget;
      return undefined;
    }
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return makeUsageLimits({
      checkedAt,
      windows: [
        {
          id: "agent-limit",
          label: "Agent · Limit reached",
          kind: "other",
          usedPercent: 100,
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(reportedLimitResetsAt)),
        },
      ],
    });
  });

  const report = (resetsAt: number) =>
    Effect.suspend(() => {
      if (!Number.isFinite(resetsAt) || resetsAt <= 0) return Effect.void;
      reportedLimitResetsAt = Math.max(reportedLimitResetsAt ?? 0, resetsAt);
      return fs
        .makeDirectory(input.profileDirectory, { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFileString(limitPath, String(reportedLimitResetsAt))),
          Effect.ignore,
        );
    });

  return {
    read,
    report,
    clear: forget,
  };
});
