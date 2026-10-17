// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off preferSchemaOverJson:off - Host-side benchmark driver.
/**
 * Measures how much longer a Claude turn takes through Par3 than through the
 * `claude` CLI itself. Run from the repository root:
 *
 *   node apps/server/scripts/bench-provider-overhead.ts --workloads W1 --n 1
 *
 * Arms: A0 raw `claude -p`, A1 A0 plus Par3's configuration, B the Par3 server,
 * and the opt-in interactive arms T (`claude` in a terminal) and C (the Par3
 * web app). `--stub <dir>` replays recorded A0 output instead of calling the
 * model, so every arm sees identical model time; `--stub synthetic` replays
 * generated turns shaped like each workload and needs no earlier run. Results go to `--out`
 * (default under the OS temp dir): `results.json` and `summary.md`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { renderSummary } from "./bench/benchReport.ts";
import {
  ARM_ORDER,
  isUsageLimitError,
  type ArmId,
  type BenchConfig,
  type RuntimeMode,
  type TurnSample,
} from "./bench/benchTypes.ts";
import { createFixtureRepo, selectWorkloads, type Workload } from "./bench/benchWorkloads.ts";
import { ensureWebBuild, runAppArm } from "./bench/appArm.ts";
import { runHeadlessArm, type HeadlessLaunch } from "./bench/headlessArm.ts";
import { runServerArm } from "./bench/serverArm.ts";
import { measureNodeSpawnMs, runTerminalArm } from "./bench/terminalArm.ts";
import { repositoryRoot } from "./lib/liveServer.ts";
import {
  makeSyntheticClaudeTranscript,
  type SyntheticClaudeShape,
} from "../src/orchestration-v2/testkit/syntheticClaudeTranscript.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Host-side script with no Effect runtime.
const host = { platform: process.platform, arch: process.arch };

const { values } = NodeUtil.parseArgs({
  options: {
    arms: { type: "string", default: "A0,A1,B" },
    workloads: { type: "string" },
    n: { type: "string" },
    model: { type: "string", default: "claude-sonnet-5-5" },
    effort: { type: "string" },
    "claude-bin": { type: "string" },
    "runtime-mode": { type: "string", default: "full-access" },
    streaming: { type: "string", default: "paragraph" },
    out: { type: "string" },
    stub: { type: "string" },
    matrix: { type: "boolean", default: false },
    headless: { type: "boolean", default: process.env.CI === "true" },
  },
});

const arms = values.arms.split(",").map((arm) => arm.trim()) as ArmId[];
for (const arm of arms) {
  if (!ARM_ORDER.includes(arm)) throw new Error(`Unknown arm ${arm}; use ${ARM_ORDER.join(", ")}`);
}
const runtimeMode = values["runtime-mode"] as RuntimeMode;
if (!["full-access", "auto-accept-edits", "approval-required"].includes(runtimeMode)) {
  throw new Error("--runtime-mode must be full-access, auto-accept-edits or approval-required");
}
if (values.streaming !== "paragraph" && values.streaming !== "turn") {
  throw new Error("--streaming must be paragraph or turn");
}
const streaming: "paragraph" | "turn" = values.streaming;
const repeatOverride = values.n === undefined ? undefined : Number(values.n);
if (repeatOverride !== undefined && !(Number.isSafeInteger(repeatOverride) && repeatOverride > 0)) {
  throw new Error("--n must be a positive integer");
}
const workloads = selectWorkloads(values.workloads?.split(",").map((id) => id.trim()));
const outDir = NodePath.resolve(
  values.out ??
    NodePath.join(
      NodeOS.tmpdir(),
      `t3-provider-bench-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
    ),
);
NodeFS.mkdirSync(outDir, { recursive: true });

const SYNTHETIC_SHAPES: Record<Workload["id"], SyntheticClaudeShape> = {
  W1: { kind: "text" },
  W2: { kind: "sequential_tools", toolCalls: 8 },
  W3: { kind: "sequential_tools", toolCalls: 2 },
  W4: { kind: "streamed_text", deltas: 200 },
  W5: { kind: "parallel_tools", toolCalls: 8 },
};
// Gap between generated frames: a fast model's pace.
const SYNTHETIC_FRAME_GAP_MS = 30;

/** Writes stub recordings built from the replay gate's synthetic transcripts. */
function writeSyntheticRecordings(directory: string): void {
  for (const workload of workloads) {
    const prompts = [workload.prompt, ...(workload.warmPrompt ? [workload.warmPrompt] : [])];
    const transcript = makeSyntheticClaudeTranscript({
      scenario: workload.id,
      turns: prompts.map((prompt) => ({
        prompt,
        shape: SYNTHETIC_SHAPES[workload.id],
        finalText: `${workload.id} done`,
      })),
    });
    const lines: string[] = [];
    let turn = -1;
    let ms = 0;
    let sessionApiMs = 0;
    for (const entry of transcript.entries) {
      if (entry.type === "expect_outbound" && entry.label?.startsWith("prompt.offer")) {
        turn += 1;
        ms = 0;
      } else if (entry.type === "emit_inbound") {
        ms += SYNTHETIC_FRAME_GAP_MS;
        const frame = entry.frame as Record<string, unknown>;
        // The scripted time stands in for model time. Like the CLI, the
        // result reports API time summed over the whole session.
        if (frame.type === "result") sessionApiMs += ms;
        const line = frame.type === "result" ? { ...frame, duration_api_ms: sessionApiMs } : frame;
        lines.push(JSON.stringify({ turn, ms, line }));
      }
    }
    NodeFS.mkdirSync(NodePath.join(directory, workload.id), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(directory, workload.id, "synthetic.ndjson"),
      lines.map((line) => `${line}\n`).join(""),
    );
  }
}

const stubDirectory =
  values.stub === undefined
    ? undefined
    : values.stub === "synthetic"
      ? NodePath.join(outDir, "synthetic-recordings")
      : NodePath.resolve(values.stub);
if (values.stub === "synthetic") writeSyntheticRecordings(stubDirectory!);
const stubScript = NodePath.join(import.meta.dirname, "bench", "stubClaude.mjs");

function resolveClaudeBinary(): string {
  if (values["claude-bin"] !== undefined) return NodePath.resolve(values["claude-bin"]);
  const lookup = host.platform === "win32" ? "where" : "which";
  const found = NodeChildProcess.execFileSync(lookup, ["claude"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // `where` lists extensionless shims first; spawn needs the real executable.
  const executable =
    host.platform === "win32"
      ? found.find((path) => path.toLowerCase().endsWith(".exe"))
      : found[0];
  if (executable === undefined) throw new Error("claude was not found on PATH; pass --claude-bin");
  return executable;
}

const claudeBin = stubDirectory === undefined ? resolveClaudeBinary() : stubScript;
const claudeVersion =
  stubDirectory === undefined
    ? NodeChildProcess.execFileSync(claudeBin, ["--version"], { encoding: "utf8" }).trim()
    : "stub";
const config: BenchConfig = {
  arms,
  model: values.model,
  effort: values.effort,
  claudeBin,
  claudeVersion,
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
  runtimeMode,
  streaming,
  outDir,
  stub: stubDirectory,
  // The t3-code MCP server only takes credentials the server mints for its
  // own provider sessions, so A1 runs without it. See issue #31.
  a1WithoutMcp: true,
};

interface Variant {
  readonly workload: Workload;
  readonly name: string;
  readonly runtimeMode: RuntimeMode;
  readonly streaming: "paragraph" | "turn";
}

function variants(): Variant[] {
  if (!values.matrix) {
    return workloads.map((workload) => ({ workload, name: "", runtimeMode, streaming }));
  }
  // W3 under every permission mode, W4 under both streaming modes.
  const byId = (id: string) => selectWorkloads([id])[0]!;
  return [
    ...(["full-access", "auto-accept-edits", "approval-required"] as const).map((mode) => ({
      workload: byId("W3"),
      name: mode,
      runtimeMode: mode,
      streaming,
    })),
    ...(["paragraph", "turn"] as const).map((mode) => ({
      workload: byId("W4"),
      name: mode,
      runtimeMode,
      streaming: mode,
    })),
  ];
}

/** A0's first recording for a workload, replayed by the stub for every arm. */
function stubRecording(workload: Workload): string {
  const directory = NodePath.join(stubDirectory!, workload.id);
  const file = NodeFS.existsSync(directory)
    ? NodeFS.readdirSync(directory)
        .filter((name) => name.endsWith(".ndjson"))
        .toSorted()[0]
    : undefined;
  if (file === undefined) throw new Error(`No recording for ${workload.id} under ${directory}`);
  return NodePath.join(directory, file);
}

function environmentFor(workload: Workload): NodeJS.ProcessEnv {
  return stubDirectory === undefined
    ? process.env
    : { ...process.env, T3_BENCH_STUB_RECORDING: stubRecording(workload) };
}

if (arms.includes("C")) ensureWebBuild();
const nodeSpawnMs = arms.includes("T") ? measureNodeSpawnMs() : 0;
const samples: TurnSample[] = [];

async function runArm(arm: ArmId, variant: Variant, repetition: number): Promise<TurnSample[]> {
  const label = `${variant.workload.id}${variant.name ? `-${variant.name}` : ""}`;
  // Flat and short: git checkpoint refs under a deep path pass Windows' 260-character limit.
  const runDir = NodePath.join(
    outDir,
    "runs",
    `${label}-${arm}-${repetition < 0 ? "w" : repetition}`,
  );
  NodeFS.mkdirSync(runDir, { recursive: true });
  const cwd = createFixtureRepo(NodePath.join(runDir, "repo"));
  const env = environmentFor(variant.workload);
  const input = {
    config,
    workload: variant.workload,
    variant: variant.name,
    runtimeMode: variant.runtimeMode,
    streaming: variant.streaming,
    repetition,
    cwd,
    runDir,
  };
  switch (arm) {
    case "A0":
    case "A1": {
      const launch: HeadlessLaunch =
        stubDirectory === undefined
          ? { command: claudeBin, prefixArgs: [], env }
          : { command: process.execPath, prefixArgs: [stubScript], env };
      return runHeadlessArm({
        ...input,
        arm,
        launch,
        // Raw A0 output is what the stub replays.
        ...(arm === "A0" && stubDirectory === undefined && repetition >= 0
          ? {
              recordingPath: NodePath.join(
                outDir,
                "recordings",
                variant.workload.id,
                `A0-r${String(repetition).padStart(2, "0")}${variant.name ? `-${variant.name}` : ""}.ndjson`,
              ),
            }
          : {}),
      });
    }
    case "B":
      return runServerArm({ ...input, claudeBinaryPath: claudeBin, serverEnv: env });
    case "T":
      if (stubDirectory !== undefined)
        throw new Error("The terminal arm cannot run against the stub");
      return runTerminalArm({ ...input, claudeBin, env, nodeSpawnMs });
    case "C":
      return runAppArm({
        ...input,
        claudeBinaryPath: claudeBin,
        serverEnv: env,
        headless: values.headless,
      });
  }
}

const selectedOrder = ARM_ORDER.filter((arm) => arms.includes(arm));
// Once the account's usage window is spent every later turn fails in seconds,
// so the rest of the run would only record failures.
let stoppedEarly: string | undefined;
benchLoop: for (const variant of variants()) {
  const repeats = repeatOverride ?? variant.workload.repeats;
  // One discarded warm-up per arm, then repetitions in alternating order
  // (A0 A1 T B C, C B T A1 A0, ...) so drift over the run hits every arm alike.
  for (let repetition = -1; repetition < repeats; repetition++) {
    const order = repetition % 2 === 0 ? selectedOrder : selectedOrder.toReversed();
    for (const arm of order) {
      const tag = `${variant.workload.id}${variant.name ? ` [${variant.name}]` : ""} ${arm} ${repetition < 0 ? "warm-up" : `rep ${repetition + 1}/${repeats}`}`;
      process.stdout.write(`${tag} ... `);
      try {
        const result = await runArm(arm, variant, repetition);
        console.log(
          result.map((sample) => `${sample.turn} ${Math.round(sample.wallMs)} ms`).join(", "),
        );
        if (repetition >= 0) samples.push(...result);
        stoppedEarly = result.map((sample) => sample.error).find(isUsageLimitError);
      } catch (error) {
        console.log(`failed: ${String(error)}`);
        if (isUsageLimitError(String(error))) stoppedEarly = String(error);
        if (repetition >= 0) {
          samples.push({
            arm,
            workload: variant.workload.id,
            variant: variant.name,
            repetition,
            turn: "cold",
            wallMs: Number.NaN,
            error: String(error),
          });
        }
      }
      if (stoppedEarly !== undefined) {
        console.log(`Stopping: ${stoppedEarly}`);
        break benchLoop;
      }
    }
  }
}

const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
const meta = {
  claude: claudeVersion,
  gitRevision: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain").length > 0 ? "yes" : "no",
  os: `${host.platform} ${NodeOS.release()} ${host.arch}`,
  node: process.version,
  finishedAt: new Date().toISOString(),
  ...(stoppedEarly === undefined ? {} : { stoppedEarly }),
};
NodeFS.writeFileSync(
  NodePath.join(outDir, "results.json"),
  JSON.stringify({ config, meta, samples }, null, 2),
);
const summary = renderSummary({ config, samples, meta });
NodeFS.writeFileSync(NodePath.join(outDir, "summary.md"), summary);
console.log(`\n${summary}`);
console.log(`Results: ${outDir}`);
