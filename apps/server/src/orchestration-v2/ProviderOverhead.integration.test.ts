/**
 * Counts what the server does for one Claude turn of each benchmark workload
 * shape, replayed through the real orchestrator, SQLite file, and git
 * checkpoints. The counts are deterministic, so they gate regressions in CI
 * without secrets; wall time only fails far above its committed budget.
 * `T3CODE_BENCH_TIMED=1` adds a non-gating report with realistic frame gaps.
 * See issue #31 and `apps/server/scripts/bench-provider-overhead.ts` for the
 * live comparison against the `claude` CLI.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

import { makeSqlStatementCounter } from "../../integration/SqlStatementCounter.integration.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ClaudeOrchestratorReplayHarness } from "./Adapters/ClaudeAdapterV2.testkit.ts";
import { CLAUDE_MODEL_SELECTION, materializeFixtureInput } from "./testkit/fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./testkit/ProviderReplayHarness.ts";
import {
  makeSyntheticClaudeTranscript,
  type SyntheticClaudeShape,
} from "./testkit/syntheticClaudeTranscript.ts";

const EVENT_SINK_SPAN_PREFIX = "orchestrationV2.EventSink.";
const CHECKPOINT_CAPTURE_SPAN = "orchestrationV2.checkpointCapture.execute";
const TIMED = process.env.T3CODE_BENCH_TIMED === "1";
// Gap between replayed frames in timed mode, roughly a fast model's pace.
const TIMED_FRAME_GAP_MS = 20;

interface Budget {
  readonly name: string;
  readonly turns: ReadonlyArray<SyntheticClaudeShape>;
  /** EventSink transactions for the whole thread, at most. */
  readonly maxTransactions: number;
  /** SQLite statements outside EventSink writes, per turn, at most. */
  readonly maxSqlStatementsPerTurn: number;
  /** Wall time of the whole replay; the test fails only above three times this. */
  readonly wallBudgetMs: number;
}

// Measured on the replay harness (2026-10); lower them when the server gets
// cheaper. Streaming deltas are buffered per turn here, so W4's 208 frames
// commit in a handful of transactions.
// EventSink writes run with tracing off, so statements inside them are not in
// the SQL count; the transaction count covers them.
const BUDGETS: ReadonlyArray<Budget> = [
  {
    name: "W1 text reply, cold and warm",
    turns: [{ kind: "text" }, { kind: "text" }],
    maxTransactions: 25,
    maxSqlStatementsPerTurn: 163,
    wallBudgetMs: 2500,
  },
  {
    name: "W2 eight sequential tool calls",
    turns: [{ kind: "sequential_tools", toolCalls: 8 }],
    maxTransactions: 54,
    maxSqlStatementsPerTurn: 168,
    wallBudgetMs: 1600,
  },
  {
    name: "W3 edit then test",
    turns: [{ kind: "sequential_tools", toolCalls: 2 }],
    maxTransactions: 24,
    maxSqlStatementsPerTurn: 168,
    wallBudgetMs: 1600,
  },
  {
    name: "W4 long streamed answer",
    turns: [{ kind: "streamed_text", deltas: 200 }],
    maxTransactions: 15,
    maxSqlStatementsPerTurn: 168,
    wallBudgetMs: 1600,
  },
  {
    name: "W5 eight parallel reads",
    turns: [{ kind: "parallel_tools", toolCalls: 8 }],
    maxTransactions: 54,
    maxSqlStatementsPerTurn: 168,
    wallBudgetMs: 1600,
  },
];

interface Measurement {
  /** SQLite statements run by turn work; see `isTurnWork`. */
  sqlStatements: number;
  transactions: number;
  checkpointCaptures: number;
  /** Durations of EventSink transactions, and of checkpoint captures, in ms. */
  commitDurationsMs: number[];
  captureDurationsMs: number[];
}

// Spans that do a turn's work. Statements outside them are migrations, layer
// set-up, and the harness polling for idle, whose count depends on timing.
const TURN_WORK_SPAN_PREFIXES = [
  "orchestrationV2.",
  "RunFinalizationService.",
  "ProviderEventIngestor.",
  "ClaudeAdapterV2.",
];
const isTurnWork = (name: string) =>
  !name.endsWith(".layer") && TURN_WORK_SPAN_PREFIXES.some((prefix) => name.startsWith(prefix));

/**
 * Counts SQLite statements (with `makeSqlStatementCounter`'s rule) under turn
 * work, EventSink transactions, and checkpoint captures.
 */
function makeOverheadTracer(): { readonly tracer: Tracer.Tracer; readonly measured: Measurement } {
  const sql = makeSqlStatementCounter();
  const measured: Measurement = {
    sqlStatements: 0,
    transactions: 0,
    checkpointCaptures: 0,
    commitDurationsMs: [],
    captureDurationsMs: [],
  };
  const turnWorkSpans = new Set<string>();
  const tracer = Tracer.make({
    span: (options) => {
      const before = sql.count();
      const span = sql.tracer.span(options);
      const parent = options.parent._tag === "Some" ? options.parent.value : undefined;
      const insideTurnWork = parent !== undefined && turnWorkSpans.has(parent.spanId);
      if (insideTurnWork || isTurnWork(options.name)) turnWorkSpans.add(span.spanId);
      if (insideTurnWork) measured.sqlStatements += sql.count() - before;
      const isCommit = options.name.startsWith(EVENT_SINK_SPAN_PREFIX);
      const isCapture = options.name === CHECKPOINT_CAPTURE_SPAN;
      if (!isCommit && !isCapture) return span;
      if (isCommit) measured.transactions += 1;
      if (isCapture) measured.checkpointCaptures += 1;
      const startedAt = performance.now();
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const endedAt = performance.now();
        if (isCommit) {
          measured.commitDurationsMs.push(endedAt - startedAt);
        } else {
          measured.captureDurationsMs.push(endedAt - startedAt);
        }
      };
      return span;
    },
  });
  return { tracer, measured };
}

function p95(values: ReadonlyArray<number>): number {
  if (values.length === 0) return Number.NaN;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
}

const runBudget = Effect.fn("ProviderOverhead.runBudget")(function* (budget: Budget) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scenario = `provider_overhead_${budget.name.split(" ")[0]!.toLowerCase()}`;
  const prompts = budget.turns.map((_, index) => `Benchmark turn ${index + 1}`);
  const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
    makeSyntheticClaudeTranscript({
      scenario,
      turns: budget.turns.map((shape, index) => ({
        prompt: prompts[index]!,
        shape,
        finalText: `benchmark turn ${index + 1} complete`,
      })),
      ...(TIMED ? { afterMs: TIMED_FRAME_GAP_MS } : {}),
    }),
  );
  const inboundEvents = transcript.entries.filter((entry) => entry.type === "emit_inbound").length;
  const workspace = yield* checkpointWorkspace(scenario);
  const tempDir = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "t3-provider-overhead-" }),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  const materialized = yield* materializeFixtureInput({
    scenario,
    fixtureInput: { steps: prompts.map((text) => ({ type: "message" as const, text })) },
    driver: ProviderDriverKind.make("claudeAgent"),
    modelSelection: CLAUDE_MODEL_SELECTION,
  }).pipe(Effect.provide(IdAllocator.layer));
  const { tracer, measured } = makeOverheadTracer();
  const startedAt = performance.now();
  yield* runOrchestratorV2ProviderReplayScenario(
    {
      name: scenario,
      transcript,
      commands: materialized.commands,
      steps: materialized.steps,
      projectionThreadIds: materialized.projectionThreadIds,
      runtimePolicyOverride: { cwd: workspace },
    },
    ClaudeOrchestratorReplayHarness,
    {
      databaseLayer: SqlitePersistence.layerFromPath(path.join(tempDir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    },
  ).pipe(Effect.withTracer(tracer));
  const wallMs = performance.now() - startedAt;
  return { inboundEvents, measured, wallMs, turns: budget.turns.length };
});

describe("provider overhead per Claude turn", () => {
  it.effect.each(BUDGETS)("$name", (budget) =>
    Effect.gen(function* () {
      const { inboundEvents, measured, wallMs, turns } = yield* runBudget(budget);
      const counts = {
        inboundEvents,
        transactionsPerInboundEvent: Number((measured.transactions / inboundEvents).toFixed(2)),
        transactions: measured.transactions,
        sqlStatements: measured.sqlStatements,
        checkpointCaptures: measured.checkpointCaptures,
        wallMs: Math.round(wallMs),
      };
      const report = JSON.stringify(counts);
      // One capture as each turn finishes; the first also writes the
      // thread-start baseline inside the same call.
      assert.strictEqual(measured.checkpointCaptures, turns, report);
      assert.isAtMost(measured.transactions, budget.maxTransactions, `transactions: ${report}`);
      assert.isAtMost(
        measured.sqlStatements / turns,
        budget.maxSqlStatementsPerTurn,
        `SQL statements per turn: ${report}`,
      );
      if (TIMED) {
        // Non-gating: compare against the issue's targets (50 ms turn overhead,
        // 5 ms commit). Emit-to-wire needs a socket; the live B arm's first
        // text against A1's covers it. Turn overhead here still includes the
        // harness's own set-up and idle polling, so read it as an upper bound.
        const scriptedMs = inboundEvents * TIMED_FRAME_GAP_MS;
        // The first capture also writes the thread-start baseline checkpoint.
        const baselineCaptureMs = measured.captureDurationsMs[0] ?? 0;
        // Written straight to stdout: the test runner hides logs from passing tests.
        const timed = {
          budget: budget.name,
          turnOverheadMs: Math.round((wallMs - scriptedMs - baselineCaptureMs) / turns),
          commitP95Ms: Number(p95(measured.commitDurationsMs).toFixed(2)),
        };
        process.stdout.write(`provider overhead (timed replay): ${JSON.stringify(timed)}\n`);
      } else {
        assert.isAtMost(wallMs, budget.wallBudgetMs * 3, `wall time: ${report}`);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
