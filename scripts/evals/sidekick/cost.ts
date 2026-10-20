#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - Standalone eval tooling; the driver runs in task containers without the monorepo's Effect runtime.
/**
 * Prices one task's Par3 usage export at public API rates and writes the per-task result that
 * report.ts reads. Cost is API-equivalent: the runs themselves use subscriptions.
 *
 *   node scripts/evals/sidekick/cost.ts --export <par3-export.json> --out <task.json> [--reward 1]
 *   node scripts/evals/sidekick/cost.ts --job-dir <harbor job dir> --out-dir <results/B>
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import {
  delegationDiagnostics,
  extractTurnUsage,
  type DelegationDiagnostics,
  type Par3TaskExport,
  type TurnUsageRecord,
  type UsageRole,
} from "./usage.ts";

export interface ModelPrice {
  readonly input: number;
  readonly cachedInput: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number | null;
  readonly verify?: boolean;
}

export interface PriceTable {
  readonly models: Readonly<Record<string, ModelPrice>>;
}

export interface TokenTotals {
  readonly uncachedInputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export const ZERO_TOTALS: TokenTotals = {
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export const totalTokens = (t: TokenTotals) =>
  t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens;

/** Share of prompt tokens served from cache. */
export function cacheHitRatio(t: TokenTotals): number | null {
  const prompt = t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return prompt === 0 ? null : t.cacheReadTokens / prompt;
}

/**
 * Drops the `[1m]`-style variant suffix Claude Code appends for the long-context tier, as the
 * server's usage pricing does (apps/server/src/usage/usagePricing.ts).
 */
export function priceKey(model: string): string {
  const key = model.trim().toLowerCase();
  const bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
}

export interface CostBreakdown {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly total: number;
}

export function priceTotals(t: TokenTotals, price: ModelPrice): CostBreakdown {
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  const input = t.uncachedInputTokens * perToken(price.input);
  const cacheRead = t.cacheReadTokens * perToken(price.cachedInput);
  const cacheWrite = t.cacheWriteTokens * perToken(price.cacheWrite);
  // outputTokens already includes reasoning; only re-rate the reasoning part if it is priced apart.
  const reasoning = Math.min(t.reasoningTokens, t.outputTokens);
  const output =
    price.reasoning === null
      ? t.outputTokens * perToken(price.output)
      : (t.outputTokens - reasoning) * perToken(price.output) +
        reasoning * perToken(price.reasoning);
  return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output };
}

const recordTotals = (r: TurnUsageRecord): TokenTotals => ({
  uncachedInputTokens: r.uncachedInputTokens,
  cacheReadTokens: r.cacheReadTokens,
  cacheWriteTokens: r.cacheWriteTokens,
  outputTokens: r.outputTokens,
  reasoningTokens: r.reasoningTokens,
});

export interface ModelRollup {
  readonly instanceId: string;
  readonly model: string;
  readonly roles: ReadonlyArray<UsageRole>;
  /** Distinct option sets seen on this model's turns, e.g. effort=max. */
  readonly optionSets: ReadonlyArray<string>;
  readonly turns: number;
  readonly incompleteTurns: number;
  readonly tokens: TokenTotals;
  readonly cost: CostBreakdown | null;
  readonly priceVerified: boolean;
}

const describeOptions = (options: TurnUsageRecord["options"]) =>
  options.length === 0
    ? "(defaults)"
    : options.map((option) => `${option.id}=${String(option.value)}`).join(",");

export function rollupByModel(
  records: ReadonlyArray<TurnUsageRecord>,
  prices: PriceTable,
): ReadonlyArray<ModelRollup> {
  const groups = new Map<string, TurnUsageRecord[]>();
  for (const record of records) {
    const key = `${record.instanceId}\u0000${record.model}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as TurnUsageRecord;
    const tokens = group.map(recordTotals).reduce(addTotals, ZERO_TOTALS);
    const price = prices.models[priceKey(first.model)];
    return {
      instanceId: first.instanceId,
      model: first.model,
      roles: [...new Set(group.map((record) => record.role))],
      optionSets: [...new Set(group.map((record) => describeOptions(record.options)))],
      turns: group.length,
      incompleteTurns: group.filter((record) => record.usageStatus !== "complete").length,
      tokens,
      cost: price === undefined ? null : priceTotals(tokens, price),
      priceVerified: price !== undefined && price.verify !== true,
    };
  });
}

export interface TaskResult {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly arm: string;
  readonly reward: number | null;
  readonly passed: boolean | null;
  readonly wallMs: number;
  readonly settled: boolean;
  readonly timedOut: boolean;
  /** Null when any model with usage has no price. */
  readonly costUsd: number | null;
  readonly pricesVerified: boolean;
  readonly unpricedModels: ReadonlyArray<string>;
  readonly byModel: ReadonlyArray<ModelRollup>;
  readonly tokensByRole: Readonly<Record<UsageRole, number>>;
  readonly costByRole: Readonly<Record<UsageRole, number | null>>;
  readonly leadTokenShare: number | null;
  readonly sidekickTokenShare: number | null;
  readonly sidekickCostShare: number | null;
  readonly cacheHitRatio: number | null;
  readonly turns: number;
  readonly incompleteUsageTurns: number;
  readonly turnsWithNativeSubagents: number;
  readonly diagnostics: DelegationDiagnostics;
  readonly protectedFilesChanged: ReadonlyArray<string>;
}

const ROLES: ReadonlyArray<UsageRole> = ["lead", "sidekick", "child"];

export function summarizeTask(
  taskExport: Par3TaskExport,
  prices: PriceTable,
  reward: number | null,
): TaskResult {
  const records = extractTurnUsage(taskExport);
  const byModel = rollupByModel(records, prices);
  const used = byModel.filter((row) => totalTokens(row.tokens) > 0);
  const unpricedModels = used.filter((row) => row.cost === null).map((row) => row.model);
  const costUsd =
    unpricedModels.length > 0 ? null : used.reduce((sum, row) => sum + (row.cost?.total ?? 0), 0);

  const roleTokens = {} as Record<UsageRole, number>;
  const roleCost = {} as Record<UsageRole, number | null>;
  for (const role of ROLES) {
    const roleRecords = records.filter((record) => record.role === role);
    roleTokens[role] = roleRecords.reduce((sum, r) => sum + totalTokens(recordTotals(r)), 0);
    const rows = rollupByModel(roleRecords, prices).filter((row) => totalTokens(row.tokens) > 0);
    roleCost[role] = rows.some((row) => row.cost === null)
      ? null
      : rows.reduce((sum, row) => sum + (row.cost?.total ?? 0), 0);
  }
  const allTokens = ROLES.reduce((sum, role) => sum + roleTokens[role], 0);
  const share = (value: number) => (allTokens === 0 ? null : value / allTokens);
  const sidekickCost = roleCost.sidekick;

  return {
    schemaVersion: 1,
    taskId: taskExport.taskId,
    arm: taskExport.arm,
    reward,
    passed: reward === null ? null : reward >= 1,
    wallMs: Date.parse(taskExport.finishedAt) - Date.parse(taskExport.startedAt),
    settled: taskExport.settled,
    timedOut: taskExport.timedOut,
    costUsd,
    pricesVerified: used.every((row) => row.priceVerified),
    unpricedModels,
    byModel,
    tokensByRole: roleTokens,
    costByRole: roleCost,
    leadTokenShare: share(roleTokens.lead),
    sidekickTokenShare: share(roleTokens.sidekick),
    sidekickCostShare:
      costUsd === null || costUsd === 0 || sidekickCost === null ? null : sidekickCost / costUsd,
    cacheHitRatio: cacheHitRatio(records.map(recordTotals).reduce(addTotals, ZERO_TOTALS)),
    turns: records.length,
    incompleteUsageTurns: records.filter((record) => record.usageStatus !== "complete").length,
    turnsWithNativeSubagents: records.filter((record) => record.hasNativeSubagents).length,
    diagnostics: delegationDiagnostics(taskExport),
    protectedFilesChanged: taskExport.protectedFilesChanged,
  };
}

/**
 * ASSUMPTION (verify against a real Harbor job): each trial directory holds `result.json` with
 * `verifier_result.rewards.reward`, and the agent's logs dir is `<trial>/agent`.
 */
export function readHarborReward(trialDir: string): number | null {
  const path = NodePath.join(trialDir, "result.json");
  if (!NodeFS.existsSync(path)) return null;
  const result = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
    verifier_result?: { rewards?: { reward?: unknown } | null } | null;
  };
  const reward = result.verifier_result?.rewards?.reward;
  return typeof reward === "number" ? reward : null;
}

const EXPORT_IN_TRIAL = NodePath.join("agent", "par3", "par3-export.json");

function main(): void {
  const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  const { values } = NodeUtil.parseArgs({
    options: {
      export: { type: "string" },
      out: { type: "string" },
      reward: { type: "string" },
      "trial-dir": { type: "string" },
      "job-dir": { type: "string" },
      "out-dir": { type: "string" },
      prices: { type: "string", default: NodePath.join(here, "prices.json") },
    },
  });
  const prices = JSON.parse(NodeFS.readFileSync(values.prices, "utf8")) as PriceTable;
  const write = (path: string, result: TaskResult) => {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
    const cost = result.costUsd === null ? "unpriced" : `$${result.costUsd.toFixed(4)}`;
    console.log(`${result.arm} ${result.taskId}: reward=${result.reward} cost=${cost} -> ${path}`);
  };
  const readExport = (path: string) =>
    JSON.parse(NodeFS.readFileSync(path, "utf8")) as Par3TaskExport;

  if (values["job-dir"] !== undefined) {
    const jobDir = values["job-dir"];
    const outDir = values["out-dir"];
    if (outDir === undefined) throw new Error("--job-dir needs --out-dir");
    for (const entry of NodeFS.readdirSync(jobDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const trialDir = NodePath.join(jobDir, entry.name);
      const exportPath = NodePath.join(trialDir, EXPORT_IN_TRIAL);
      if (!NodeFS.existsSync(exportPath)) {
        console.warn(`skip ${entry.name}: no ${EXPORT_IN_TRIAL}`);
        continue;
      }
      const result = summarizeTask(readExport(exportPath), prices, readHarborReward(trialDir));
      // Trial dir names keep re-runs of one task apart.
      write(NodePath.join(outDir, `${NodePath.basename(trialDir)}.json`), result);
    }
    return;
  }

  if (values.export === undefined || values.out === undefined) {
    throw new Error("usage: cost.ts --export <file> --out <file> [--reward n | --trial-dir dir]");
  }
  const reward =
    values.reward !== undefined
      ? Number(values.reward)
      : values["trial-dir"] !== undefined
        ? readHarborReward(values["trial-dir"])
        : null;
  write(values.out, summarizeTask(readExport(values.export), prices, reward));
}

if (import.meta.main) {
  main();
}
