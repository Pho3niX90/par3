#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - Standalone eval tooling; the driver runs in task containers without the monorepo's Effect runtime.
/**
 * Compares arm A (Par3 solo) with arm B (Par3 Sidekick) from per-task results written by cost.ts
 * and prints a Markdown report.
 *
 *   node scripts/evals/sidekick/report.ts --a results/A --b results/B [--out results/report.md]
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { TaskResult } from "./cost.ts";

export interface ReferenceRow {
  readonly label: string;
  readonly score: number | null;
  readonly costPerTaskUsd: number | null;
  readonly metric: string;
  readonly note: string;
}

/**
 * Artificial Analysis rows. The first two are Coding Agent Index numbers, a different suite mix
 * from Terminal-Bench alone, so they are context, not a like-for-like baseline. Override with
 * --reference <file.json> (an array of ReferenceRow).
 */
export const DEFAULT_REFERENCE_ROWS: ReadonlyArray<ReferenceRow> = [
  {
    label: "Claude Code + Claude Opus 5.5",
    score: 66,
    costPerTaskUsd: 13.04,
    metric: "AA Coding Agent Index",
    note: "Not Terminal-Bench alone",
  },
  {
    label: "Devin Fusion",
    score: 68.1,
    costPerTaskUsd: 9.01,
    metric: "AA Coding Agent Index",
    note: "Not Terminal-Bench alone",
  },
  {
    label: "Claude Code + Claude Opus 5.5",
    score: null,
    costPerTaskUsd: null,
    metric: "AA Terminal-Bench 4.0",
    note: "TODO: fill in from AA's per-suite breakdown",
  },
  {
    label: "Devin Fusion",
    score: null,
    costPerTaskUsd: null,
    metric: "AA Terminal-Bench 4.0",
    note: "TODO: fill in from AA's per-suite breakdown",
  },
];

/** Deterministic PRNG so a report re-run with the same seed gives the same intervals. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Interval {
  readonly estimate: number;
  readonly low: number;
  readonly high: number;
}

export interface BootstrapOptions {
  readonly iterations?: number;
  readonly seed?: number;
  readonly confidence?: number;
}

function quantile(sorted: ReadonlyArray<number>, q: number): number {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const a = sorted[lower] as number;
  const b = sorted[upper] as number;
  return a + (b - a) * (position - lower);
}

/**
 * Percentile bootstrap over tasks. Resampling whole tasks keeps A and B paired, so the interval
 * reflects task difficulty being shared between arms.
 */
export function pairedBootstrap<T>(
  items: ReadonlyArray<T>,
  statistic: (sample: ReadonlyArray<T>) => number,
  options: BootstrapOptions = {},
): Interval {
  const iterations = options.iterations ?? 10_000;
  const confidence = options.confidence ?? 0.95;
  const random = mulberry32(options.seed ?? 1);
  const estimate = statistic(items);
  if (items.length === 0) return { estimate: Number.NaN, low: Number.NaN, high: Number.NaN };
  const values: number[] = [];
  const sample: T[] = Array.from({ length: items.length });
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < items.length; j++) {
      sample[j] = items[Math.floor(random() * items.length)] as T;
    }
    values.push(statistic(sample));
  }
  values.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return { estimate, low: quantile(values, alpha), high: quantile(values, 1 - alpha) };
}

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? Number.NaN : values.reduce((sum, v) => sum + v, 0) / values.length;

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return Number.NaN;
  return quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
}

/** One task in one arm; re-runs of a task are averaged so each task weighs the same. */
export interface TaskAggregate {
  readonly taskId: string;
  readonly attempts: number;
  readonly passRate: number | null;
  readonly costUsd: number | null;
  readonly wallMs: number;
  readonly results: ReadonlyArray<TaskResult>;
}

export function aggregateByTask(
  results: ReadonlyArray<TaskResult>,
): ReadonlyMap<string, TaskAggregate> {
  const byTask = new Map<string, TaskResult[]>();
  for (const result of results) {
    byTask.set(result.taskId, [...(byTask.get(result.taskId) ?? []), result]);
  }
  const aggregates = new Map<string, TaskAggregate>();
  for (const [taskId, attempts] of byTask) {
    const graded = attempts.filter((attempt) => attempt.passed !== null);
    const priced = attempts.map((attempt) => attempt.costUsd);
    aggregates.set(taskId, {
      taskId,
      attempts: attempts.length,
      passRate: graded.length === 0 ? null : mean(graded.map((a) => (a.passed === true ? 1 : 0))),
      costUsd: priced.some((cost) => cost === null) ? null : mean(priced as number[]),
      wallMs: mean(attempts.map((attempt) => attempt.wallMs)),
      results: attempts,
    });
  }
  return aggregates;
}

export interface TaskPair {
  readonly taskId: string;
  readonly a: TaskAggregate;
  readonly b: TaskAggregate;
}

export function pairTasks(
  a: ReadonlyMap<string, TaskAggregate>,
  b: ReadonlyMap<string, TaskAggregate>,
): { readonly pairs: ReadonlyArray<TaskPair>; readonly onlyA: string[]; readonly onlyB: string[] } {
  const pairs: TaskPair[] = [];
  for (const [taskId, aggregate] of a) {
    const other = b.get(taskId);
    if (other !== undefined) pairs.push({ taskId, a: aggregate, b: other });
  }
  pairs.sort((x, y) => x.taskId.localeCompare(y.taskId));
  return {
    pairs,
    onlyA: [...a.keys()].filter((taskId) => !b.has(taskId)),
    onlyB: [...b.keys()].filter((taskId) => !a.has(taskId)),
  };
}

/** Tasks the arms disagree on; the protocol re-runs these before scoring. */
export function disagreements(pairs: ReadonlyArray<TaskPair>): ReadonlyArray<string> {
  return pairs
    .filter((pair) => pair.a.passRate !== null && pair.b.passRate !== null)
    .filter((pair) => (pair.a.passRate as number) >= 0.5 !== (pair.b.passRate as number) >= 0.5)
    .map((pair) => pair.taskId);
}

export interface Comparison {
  readonly gradedPairs: number;
  readonly passA: Interval;
  readonly passB: Interval;
  readonly passDiff: Interval;
  readonly pricedPairs: number;
  /** (total B cost / total A cost) - 1 over tasks priced in both arms. Negative is cheaper. */
  readonly costChange: Interval | null;
}

export function compareArms(
  pairs: ReadonlyArray<TaskPair>,
  options: BootstrapOptions = {},
): Comparison {
  const graded = pairs.filter((pair) => pair.a.passRate !== null && pair.b.passRate !== null);
  const pass = (arm: "a" | "b") => (sample: ReadonlyArray<TaskPair>) =>
    mean(sample.map((pair) => pair[arm].passRate as number));
  const priced = pairs.filter((pair) => pair.a.costUsd !== null && pair.b.costUsd !== null);
  const costChange = (sample: ReadonlyArray<TaskPair>) => {
    const totalA = sample.reduce((sum, pair) => sum + (pair.a.costUsd as number), 0);
    const totalB = sample.reduce((sum, pair) => sum + (pair.b.costUsd as number), 0);
    return totalA === 0 ? Number.NaN : totalB / totalA - 1;
  };
  return {
    gradedPairs: graded.length,
    passA: pairedBootstrap(graded, pass("a"), options),
    passB: pairedBootstrap(graded, pass("b"), options),
    passDiff: pairedBootstrap(
      graded,
      (sample) =>
        mean(sample.map((pair) => (pair.b.passRate as number) - (pair.a.passRate as number))),
      options,
    ),
    pricedPairs: priced.length,
    costChange: priced.length === 0 ? null : pairedBootstrap(priced, costChange, options),
  };
}

const pct = (value: number, digits = 1) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "n/a";
const points = (value: number) =>
  Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pts` : "n/a";
const usd = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "n/a" : `$${value.toFixed(2)}`;
const minutes = (ms: number) => (Number.isFinite(ms) ? `${(ms / 60_000).toFixed(1)} min` : "n/a");

/**
 * Claim rule: "equal or better at X% lower cost" only when B - A is not significantly negative
 * (the interval's upper bound is not below zero) and B is cheaper.
 */
export function claimText(comparison: Comparison, provisional: boolean): string {
  const { passDiff, costChange } = comparison;
  if (comparison.gradedPairs === 0) return "No graded task pairs yet; no claim.";
  if (passDiff.high < 0) {
    return `Sidekick scores significantly lower (B - A ${points(passDiff.estimate)}, 95% CI ${points(passDiff.low)} to ${points(passDiff.high)}). No cost claim.`;
  }
  if (costChange === null || !(costChange.estimate < 0)) {
    return `B - A is not significantly negative (${points(passDiff.estimate)}, 95% CI ${points(passDiff.low)} to ${points(passDiff.high)}), but Sidekick is not cheaper. No cost claim.`;
  }
  const caveat =
    passDiff.low < 0
      ? ` The interval still allows a drop of up to ${points(passDiff.low).replace("-", "")}; "equal" means not significantly worse, not proven equal.`
      : "";
  const status = provisional ? "PROVISIONAL (unverified prices or incomplete usage): " : "";
  return `${status}Equal or better at ${pct(-costChange.estimate, 0)} lower cost per task (cost change 95% CI ${pct(costChange.low, 0)} to ${pct(costChange.high, 0)}; B - A ${points(passDiff.estimate)}, 95% CI ${points(passDiff.low)} to ${points(passDiff.high)}).${caveat}`;
}

interface ArmSummary {
  readonly label: string;
  readonly tasks: number;
  readonly attempts: number;
  readonly results: ReadonlyArray<TaskResult>;
  readonly aggregates: ReadonlyArray<TaskAggregate>;
}

function summarizeArm(label: string, map: ReadonlyMap<string, TaskAggregate>): ArmSummary {
  const aggregates = [...map.values()];
  return {
    label,
    tasks: aggregates.length,
    attempts: aggregates.reduce((sum, agg) => sum + agg.attempts, 0),
    results: aggregates.flatMap((agg) => agg.results),
    aggregates,
  };
}

const table = (header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>) =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

export interface ReportInput {
  readonly a: ReadonlyArray<TaskResult>;
  readonly b: ReadonlyArray<TaskResult>;
  readonly reference?: ReadonlyArray<ReferenceRow>;
  readonly bootstrap?: BootstrapOptions;
}

export function renderReport(input: ReportInput): string {
  const aggA = aggregateByTask(input.a);
  const aggB = aggregateByTask(input.b);
  const { pairs, onlyA, onlyB } = pairTasks(aggA, aggB);
  const comparison = compareArms(pairs, input.bootstrap);
  const arms = [summarizeArm("A: Par3 solo", aggA), summarizeArm("B: Par3 Sidekick", aggB)];
  const all = [...input.a, ...input.b];
  const provisional = all.some(
    (result) =>
      !result.pricesVerified ||
      result.costUsd === null ||
      result.incompleteUsageTurns > 0 ||
      !result.settled ||
      result.timedOut ||
      result.turns === 0 ||
      result.turnsWithNativeSubagents > 0 ||
      result.protectedFilesChanged.length > 0,
  );

  const armRows = arms.map((arm, index) => {
    const pass = index === 0 ? comparison.passA : comparison.passB;
    const costs = arm.aggregates.map((agg) => agg.costUsd).filter((c): c is number => c !== null);
    const sidekickShares = arm.results
      .map((result) => result.sidekickTokenShare)
      .filter((share): share is number => share !== null);
    const cacheRatios = arm.results
      .map((result) => result.cacheHitRatio)
      .filter((ratio): ratio is number => ratio !== null);
    return [
      arm.label,
      String(arm.tasks),
      String(arm.attempts),
      `${pct(pass.estimate)} (${pct(pass.low)} to ${pct(pass.high)})`,
      `${usd(mean(costs))} (median ${usd(median(costs))}, ${costs.length} priced)`,
      minutes(mean(arm.aggregates.map((agg) => agg.wallMs))),
      pct(mean(cacheRatios)),
      sidekickShares.length === 0 ? "n/a" : pct(mean(sidekickShares)),
    ];
  });

  const diagnosticRows = arms.map((arm) => {
    const perTask = (pick: (result: TaskResult) => number) =>
      mean(arm.results.map(pick)).toFixed(2);
    const count = (predicate: (result: TaskResult) => boolean) =>
      String(arm.results.filter(predicate).length);
    return [
      arm.label,
      perTask((r) => r.diagnostics.delegations),
      perTask((r) => r.diagnostics.freshDelegations),
      perTask((r) => r.diagnostics.continuations),
      count((r) => r.diagnostics.blockedReports > 0),
      count((r) => r.diagnostics.failedDelegations > 0),
      count((r) => r.diagnostics.leadTakeovers > 0),
      count((r) => !r.settled || r.timedOut),
      count((r) => r.incompleteUsageTurns > 0),
      count((r) => r.turnsWithNativeSubagents > 0),
    ];
  });

  const flagged = all.filter((result) => result.protectedFilesChanged.length > 0);
  const references = input.reference ?? DEFAULT_REFERENCE_ROWS;
  const disagreeing = disagreements(pairs);
  const modelLines = [
    ...new Set(
      all.flatMap((result) =>
        result.byModel.map(
          (row) =>
            `${result.arm}: ${row.instanceId}/${row.model} [${row.optionSets.join("; ")}] as ${row.roles.join("+")}`,
        ),
      ),
    ),
  ].sort();

  return [
    "# Sidekick vs solo on Terminal-Bench",
    "",
    `Paired tasks: ${pairs.length} (${comparison.gradedPairs} graded in both arms, ${comparison.pricedPairs} priced in both).` +
      (onlyA.length + onlyB.length > 0
        ? ` Unpaired: ${onlyA.length} only in A, ${onlyB.length} only in B (excluded from intervals).`
        : ""),
    "",
    "## Arms",
    "",
    table(
      [
        "Arm",
        "Tasks",
        "Attempts",
        "Pass rate (95% CI)",
        "Cost/task",
        "Time/task",
        "Cache hit",
        "Sidekick token share",
      ],
      armRows,
    ),
    "",
    "Pass rate and cost per task average re-runs within a task first. Intervals are paired percentile bootstraps over tasks.",
    "",
    "## B - A",
    "",
    table(
      ["Measure", "Estimate", "95% CI"],
      [
        [
          "Pass rate",
          points(comparison.passDiff.estimate),
          `${points(comparison.passDiff.low)} to ${points(comparison.passDiff.high)}`,
        ],
        comparison.costChange === null
          ? ["Cost per task", "n/a", "n/a"]
          : [
              "Cost per task",
              pct(comparison.costChange.estimate),
              `${pct(comparison.costChange.low)} to ${pct(comparison.costChange.high)}`,
            ],
      ],
    ),
    "",
    `**Claim:** ${claimText(comparison, provisional)}`,
    "",
    "## Reference rows (Artificial Analysis)",
    "",
    table(
      ["System", "Metric", "Score", "Cost/task", "Note"],
      references.map((row) => [
        row.label,
        row.metric,
        row.score === null ? "TODO" : String(row.score),
        usd(row.costPerTaskUsd),
        row.note,
      ]),
    ),
    "",
    "These runs report a Terminal-Bench pass rate only; they do not produce a Coding Agent Index number.",
    "",
    "## Diagnostics",
    "",
    table(
      [
        "Arm",
        "Delegations/task",
        "Fresh/task",
        "Follow-ups/task",
        "Tasks with blocked report",
        "Tasks with failed delegation",
        "Tasks with lead takeover",
        "Unsettled/timed out",
        "Incomplete usage",
        "Native subagents (unpriced)",
      ],
      diagnosticRows,
    ),
    "",
    "## Effective models",
    "",
    ...modelLines.map((line) => `- ${line}`),
    "",
    "## Flags",
    "",
    flagged.length === 0
      ? "- No test or verifier files changed during any attempt."
      : flagged
          .map(
            (r) =>
              `- ${r.arm} ${r.taskId}: changed ${r.protectedFilesChanged.join(", ")} (review for reward hacking)`,
          )
          .join("\n"),
    disagreeing.length === 0
      ? "- No tasks where A and B disagree."
      : `- A and B disagree on ${disagreeing.length} task(s); re-run before scoring: ${disagreeing.join(", ")}`,
    provisional
      ? "- Results are provisional: verify prices, complete usage and settlement, and review any native subagents or changed verifier files."
      : "- All prices verified and all turn usage complete.",
    "",
  ].join("\n");
}

export function readResultsDir(dir: string): ReadonlyArray<TaskResult> {
  if (!NodeFS.existsSync(dir)) throw new Error(`results dir not found: ${dir}`);
  return NodeFS.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(NodeFS.readFileSync(NodePath.join(dir, name), "utf8")) as TaskResult);
}

function main(): void {
  const { values } = NodeUtil.parseArgs({
    options: {
      a: { type: "string" },
      b: { type: "string" },
      out: { type: "string" },
      reference: { type: "string" },
      seed: { type: "string", default: "1" },
      iterations: { type: "string", default: "10000" },
    },
  });
  if (values.a === undefined || values.b === undefined) {
    throw new Error("usage: report.ts --a <results/A> --b <results/B> [--out report.md]");
  }
  const markdown = renderReport({
    a: readResultsDir(values.a),
    b: readResultsDir(values.b),
    ...(values.reference === undefined
      ? {}
      : { reference: JSON.parse(NodeFS.readFileSync(values.reference, "utf8")) as ReferenceRow[] }),
    bootstrap: { seed: Number(values.seed), iterations: Number(values.iterations) },
  });
  if (values.out === undefined) {
    process.stdout.write(markdown);
  } else {
    NodeFS.writeFileSync(values.out, markdown);
    console.log(`wrote ${values.out}`);
  }
}

if (import.meta.main) {
  main();
}
