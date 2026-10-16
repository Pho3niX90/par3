/**
 * Turns benchmark samples into `summary.md`. Wall time leads because that is
 * what users feel; verdicts use non-API time because live wall time carries
 * model variance that can hide or invent a gap.
 */
import {
  bootstrapMedianDifferenceCi,
  formatDelta,
  formatMs,
  formatSeconds,
  median,
  overheadVerdict,
  percentile,
} from "./benchStats.ts";
import type { ArmId, BenchConfig, TurnSample } from "./benchTypes.ts";
import { WORKLOADS } from "./benchWorkloads.ts";
import { STARTUP_SPANS } from "./serverArm.ts";

interface Group {
  readonly key: string;
  readonly title: string;
  readonly byArm: ReadonlyMap<ArmId, ReadonlyArray<TurnSample>>;
}

const ARM_LABELS: Record<ArmId, string> = {
  A0: "Claude (A0)",
  A1: "Claude + Par3 config (A1)",
  B: "Par3 server (B)",
  T: "Claude terminal (T)",
  C: "Par3 app (C)",
};

function groupSamples(samples: ReadonlyArray<TurnSample>): Group[] {
  const groups = new Map<string, { title: string; byArm: Map<ArmId, TurnSample[]> }>();
  for (const sample of samples) {
    if (sample.error !== undefined || !Number.isFinite(sample.wallMs)) continue;
    const workload = WORKLOADS.find((candidate) => candidate.id === sample.workload);
    const hasWarm = workload?.warmPrompt !== undefined;
    const key = `${sample.workload}|${sample.variant}|${sample.turn}`;
    const title = [
      workload?.title ?? sample.workload,
      hasWarm ? sample.turn : "",
      sample.variant === "" ? "" : `[${sample.variant}]`,
    ]
      .filter(Boolean)
      .join(" ");
    const group = groups.get(key) ?? { title, byArm: new Map() };
    group.byArm.set(sample.arm, [...(group.byArm.get(sample.arm) ?? []), sample]);
    groups.set(key, group);
  }
  return Array.from(groups, ([key, group]) => ({ key, ...group }));
}

const values = (
  samples: ReadonlyArray<TurnSample> | undefined,
  pick: (s: TurnSample) => number | undefined,
) =>
  (samples ?? []).flatMap((sample) => {
    const value = pick(sample);
    return value === undefined || !Number.isFinite(value) ? [] : [value];
  });
const wall = (samples: ReadonlyArray<TurnSample> | undefined) => values(samples, (s) => s.wallMs);
const nonApi = (samples: ReadonlyArray<TurnSample> | undefined) =>
  values(samples, (s) => s.nonApiMs);

function cell(samples: ReadonlyArray<TurnSample> | undefined): string {
  const walls = wall(samples);
  if (walls.length === 0) return "–";
  return `${formatSeconds(median(walls))} (p95 ${formatSeconds(percentile(walls, 95))})`;
}

function medianDelta(
  candidate: ReadonlyArray<TurnSample> | undefined,
  reference: ReadonlyArray<TurnSample> | undefined,
): number {
  return median(wall(candidate)) - median(wall(reference));
}

function verdictText(verdict: ReturnType<typeof overheadVerdict> | undefined): string {
  if (verdict === undefined || !Number.isFinite(verdict.gapMs)) return "n/a";
  return `${verdict.pass ? "pass" : "FAIL"} (non-API gap ${formatMs(verdict.gapMs)} ≤ ${formatMs(verdict.allowanceMs)}?)`;
}

/** Plumbing verdict: B against A1, falling back to A0 when A1 was not run. */
function plumbingVerdict(group: Group) {
  const reference = group.byArm.get("A1") ?? group.byArm.get("A0");
  const candidate = group.byArm.get("B");
  if (reference === undefined || candidate === undefined) return undefined;
  return overheadVerdict({
    candidateNonApiMs: nonApi(candidate),
    referenceNonApiMs: nonApi(reference),
    referenceWallMs: wall(reference),
    floorMs: 300,
  });
}

function interfaceVerdict(group: Group) {
  const reference = group.byArm.get("T");
  const candidate = group.byArm.get("C");
  if (reference === undefined || candidate === undefined) return undefined;
  return overheadVerdict({
    candidateNonApiMs: nonApi(candidate),
    referenceNonApiMs: nonApi(reference),
    referenceWallMs: wall(reference),
    floorMs: 500,
  });
}

export function renderSummary(input: {
  readonly config: BenchConfig;
  readonly samples: ReadonlyArray<TurnSample>;
  readonly meta: Record<string, string>;
}): string {
  const groups = groupSamples(input.samples);
  const interfaceRun = groups.some((group) => group.byArm.has("T") && group.byArm.has("C"));
  const [referenceArm, candidateArm]: [ArmId, ArmId] = interfaceRun ? ["T", "C"] : ["A0", "B"];
  const lines: string[] = [];
  const footnotes: string[] = [];

  lines.push("# Provider overhead benchmark", "");
  lines.push(
    `Model \`${input.config.model}\`${input.config.effort ? `, effort \`${input.config.effort}\`` : ""}, runtime mode \`${input.config.runtimeMode}\`, streaming \`${input.config.streaming}\`, Claude ${input.config.claudeVersion}${input.config.stub ? " (stub replay)" : ""}.`,
    "",
  );
  if (!interfaceRun) {
    lines.push(
      "_The terminal (T) and app (C) arms were not run, so this table compares raw Claude (A0) with the Par3 server (B)._",
      "",
    );
  }

  const label = (arm: ArmId) =>
    arm === "A1" && input.config.a1WithoutMcp
      ? "Claude + Par3 config, no MCP (A1-noMCP)"
      : ARM_LABELS[arm];
  lines.push(
    `| Task | ${label(referenceArm)} | ${label(candidateArm)} | Par3 vs Claude | Verdict |`,
    "|---|---|---|---|---|",
  );
  const relativeDeltas: number[] = [];
  for (const group of groups) {
    const reference = group.byArm.get(referenceArm);
    const candidate = group.byArm.get(candidateArm);
    if (reference === undefined && candidate === undefined) continue;
    const delta = medianDelta(candidate, reference);
    const referenceMedian = median(wall(reference));
    if (Number.isFinite(delta) && referenceMedian > 0) relativeDeltas.push(delta / referenceMedian);
    const verdict = interfaceRun ? interfaceVerdict(group) : plumbingVerdict(group);
    const ci = bootstrapMedianDifferenceCi(wall(candidate), wall(reference));
    footnotes.push(
      `${group.title}: 95% CI of the median difference ${formatDelta(ci.low, referenceMedian)} to ${formatDelta(ci.high, referenceMedian)}.`,
    );
    lines.push(
      `| ${group.title} | ${cell(reference)} | ${cell(candidate)} | ${formatDelta(delta, referenceMedian)} | ${verdictText(verdict)} |`,
    );
  }
  lines.push("");
  if (relativeDeltas.length > 0) {
    const overall = median(relativeDeltas) * 100;
    lines.push(
      `**Across ${relativeDeltas.length} tasks, Par3 took ${Math.abs(overall).toFixed(1)}% ${overall >= 0 ? "longer" : "less time"} than raw Claude (median).**`,
      "",
    );
  }
  lines.push(
    "Each cell is the median wall time from prompt sent to task finished, with its p95. The verdict passes when Par3's median non-API time is within max(300 ms, 5% of the reference wall time) of the reference (500 ms for the app vs terminal row).",
    "",
  );

  lines.push("## Headless runs", "");
  lines.push(
    `| Task | ${label("A0")} | ${label("A1")} | ${label("B")} | Configuration (A1−A0) | Plumbing (B−A1) | UI (C−B vs T−A0) |`,
    "|---|---|---|---|---|---|---|",
  );
  for (const group of groups) {
    const a0 = group.byArm.get("A0");
    const a1 = group.byArm.get("A1");
    const b = group.byArm.get("B");
    const ui = `${formatMs(medianDelta(group.byArm.get("C"), b))} vs ${formatMs(medianDelta(group.byArm.get("T"), a0))}`;
    lines.push(
      `| ${group.title} | ${cell(a0)} | ${cell(a1)} | ${cell(b)} | ${formatMs(medianDelta(a1, a0))} | ${formatMs(medianDelta(b, a1))} | ${ui} |`,
    );
  }
  lines.push("");

  lines.push("## Where the time goes", "");
  lines.push(
    "Medians per arm. Non-API time is wall minus the CLI's `duration_api_ms`. Claude streams text block by block by design, so time to first text moves in whole blocks.",
    "",
    "| Task | Arm | n | Wall | API | Non-API | First text | First tool | Tools | Input tokens | Approval wait |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const group of groups) {
    for (const [arm, samples] of group.byArm) {
      lines.push(
        `| ${group.title} | ${arm} | ${samples.length} | ${formatMs(median(wall(samples)))} | ${formatMs(median(values(samples, (s) => s.apiMs)))} | ${formatMs(median(nonApi(samples)))} | ${formatMs(median(values(samples, (s) => s.firstTextMs)))} | ${formatMs(median(values(samples, (s) => s.firstToolMs)))} | ${median(values(samples, (s) => s.toolCount))} | ${Math.round(median(values(samples, (s) => s.inputTokens)))} | ${formatMs(median(values(samples, (s) => s.approvalMs)))} |`,
      );
    }
  }
  lines.push("");

  const serverGroups = groups.filter((group) => group.byArm.has("B"));
  if (serverGroups.length > 0) {
    lines.push("## Par3 server start-up spans (B)", "");
    lines.push(
      `| Task | ${STARTUP_SPANS.map((name) => `\`${name.replace("orchestrationV2.", "")}\``).join(" | ")} | Completion lag |`,
      `|---|${STARTUP_SPANS.map(() => "---").join("|")}|---|`,
    );
    for (const group of serverGroups) {
      const samples = group.byArm.get("B")!;
      const spanCells = STARTUP_SPANS.map((name) =>
        formatMs(median(values(samples, (s) => s.spans?.[name]))),
      );
      lines.push(
        `| ${group.title} | ${spanCells.join(" | ")} | ${formatMs(median(values(samples, (s) => s.completionLagMs)))} |`,
      );
    }
    lines.push("");
    lines.push("## Plumbing verdicts (B vs A1)", "");
    for (const group of serverGroups)
      lines.push(`- ${group.title}: ${verdictText(plumbingVerdict(group))}`);
    lines.push("");
  }

  const errors = input.samples.filter((sample) => sample.error !== undefined);
  if (errors.length > 0) {
    lines.push("## Failed samples", "");
    for (const sample of errors)
      lines.push(
        `- ${sample.arm} ${sample.workload} rep ${sample.repetition} ${sample.turn}: ${sample.error}`,
      );
    lines.push("");
  }

  lines.push("## Run", "");
  for (const [key, value] of Object.entries(input.meta)) lines.push(`- ${key}: ${value}`);
  lines.push("", "---", "");
  for (const [index, note] of footnotes.entries()) lines.push(`${index + 1}. ${note}`);
  return `${lines.join("\n")}\n`;
}
