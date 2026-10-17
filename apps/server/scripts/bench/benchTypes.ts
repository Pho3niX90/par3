import type { Workload, WorkloadId } from "./benchWorkloads.ts";

/**
 * A0: raw `claude -p`. A1: A0 plus Par3's configuration. B: the Par3 server.
 * T: interactive `claude` in a terminal. C: the Par3 web app.
 */
export type ArmId = "A0" | "A1" | "B" | "T" | "C";

export const ARM_ORDER: ReadonlyArray<ArmId> = ["A0", "A1", "T", "B", "C"];

export type RuntimeMode = "full-access" | "auto-accept-edits" | "approval-required";

export type TurnKind = "cold" | "warm";

export interface TurnSample {
  readonly arm: ArmId;
  readonly workload: WorkloadId;
  /** Matrix variant, such as `approval-required` or `turn`; empty for the default. */
  readonly variant: string;
  readonly repetition: number;
  readonly turn: TurnKind;
  /** Prompt sent to task finished, in ms. */
  readonly wallMs: number;
  /** `duration_api_ms` reported by the CLI, when known. */
  readonly apiMs?: number;
  /** Wall minus API time: everything that is not the model. */
  readonly nonApiMs?: number;
  readonly firstTextMs?: number;
  readonly firstToolMs?: number;
  readonly toolCount?: number;
  readonly inputTokens?: number;
  /** Total time approvals spent waiting for an answer, in ms. Never counted as overhead. */
  readonly approvalMs?: number;
  /** B only: start-up span durations, by span name. */
  readonly spans?: Readonly<Record<string, number>>;
  /** B only: client terminal `run.updated` receipt minus the provider `result` log time. */
  readonly completionLagMs?: number;
  /** C only: last assistant text paint relative to the prompt. */
  readonly lastTextMs?: number;
  readonly error?: string;
}

export interface BenchConfig {
  readonly arms: ReadonlyArray<ArmId>;
  readonly model: string;
  readonly effort: string | undefined;
  readonly claudeBin: string;
  readonly claudeVersion: string;
  readonly claudeConfigDir: string | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly streaming: "paragraph" | "turn";
  readonly outDir: string;
  /** A recording directory replayed by the stub `claude`, when set. */
  readonly stub: string | undefined;
  /** True when A1 runs without the t3-code MCP server attached. */
  readonly a1WithoutMcp: boolean;
}

export interface ArmRunInput {
  readonly config: BenchConfig;
  readonly workload: Workload;
  readonly variant: string;
  readonly runtimeMode: RuntimeMode;
  readonly streaming: "paragraph" | "turn";
  readonly repetition: number;
  /** Fresh copy of the fixture repository for this run. */
  readonly cwd: string;
  /** Scratch directory for this run's evidence. */
  readonly runDir: string;
}

export function permissionModeFor(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "full-access":
      return "bypassPermissions";
    case "auto-accept-edits":
      return "acceptEdits";
    case "approval-required":
      return "default";
  }
}

/** Content blocks of a stream-json `assistant` or `user` line. */
export function contentBlocks(line: unknown): ReadonlyArray<Record<string, unknown>> {
  if (typeof line !== "object" || line === null) return [];
  const message = (line as { message?: { content?: unknown } }).message;
  return Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [];
}

/** Input tokens including cache reads and writes, from a `result` usage block. */
export function totalInputTokens(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  const read = (key: string) => (typeof record[key] === "number" ? record[key] : 0);
  return (
    read("input_tokens") + read("cache_creation_input_tokens") + read("cache_read_input_tokens")
  );
}
