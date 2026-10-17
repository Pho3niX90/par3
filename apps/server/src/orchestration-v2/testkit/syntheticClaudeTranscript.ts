import type { ProviderReplayEntry, ProviderReplayTranscript } from "@t3tools/contracts";

/**
 * Builds Claude Agent SDK replay transcripts with the shapes of the provider
 * benchmark's workloads, so the overhead gate can count what the server does
 * per turn without recording a live session. Frames follow the recorded
 * fixtures under `testkit/fixtures/claude_*`.
 */
export type SyntheticClaudeShape =
  /** W1: one text reply. */
  | { readonly kind: "text" }
  /** W2/W3: tool calls one after another, each answered before the next. */
  | { readonly kind: "sequential_tools"; readonly toolCalls: number }
  /** W5: tool calls issued together in one assistant message. */
  | { readonly kind: "parallel_tools"; readonly toolCalls: number }
  /** W4: a long answer streamed as many text deltas. */
  | { readonly kind: "streamed_text"; readonly deltas: number };

const SYNTHETIC_CLAUDE_MODEL = "claude-sonnet-4-6";
const SESSION_ID = "5e5e5e5e-0000-4000-8000-00000000be0c";

interface TurnInput {
  readonly prompt: string;
  readonly shape: SyntheticClaudeShape;
  readonly finalText: string;
}

const usage = {
  input_tokens: 3,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 1,
  service_tier: "standard",
  inference_geo: "not_available",
};

function assistant(id: string, uuid: string, content: ReadonlyArray<unknown>) {
  return {
    type: "assistant",
    message: {
      model: SYNTHETIC_CLAUDE_MODEL,
      id,
      type: "message",
      role: "assistant",
      content,
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage,
      context_management: null,
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid,
  };
}

function toolResult(toolUseId: string, uuid: string) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: toolUseId, type: "tool_result", content: "ok", is_error: false }],
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid,
    timestamp: "2026-10-01T00:00:00.000Z",
    tool_use_result: { stdout: "ok", stderr: "", interrupted: false, isImage: false },
  };
}

function streamEvent(uuid: string, event: unknown) {
  return { type: "stream_event", event, session_id: SESSION_ID, parent_tool_use_id: null, uuid };
}

function turnFrames(turn: number, input: TurnInput): unknown[] {
  let counter = 0;
  const uuid = () =>
    `00000000-0000-4000-8000-${String(turn).padStart(4, "0")}${String(counter++).padStart(8, "0")}`;
  const frames: unknown[] = [
    {
      type: "system",
      subtype: "init",
      agents: [],
      apiKeySource: "none",
      claude_code_version: "2.1.300",
      cwd: "/tmp/claude-replay-provider-overhead",
      tools: [],
      mcp_servers: [],
      model: SYNTHETIC_CLAUDE_MODEL,
      permissionMode: "bypassPermissions",
      slash_commands: [],
      output_style: "default",
      skills: [],
      plugins: [],
      fast_mode_state: "off",
      uuid: uuid(),
      session_id: SESSION_ID,
    },
  ];
  const messageId = (index: number) => `msg_bench_${turn}_${index}`;
  const toolId = (index: number) => `toolu_bench_${turn}_${index}`;
  const shape = input.shape;
  switch (shape.kind) {
    case "text":
      break;
    case "sequential_tools":
      for (let index = 0; index < shape.toolCalls; index++) {
        frames.push(
          assistant(messageId(index), uuid(), [
            {
              type: "tool_use",
              id: toolId(index),
              name: index % 2 === 0 ? "Grep" : "Read",
              input:
                index % 2 === 0
                  ? { pattern: "formatCurrency", path: "src" }
                  : { file_path: `src/file${index}.ts` },
              caller: { type: "direct" },
            },
          ]),
          toolResult(toolId(index), uuid()),
        );
      }
      break;
    case "parallel_tools":
      // The CLI emits one assistant message per block, all with the same id.
      for (let index = 0; index < shape.toolCalls; index++) {
        frames.push(
          assistant(messageId(0), uuid(), [
            {
              type: "tool_use",
              id: toolId(index),
              name: "Read",
              input: { file_path: `src/file${index}.ts` },
              caller: { type: "direct" },
            },
          ]),
        );
      }
      for (let index = 0; index < shape.toolCalls; index++) {
        frames.push(toolResult(toolId(index), uuid()));
      }
      break;
    case "streamed_text": {
      const id = messageId(0);
      frames.push(
        streamEvent(uuid(), {
          type: "message_start",
          message: { ...assistant(id, "", []).message, content: [] },
        }),
        streamEvent(uuid(), {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
      for (let index = 0; index < shape.deltas; index++) {
        frames.push(
          streamEvent(uuid(), {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: `word${index} ` },
          }),
        );
      }
      // As the CLI does: the whole message follows its block's stop, under the same id.
      frames.push(
        streamEvent(uuid(), { type: "content_block_stop", index: 0 }),
        assistant(id, uuid(), [{ type: "text", text: input.finalText }]),
        streamEvent(uuid(), {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage,
        }),
        streamEvent(uuid(), { type: "message_stop" }),
      );
      break;
    }
  }
  if (shape.kind !== "streamed_text") {
    frames.push(
      assistant(`msg_bench_${turn}_final`, uuid(), [{ type: "text", text: input.finalText }]),
    );
  }
  frames.push({
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: 1,
    result: input.finalText,
    stop_reason: "end_turn",
    session_id: SESSION_ID,
    total_cost_usd: 0,
    usage: { ...usage, output_tokens: 7 },
    modelUsage: {},
    permission_denials: [],
    uuid: uuid(),
  });
  return frames;
}

/**
 * One transcript for a thread whose turns have the given prompts and shapes.
 * `afterMs`, when set, delays every inbound frame by that much.
 */
export function makeSyntheticClaudeTranscript(input: {
  readonly scenario: string;
  readonly turns: ReadonlyArray<TurnInput>;
  readonly afterMs?: number;
}): ProviderReplayTranscript {
  const entries: ProviderReplayEntry[] = [
    {
      type: "expect_outbound",
      label: "query.open",
      frame: {
        type: "query.open",
        options: {
          model: SYNTHETIC_CLAUDE_MODEL,
          tools: { type: "preset", preset: "claude_code" },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          sessionId: SESSION_ID,
          settings: { showThinkingSummaries: true },
        },
      },
    },
  ];
  for (const [index, turn] of input.turns.entries()) {
    entries.push({
      type: "expect_outbound",
      label: `prompt.offer:${index + 1}`,
      frame: {
        type: "prompt.offer",
        message: {
          type: "user",
          message: { role: "user", content: turn.prompt },
          parent_tool_use_id: null,
        },
      },
    });
    for (const frame of turnFrames(index, turn)) {
      entries.push({
        type: "emit_inbound",
        label: (frame as { type: string }).type,
        frame,
        ...(input.afterMs === undefined ? {} : { afterMs: input.afterMs }),
      });
    }
  }
  entries.push({ type: "runtime_exit", status: "success" });
  return {
    provider: "claudeAgent",
    protocol: "claude-agent-sdk.query",
    version: "0.3.276",
    scenario: input.scenario,
    metadata: {
      prompts: input.turns.map((turn) => turn.prompt),
      model: SYNTHETIC_CLAUDE_MODEL,
      nativeSessionId: SESSION_ID,
      queryMode: "streaming",
      tools: "claude_code",
      permissionMode: "bypassPermissions",
      generatedBy: "makeSyntheticClaudeTranscript",
    },
    entries,
  };
}
