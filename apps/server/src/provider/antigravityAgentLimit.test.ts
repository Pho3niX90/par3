import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";

import {
  makeAntigravityAgentLimit,
  parseAntigravityLimitReached,
} from "./antigravityAgentLimit.ts";

describe("Antigravity agent-reported limits", () => {
  it.effect("persists a limit the agent reported until it resets or is cleared", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-antigravity-agent-limit-",
      });
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-09T12:00:00Z")));
      const open = makeAntigravityAgentLimit({ profileDirectory });
      const tracker = yield* open;

      expect(yield* tracker.read).toBeUndefined();

      const now = yield* Clock.currentTimeMillis;
      const resetsAt = parseAntigravityLimitReached(
        "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 3 days, 21 hours.",
        now,
      );
      expect(resetsAt).toBe(now + (3 * 24 + 21) * 3_600_000);

      yield* tracker.report(resetsAt!);
      const limited = yield* tracker.read;
      expect(limited?.unavailable).toBeUndefined();
      expect(limited?.windows).toEqual([
        {
          id: "agent-limit",
          label: "Agent · Limit reached",
          kind: "other",
          usedPercent: 100,
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAt!)),
        },
      ]);

      // Survives a restart by reading agent-limit-resets-at from the profile directory.
      expect((yield* (yield* open).read)?.windows).toEqual(limited?.windows);

      // Clearing removes both in-memory state and the persisted file.
      yield* tracker.clear;
      expect(yield* tracker.read).toBeUndefined();
      expect(yield* (yield* open).read).toBeUndefined();

      // Expires automatically once the reset time passes.
      yield* tracker.report(now + 60_000);
      expect((yield* tracker.read)?.windows).toHaveLength(1);
      yield* TestClock.adjust("60 seconds");
      expect(yield* tracker.read).toBeUndefined();
      expect(yield* (yield* open).read).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("only reads the agent's quota message", () => {
    const now = 1_000;
    expect(parseAntigravityLimitReached("Your limit will reset in 5 hours.", now)).toBeUndefined();
    expect(
      parseAntigravityLimitReached("You have reached your current quota for this period.", now),
    ).toBeUndefined();
    expect(
      parseAntigravityLimitReached(
        "You have reached your current quota. Your limit will reset in 1 hour, 30 minutes.",
        now,
      ),
    ).toBe(now + 90 * 60_000);
  });
});
