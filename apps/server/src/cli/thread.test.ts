import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunId, ThreadId, type ThreadCost } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { Command } from "effect/cli";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";

import {
  printThreadCost,
  readLatestMessages,
  threadCommand,
  threadCostLines,
  type ThreadTools,
  titleFromMessage,
  waitForRun,
} from "./thread.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

/** Serves t3_thread_read pages the way the server does: positions count every item. */
const timelineTools = (types: ReadonlyArray<string>) => {
  const items = types.map((type, position) => ({ position, itemId: `item-${position}`, type }));
  const served: Array<number> = [];
  const call = ((_tool: string, input: unknown) => {
    const args = input as { readonly afterPosition?: number; readonly limit: number };
    // Scanning one match past the page keeps reads of huge fixtures linear.
    const matching: typeof items = [];
    for (let position = (args.afterPosition ?? -1) + 1; position < items.length; position++) {
      const item = items[position]!;
      if (["user_message", "assistant_message", "proposed_plan"].includes(item.type)) {
        matching.push(item);
        if (matching.length > args.limit) break;
      }
    }
    const page = matching.slice(0, args.limit);
    served.push(page.length);
    return Effect.succeed({
      thread: { itemCount: items.length },
      items: page,
      nextPosition: page.at(-1)?.position ?? null,
      hasMore: matching.length > page.length,
    });
  }) as ThreadTools["call"];
  const latest = (count: number) =>
    items
      .filter((item) => item.type === "user_message" || item.type === "assistant_message")
      .slice(-count)
      .map((item) => item.itemId);
  return { tools: { call } satisfies ThreadTools, served, latest };
};

const tail = (tools: number) => [...Array<string>(tools).fill("tool_call"), "assistant_message"];

it.effect("show reads the end of a long thread, not its whole history", () =>
  Effect.gen(function* () {
    const { tools, served, latest } = timelineTools([
      ...Array.from({ length: 1000 }, (_, index) =>
        index % 2 === 0 ? "user_message" : "assistant_message",
      ),
      ...Array.from({ length: 10 }, () => tail(30)).flat(),
      "proposed_plan",
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.isBelow(
      served.reduce((sum, count) => sum + count, 0),
      100,
    );
  }),
);

it.effect("show widens back to the first item when the thread has fewer messages", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools([
      "user_message",
      ...Array.from({ length: 4 }, () => tail(150)).flat(),
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.lengthOf(messages, 5);
  }),
);

it.effect("show returns a --messages count larger than one call can spread", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools(Array<string>(200_000).fill("assistant_message"));

    const { messages } = yield* readLatestMessages(tools, threadId, 200_000);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(200_000),
    );
  }),
);

const emptyCostScope = { threadCount: 0, costUsd: 0, models: [] };

it("cost prints the figure, its split, its models, and why it may be low", () => {
  assert.deepStrictEqual(
    threadCostLines({
      threadId,
      readAt: "2026-08-02T00:00:00.000Z",
      totalCostUsd: 1.5,
      thread: {
        threadCount: 1,
        costUsd: 1.5,
        models: [
          {
            provider: "claude",
            model: "claude-fable-5",
            totals: {
              uncachedInputTokens: 1000,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 500,
              reasoningTokens: 100,
            },
            costUsd: 1.5,
            costSource: "modelPriced",
            records: 2,
            unpricedRecords: 0,
          },
        ],
      },
      subagents: { threadCount: 1, costUsd: 0, models: [] },
      coverage: {
        complete: false,
        untrackedConversations: 1,
        conversationsWithoutUsage: 0,
        unreadableSources: 0,
        unpricedRecords: 0,
      },
      pricing: null,
    }),
    [
      "$1.50+",
      "This thread: $1.50",
      "1 sub-agent: $0.00",
      "claude-fable-5: $1.50 (1.50K tokens)",
      "Note: 1 conversation uses a provider with no usage history.",
    ],
  );
});

it("cost says the figure is unknown when a thread has no usage to read", () => {
  assert.deepStrictEqual(
    threadCostLines({
      threadId,
      readAt: "2026-08-02T00:00:00.000Z",
      totalCostUsd: 0,
      thread: { ...emptyCostScope, threadCount: 1 },
      subagents: emptyCostScope,
      coverage: {
        complete: false,
        untrackedConversations: 0,
        conversationsWithoutUsage: 0,
        unreadableSources: 0,
        unpricedRecords: 0,
      },
      pricing: null,
    }),
    ["Unknown", "Note: This thread has not used a provider yet."],
  );
});

const knownThreadCost: ThreadCost = {
  threadId,
  readAt: "2026-08-02T00:00:00.000Z",
  totalCostUsd: 1,
  thread: { threadCount: 1, costUsd: 1, models: [] },
  subagents: emptyCostScope,
  coverage: {
    complete: true,
    untrackedConversations: 0,
    conversationsWithoutUsage: 0,
    unreadableSources: 0,
    unpricedRecords: 0,
  },
  pricing: null,
};

it.effect("cost asks the tool for that thread and prints plain lines", () => {
  const { tools, calls } = scriptedTools({ t3_thread_cost: [knownThreadCost] });
  return Effect.gen(function* () {
    yield* printThreadCost(threadId, false)(tools);
    assert.deepStrictEqual(calls, [{ tool: "t3_thread_cost", args: { threadId } }]);
    assert.deepStrictEqual(yield* TestConsole.logLines, [
      "$1.00",
      "This thread: $1.00",
      "0 sub-agents: $0.00",
    ]);
  }).pipe(Effect.provide(Layer.fresh(TestConsole.layer)));
});

it.effect("cost --json prints the whole estimate", () => {
  const { tools } = scriptedTools({ t3_thread_cost: [knownThreadCost] });
  return Effect.gen(function* () {
    yield* printThreadCost(threadId, true)(tools);
    const [line] = yield* TestConsole.logLines;
    assert.deepStrictEqual(JSON.parse(String(line)), knownThreadCost);
  }).pipe(Effect.provide(Layer.fresh(TestConsole.layer)));
});

it.effect("cost refuses an id that is not a thread id, before contacting a server", () =>
  Effect.gen(function* () {
    const exit = yield* Command.runWith(threadCommand, { version: "0.0.0" })(["cost", "   "]).pipe(
      Effect.exit,
    );
    assert.isTrue(exit._tag === "Failure");
    assert.isTrue(
      (yield* TestConsole.errorLines).some((line) => String(line).includes("is not a thread id")),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(TestConsole.layer, NodeServices.layer, NodeCrypto.layer, NetService.layer),
    ),
  ),
);

it.effect("cost reports that no server is running in that home", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-cost-" });
    const exit = yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "cost",
      "thread-1",
      "--base-dir",
      baseDir,
    ]).pipe(Effect.exit);
    assert.isTrue(exit._tag === "Failure");
    assert.isTrue(
      (yield* TestConsole.errorLines).some((line) =>
        String(line).includes("No running Par3 server"),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(TestConsole.layer, NodeServices.layer, NodeCrypto.layer, NetService.layer),
    ),
  ),
);

it("titles from a long first line without splitting an emoji", () => {
  const title = titleFromMessage(`${"a".repeat(78)}😀 and the rest of a long first line`);
  assert.strictEqual(title, `${"a".repeat(78)}…`);
});
