// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off preferSchemaOverJson:off - Host-side benchmark process driver.
/**
 * Arms A0 and A1: the Claude CLI in print mode with stream-json on both
 * pipes, one process per session. A1 adds the configuration Par3's adapter
 * passes (see `makeClaudeQueryOptions` in ClaudeAdapterV2.ts), so A1 − A0 is
 * the cost of that configuration and B − A1 is the cost of the server.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  contentBlocks,
  permissionModeFor,
  totalInputTokens,
  type ArmRunInput,
  type TurnSample,
} from "./benchTypes.ts";

const TURN_TIMEOUT_MS = 10 * 60_000;

/** The `--append-system-prompt` text Par3 sends when the t3-code MCP server is attached. */
function par3AppendedSystemPrompt(): string {
  return buildRuntimeInstructions({ harness: "Claude Code" }) + T3_CODE_ORCHESTRATION_INSTRUCTIONS;
}

function headlessArgs(input: {
  readonly arm: "A0" | "A1";
  readonly model: string;
  readonly effort: string | undefined;
  readonly runtimeMode: ArmRunInput["runtimeMode"];
  readonly cwd: string;
}): string[] {
  const permissionMode = permissionModeFor(input.runtimeMode);
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    input.model,
    ...(input.effort === undefined ? [] : ["--effort", input.effort]),
    "--permission-mode",
    permissionMode,
    ...(permissionMode === "bypassPermissions" ? ["--allow-dangerously-skip-permissions"] : []),
    // Approval modes route each prompt to the driver, as the SDK's canUseTool does.
    ...(input.runtimeMode === "full-access" ? [] : ["--permission-prompt-tool", "stdio"]),
  ];
  if (input.arm === "A0") return args;
  return [
    ...args,
    "--append-system-prompt",
    par3AppendedSystemPrompt(),
    "--thinking",
    "adaptive",
    "--thinking-display",
    "summarized",
    "--settings",
    JSON.stringify({ showThinkingSummaries: true }),
    "--add-dir",
    input.cwd,
  ];
}

export interface HeadlessLaunch {
  readonly command: string;
  readonly prefixArgs: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

interface TimedLine {
  readonly turn: number;
  readonly ms: number;
  readonly line: unknown;
}

function userMessage(text: string): string {
  return `${JSON.stringify({
    type: "user",
    session_id: "",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  })}\n`;
}

function allowResponse(requestId: string, toolInput: unknown): string {
  return `${JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { behavior: "allow", updatedInput: toolInput },
    },
  })}\n`;
}

/**
 * Runs one session: the cold prompt, then the warm prompt when the workload
 * has one. When `recordingPath` is set, every stdout line is saved with its
 * offset from the turn's prompt, for the stub `claude` to replay.
 */
export async function runHeadlessArm(
  input: ArmRunInput & {
    readonly arm: "A0" | "A1";
    readonly launch: HeadlessLaunch;
    readonly recordingPath?: string;
  },
): Promise<TurnSample[]> {
  const prompts = [
    input.workload.prompt,
    ...(input.workload.warmPrompt ? [input.workload.warmPrompt] : []),
  ];
  const args = [
    ...input.launch.prefixArgs,
    ...headlessArgs({
      arm: input.arm,
      model: input.config.model,
      effort: input.config.effort,
      runtimeMode: input.runtimeMode,
      cwd: input.cwd,
    }),
  ];
  const child = NodeChildProcess.spawn(input.launch.command, args, {
    cwd: input.cwd,
    env: input.launch.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderrPath = NodePath.join(input.runDir, `${input.arm}.stderr.log`);
  child.stderr?.on("data", (chunk: Buffer) => NodeFS.appendFileSync(stderrPath, chunk));
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  const lines = NodeReadline.createInterface({ input: child.stdout! });
  const recorded: TimedLine[] = [];
  const samples: TurnSample[] = [];

  let turn = 0;
  let turnStart = 0;
  let current: {
    firstTextMs?: number;
    firstToolMs?: number;
    toolIds: Set<string>;
    approvalMs: number;
    resolve: (line: Record<string, unknown>) => void;
  } | null = null;

  const startTurn = (text: string) =>
    new Promise<{ line: Record<string, unknown>; at: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Turn ${turn} timed out`)), TURN_TIMEOUT_MS);
      current = {
        toolIds: new Set(),
        approvalMs: 0,
        resolve: (line) => {
          clearTimeout(timer);
          resolve({ line, at: performance.now() });
        },
      };
      turnStart = performance.now();
      child.stdin!.write(userMessage(text));
    });

  lines.on("line", (raw) => {
    const at = performance.now();
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (input.recordingPath !== undefined) recorded.push({ turn, ms: at - turnStart, line });
    const state = current;
    if (state === null) return;
    const elapsed = at - turnStart;
    if (line.type === "stream_event") {
      const event = line.event as Record<string, unknown> | undefined;
      const delta = event?.delta as Record<string, unknown> | undefined;
      const block = event?.content_block as Record<string, unknown> | undefined;
      if (
        state.firstTextMs === undefined &&
        event?.type === "content_block_delta" &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string" &&
        delta.text.length > 0
      ) {
        state.firstTextMs = elapsed;
      }
      if (state.firstToolMs === undefined && block?.type === "tool_use")
        state.firstToolMs = elapsed;
    } else if (line.type === "assistant" && line.parent_tool_use_id == null) {
      for (const block of contentBlocks(line)) {
        // A reply that arrives whole, with no deltas, is first visible here.
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          state.firstTextMs ??= elapsed;
        }
        if (block.type !== "tool_use" || typeof block.id !== "string") continue;
        state.firstToolMs ??= elapsed;
        state.toolIds.add(block.id);
      }
    } else if (line.type === "control_request") {
      const request = line.request as Record<string, unknown> | undefined;
      if (request?.subtype === "can_use_tool" && typeof line.request_id === "string") {
        // Answered at once, so the round trip is the CLI's own wait.
        const asked = performance.now();
        child.stdin!.write(allowResponse(line.request_id, request.input));
        state.approvalMs += performance.now() - asked;
      }
    } else if (line.type === "result") {
      state.resolve(line);
    }
  });

  let previousSessionApiMs = 0;
  try {
    for (const [index, prompt] of prompts.entries()) {
      turn = index;
      const { line, at } = await startTurn(prompt);
      const state = current!;
      const wallMs = at - turnStart;
      // `duration_api_ms` is summed over the session, so a warm turn's own
      // API time is the difference from the previous result.
      const sessionApiMs =
        typeof line.duration_api_ms === "number" ? line.duration_api_ms : undefined;
      const apiMs =
        sessionApiMs === undefined
          ? undefined
          : sessionApiMs - (sessionApiMs >= previousSessionApiMs ? previousSessionApiMs : 0);
      previousSessionApiMs = sessionApiMs ?? previousSessionApiMs;
      const inputTokens = totalInputTokens(line.usage);
      samples.push({
        arm: input.arm,
        workload: input.workload.id,
        variant: input.variant,
        repetition: input.repetition,
        turn: index === 0 ? "cold" : "warm",
        wallMs,
        ...(apiMs === undefined ? {} : { apiMs, nonApiMs: wallMs - apiMs }),
        ...(state.firstTextMs === undefined ? {} : { firstTextMs: state.firstTextMs }),
        ...(state.firstToolMs === undefined ? {} : { firstToolMs: state.firstToolMs }),
        toolCount: state.toolIds.size,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(input.runtimeMode === "full-access" ? {} : { approvalMs: state.approvalMs }),
        ...(line.is_error === true ? { error: String(line.result ?? line.subtype) } : {}),
      });
      current = null;
    }
  } finally {
    child.stdin!.end();
    const deadline = setTimeout(() => child.kill(), 10_000);
    await exited;
    clearTimeout(deadline);
    if (input.recordingPath !== undefined) {
      NodeFS.mkdirSync(NodePath.dirname(input.recordingPath), { recursive: true });
      NodeFS.writeFileSync(
        input.recordingPath,
        recorded.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
    }
  }
  return samples;
}
