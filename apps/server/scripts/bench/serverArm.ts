// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off - Host-side benchmark process driver.
/**
 * Arm B: a real Par3 server, one per session, driven over the same WebSocket
 * RPC a client uses. Timestamps come from the `subscribeThread` stream items
 * as they arrive; the projection is never re-fetched.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/rpc";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  type ProjectId,
  ThreadId,
  WsRpcGroup,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";

import * as LiveServer from "../lib/liveServer.ts";
import { totalInputTokens, type ArmRunInput, type TurnSample } from "./benchTypes.ts";

const TURN_TIMEOUT = "10 minutes";
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const TOOL_ITEM_TYPES = new Set([
  "file_change",
  "command_execution",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
]);
const APPROVAL_KINDS_TO_SKIP = new Set(["user_input", "auth_refresh", "dynamic_tool_call"]);

/** Server-side spans that make up turn start-up, as named in the trace file. */
export const STARTUP_SPANS = [
  "orchestrationV2.providerTurnStart.start",
  "orchestrationV2.checkpointCapture.execute",
  "ClaudeAdapterV2.openSession",
  "ClaudeAgentSdkQueryRunner.open",
  "ClaudeAdapterV2.startTurn",
] as const;

interface TurnState {
  startedAt: number;
  startedAtEpochMs: number;
  runId: string | undefined;
  firstTextMs?: number;
  firstToolMs?: number;
  toolIds: Set<string>;
  approvalMs: number;
  terminalAt?: number;
  terminalAtEpochMs?: number;
  terminalStatus?: string;
}

export interface NativeResult {
  readonly sessionId: string | undefined;
  readonly atEpochMs: number;
  readonly apiMs: number | undefined;
  readonly inputTokens: number | undefined;
}

/** `result` lines from the provider's native event log, in order. */
export function readNativeResults(home: string, threadId: string | undefined): NativeResult[] {
  const directory = NodePath.join(home, "userdata", "logs", "provider");
  if (!NodeFS.existsSync(directory)) return [];
  const results: NativeResult[] = [];
  for (const file of NodeFS.readdirSync(directory)
    .filter(
      (name) => name.startsWith("events.") && (threadId === undefined || name.includes(threadId)),
    )
    .toSorted()) {
    for (const raw of NodeFS.readFileSync(NodePath.join(directory, file), "utf8").split("\n")) {
      const match = /^\[([^\]]+)\] \w+: (.*)$/.exec(raw);
      if (match === null) continue;
      let record: { event?: { direction?: string; payload?: Record<string, unknown> } };
      try {
        record = JSON.parse(match[2]!);
      } catch {
        continue;
      }
      const payload = record.event?.payload;
      if (record.event?.direction !== "incoming" || payload?.type !== "result") continue;
      results.push({
        sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
        atEpochMs: Date.parse(match[1]!),
        apiMs: typeof payload.duration_api_ms === "number" ? payload.duration_api_ms : undefined,
        inputTokens: totalInputTokens(payload.usage),
      });
    }
  }
  return results;
}

interface TraceSpan {
  readonly name: string;
  readonly startEpochMs: number;
  readonly durationMs: number;
}

function readTraceSpans(home: string): TraceSpan[] {
  const directory = NodePath.join(home, "userdata", "logs");
  if (!NodeFS.existsSync(directory)) return [];
  const wanted = new Set<string>(STARTUP_SPANS);
  const spans: TraceSpan[] = [];
  for (const file of NodeFS.readdirSync(directory).filter((name) =>
    name.startsWith("server.trace.ndjson"),
  )) {
    for (const raw of NodeFS.readFileSync(NodePath.join(directory, file), "utf8").split("\n")) {
      if (raw.length === 0) continue;
      let span: { name?: string; startTimeUnixNano?: string; durationMs?: number };
      try {
        span = JSON.parse(raw);
      } catch {
        continue;
      }
      if (span.name === undefined || !wanted.has(span.name)) continue;
      spans.push({
        name: span.name,
        startEpochMs: Number(BigInt(span.startTimeUnixNano ?? "0") / 1_000_000n),
        durationMs: span.durationMs ?? Number.NaN,
      });
    }
  }
  return spans;
}

/** The first span of each start-up name inside one turn's window. */
function spansForTurn(
  spans: ReadonlyArray<TraceSpan>,
  window: { readonly fromEpochMs: number; readonly toEpochMs: number },
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const span of spans.toSorted((left, right) => left.startEpochMs - right.startEpochMs)) {
    if (span.startEpochMs < window.fromEpochMs - 5 || span.startEpochMs > window.toEpochMs)
      continue;
    result[span.name] ??= span.durationMs;
  }
  return result;
}

export interface BenchServer {
  readonly home: string;
  readonly origin: string;
  readonly headers: Record<string, string>;
  readonly projectId: ProjectId;
  readonly stop: () => Promise<void>;
}

/**
 * Starts one bench server against a fresh T3 home with the Claude instance
 * pinned, and registers the fixture repository as its only project.
 */
export async function startBenchServer(
  input: ArmRunInput & {
    readonly claudeBinaryPath: string;
    readonly serverEnv: NodeJS.ProcessEnv;
  },
): Promise<BenchServer> {
  const home = NodePath.join(input.runDir, "home");
  LiveServer.writeServerSettings(
    home,
    LiveServer.claudeBenchSettings({
      binaryPath: input.claudeBinaryPath,
      ...(input.config.claudeConfigDir === undefined
        ? {}
        : { homePath: input.config.claudeConfigDir }),
      model: input.config.model,
      ...(input.config.effort === undefined ? {} : { effort: input.config.effort }),
      runtimeMode: input.runtimeMode,
      responseStreamingMode: input.streaming,
    }),
  );
  const port = await LiveServer.reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const bootstrap = NodeCrypto.randomUUID();
  const { server, ready } = LiveServer.startServer({
    port,
    home,
    bootstrap,
    logPath: NodePath.join(input.runDir, "server.log"),
    // Debug logging would slow the server being measured.
    logLevel: "info",
    readyText: "Listening on",
    env: { ...input.serverEnv, T3CODE_TRACE_BATCH_WINDOW_MS: "50" },
  });
  try {
    await ready;
    const headers = LiveServer.authHeaders(
      await LiveServer.exchangeBootstrapToken(origin, bootstrap),
    );
    const projectId = await LiveServer.createProject(origin, headers, {
      title: "Provider benchmark",
      workspaceRoot: input.cwd,
    });
    // Stop before reading the logs: stopping flushes the trace file and native event log.
    return { home, origin, headers, projectId, stop: () => LiveServer.stopServer(server) };
  } catch (error) {
    await LiveServer.stopServer(server);
    throw error;
  }
}

export async function runServerArm(
  input: ArmRunInput & {
    readonly claudeBinaryPath: string;
    readonly serverEnv: NodeJS.ProcessEnv;
  },
): Promise<TurnSample[]> {
  const bench = await startBenchServer(input);
  const { home, origin, headers, projectId } = bench;
  const threadId = ThreadId.make(NodeCrypto.randomUUID());
  const prompts = [
    input.workload.prompt,
    ...(input.workload.warmPrompt ? [input.workload.warmPrompt] : []),
  ];
  const turns: TurnState[] = [];
  const eventsPath = NodePath.join(input.runDir, "events.ndjson");
  try {
    const layerProtocol = await LiveServer.websocketProtocolLayer(origin, headers);
    const modelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: input.config.model,
      ...(input.config.effort === undefined
        ? {}
        : { options: [{ id: "effort", value: input.config.effort }] }),
    };

    const program = Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      // Wait for the start-up Claude probe, so the cold turn measures a turn
      // and not the health check. An error still ends the wait: the stub on
      // Windows fails the probe's direct spawn but runs turns through node.
      for (let attempt = 0; attempt < 120; attempt++) {
        const config = yield* client["server.getConfig"]({}).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const claude = config?.providers.find((provider) => provider.instanceId === "claudeAgent");
        if (claude !== undefined && claude.status !== "disabled") break;
        yield* Effect.sleep("500 millis");
      }
      const turnDone = yield* Effect.forEach(prompts, () => Deferred.make<void>());
      const runOrder: string[] = [];
      const pendingApprovals = new Map<string, number>();
      let active = -1;

      const handle = Effect.fn(function* (item: OrchestrationV2ThreadStreamItem) {
        const at = performance.now();
        const atEpochMs = Date.now();
        NodeFS.appendFileSync(eventsPath, `${JSON.stringify({ at, item })}\n`);
        const turn = turns[active];
        if (turn === undefined) return;
        const events = item.kind === "event" ? [item.event] : [];
        if (item.kind === "snapshot") {
          for (const run of item.projection.runs) {
            if (!runOrder.includes(run.id)) runOrder.push(run.id);
          }
        }
        for (const event of events) {
          switch (event.type) {
            case "run.created":
            case "run.updated": {
              const run = event.payload;
              if (!runOrder.includes(run.id)) runOrder.push(run.id);
              const index = runOrder.indexOf(run.id);
              const owner = turns[index];
              if (owner === undefined) break;
              owner.runId = run.id;
              if (TERMINAL_RUN_STATUSES.has(run.status) && owner.terminalAt === undefined) {
                owner.terminalAt = at;
                owner.terminalAtEpochMs = atEpochMs;
                owner.terminalStatus = run.status;
                yield* Deferred.succeed(turnDone[index]!, undefined);
              }
              break;
            }
            case "turn-item.updated": {
              const turnItem = event.payload;
              const elapsed = at - turn.startedAt;
              if (
                turnItem.type === "assistant_message" &&
                turn.firstTextMs === undefined &&
                turnItem.text.trim().length > 0
              ) {
                turn.firstTextMs = elapsed;
              }
              if (TOOL_ITEM_TYPES.has(turnItem.type)) {
                turn.firstToolMs ??= elapsed;
                turn.toolIds.add(turnItem.id);
              }
              break;
            }
            case "runtime-request.updated": {
              const request = event.payload;
              if (APPROVAL_KINDS_TO_SKIP.has(request.kind)) break;
              if (request.status === "pending" && !pendingApprovals.has(request.id)) {
                pendingApprovals.set(request.id, at);
                yield* client["orchestration.dispatchCommand"]({
                  type: "runtime-request.respond",
                  commandId: CommandId.make(NodeCrypto.randomUUID()),
                  threadId,
                  requestId: request.id,
                  decision: "accept",
                }).pipe(Effect.ignore, Effect.forkScoped);
              } else if (request.status !== "pending") {
                const askedAt = pendingApprovals.get(request.id);
                if (askedAt !== undefined) {
                  turn.approvalMs += at - askedAt;
                  pendingApprovals.delete(request.id);
                }
              }
              break;
            }
          }
        }
      });

      for (const [index, prompt] of prompts.entries()) {
        active = index;
        turns.push({
          startedAt: performance.now(),
          startedAtEpochMs: Date.now(),
          runId: undefined,
          toolIds: new Set(),
          approvalMs: 0,
        });
        if (index === 0) {
          yield* client["orchestration.launchThread"]({
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId,
            projectId,
            title: `Benchmark ${input.workload.id}`,
            modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { text: prompt, attachments: [] },
          });
          yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
            Stream.runForEach(handle),
            Effect.forkScoped,
          );
        } else {
          yield* client["orchestration.dispatchCommand"]({
            type: "message.dispatch",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: MessageId.make(NodeCrypto.randomUUID()),
            text: prompt,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
        }
        yield* Deferred.await(turnDone[index]!).pipe(Effect.timeout(TURN_TIMEOUT));
      }
    }).pipe(Effect.scoped, Effect.provide(layerProtocol));
    await Effect.runPromise(program);
    // Windows stops the server with a hard kill, so wait until the log
    // writers have flushed what this run needs.
    const deadline = performance.now() + 5_000;
    while (
      performance.now() < deadline &&
      (readNativeResults(home, threadId).length < turns.length ||
        readTraceSpans(home).filter((span) => span.name === "ClaudeAdapterV2.startTurn").length <
          turns.length)
    ) {
      await new Promise((done) => setTimeout(done, 50));
    }
  } finally {
    await bench.stop();
  }

  const results = readNativeResults(home, threadId);
  const spans = readTraceSpans(home);
  return turns.map((turn, index): TurnSample => {
    const wallMs = (turn.terminalAt ?? Number.NaN) - turn.startedAt;
    const result = results[index];
    const apiMs = result?.apiMs;
    const turnSpans = spansForTurn(spans, {
      fromEpochMs: turn.startedAtEpochMs,
      toEpochMs: turn.terminalAtEpochMs ?? Number.POSITIVE_INFINITY,
    });
    return {
      arm: "B",
      workload: input.workload.id,
      variant: input.variant,
      repetition: input.repetition,
      turn: index === 0 ? "cold" : "warm",
      wallMs,
      ...(apiMs === undefined ? {} : { apiMs, nonApiMs: wallMs - apiMs }),
      ...(turn.firstTextMs === undefined ? {} : { firstTextMs: turn.firstTextMs }),
      ...(turn.firstToolMs === undefined ? {} : { firstToolMs: turn.firstToolMs }),
      toolCount: turn.toolIds.size,
      ...(result?.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
      ...(input.runtimeMode === "full-access" ? {} : { approvalMs: turn.approvalMs }),
      spans: turnSpans,
      ...(result === undefined || turn.terminalAtEpochMs === undefined
        ? {}
        : { completionLagMs: turn.terminalAtEpochMs - result.atEpochMs }),
      ...(turn.terminalStatus === "completed" ? {} : { error: `run ${turn.terminalStatus}` }),
    };
  });
}
