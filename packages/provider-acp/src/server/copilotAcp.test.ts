import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as AcpSchema from "effect-acp/compat";

import type { AcpAdapterV2ExtensionContext } from "./adapter.ts";
import { extractCopilotSubagentUpdate, makeCopilotSubagentRouting } from "./copilotAcp.ts";
import type { AcpToolCallState } from "./runtimeModel.ts";

interface CopilotSessionEvent {
  readonly sessionId: string;
  readonly type: string;
  readonly agentId?: string;
  readonly data?: Record<string, unknown>;
}

const sessionUpdate = (sessionId: string, update: Record<string, unknown>) =>
  ({ sessionId, update }) as unknown as AcpSchema.SessionNotification;

const messageChunk = (sessionId: string, text: string) =>
  sessionUpdate(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });

/** Registers the routing against a fake runtime and exposes the raw event handler. */
const registerRouting = () => {
  const routing = makeCopilotSubagentRouting();
  const finished: Array<{
    readonly sessionId: string;
    readonly childSessionId: string;
    readonly status: string;
    readonly result: string | null;
  }> = [];
  let handler: ((event: CopilotSessionEvent) => Effect.Effect<void>) | undefined;
  const context = {
    runtime: {
      handleExtNotification: (
        _method: string,
        _schema: unknown,
        onEvent: (event: CopilotSessionEvent) => Effect.Effect<void>,
      ) => {
        handler = onEvent;
        return Effect.void;
      },
    },
    finishSubagent: (notice: (typeof finished)[number]) =>
      Effect.sync(() => {
        finished.push(notice);
      }),
  } as unknown as AcpAdapterV2ExtensionContext;
  return {
    routing,
    finished,
    register: routing.registerExtensions(context),
    emit: (event: CopilotSessionEvent) => {
      if (handler === undefined) throw new Error("routing extensions were not registered");
      return handler(event);
    },
  };
};

describe("extractCopilotSubagentUpdate", () => {
  it("extracts a subagent update from a task tool call", () => {
    const toolCall: AcpToolCallState = {
      toolCallId: "call-1",
      title: "Explore codebase",
      kind: "other",
      status: "inProgress",
      data: {
        rawInput: {
          description: "Explore repo",
          prompt: "Find all usages of config.",
          agent_type: "explore",
          model: "gpt-4o",
          mode: "sync",
        },
        rawOutput: null,
      },
    };

    const update = extractCopilotSubagentUpdate(toolCall);
    expect(update).toBeDefined();
    expect(update?.nativeTaskId).toBe("call-1");
    expect(update?.childSessionId).toBe("copilot-task:call-1");
    expect(update?.prompt).toBe("Find all usages of config.");
    expect(update?.title).toBe("Explore repo");
    expect(update?.model).toBe("gpt-4o");
    expect(update?.status).toBe("running");
  });

  it("leaves a background task running until its completion event", () => {
    const update = extractCopilotSubagentUpdate({
      toolCallId: "call-2",
      title: "Background",
      kind: "other",
      status: "completed",
      data: {
        rawInput: { prompt: "Index the repo.", agent_type: "explore", mode: "background" },
        rawOutput: { content: "started" },
      },
    });
    expect(update?.status).toBe("running");
    expect(update?.result).toBeNull();
  });

  it("ignores tool calls that are not subagent launches", () => {
    expect(
      extractCopilotSubagentUpdate({
        toolCallId: "call-3",
        title: "Read file",
        kind: "read",
        status: "completed",
        data: { rawInput: { path: "a.ts" }, rawOutput: null },
      }),
    ).toBeUndefined();
  });
});

describe("makeCopilotSubagentRouting", () => {
  it.effect("routes a subagent's streamed text and tool calls to its child session", () =>
    Effect.gen(function* () {
      const { routing, register, emit } = registerRouting();
      yield* register;

      yield* emit({
        sessionId: "root",
        type: "subagent.started",
        agentId: "agent-1",
        data: { toolCallId: "task-1" },
      });

      // The raw delta names its task; the chunk that follows with the same text is attributed.
      yield* emit({
        sessionId: "root",
        type: "assistant.message_delta",
        data: { deltaContent: "hello", parentToolCallId: "task-1" },
      });
      const routedMessage = routing.normalizeSessionUpdate(messageChunk("root", "hello"));
      expect(routedMessage.sessionId).toBe("copilot-task:task-1");

      // A tool call carries the subagent's id in its Copilot metadata.
      const routedTool = routing.normalizeSessionUpdate(
        sessionUpdate("root", {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Read",
          _meta: { "github.com/copilot": { agentId: "agent-1" } },
        }),
      );
      expect(routedTool.sessionId).toBe("copilot-task:task-1");
    }),
  );

  it.effect("keeps root text on the root session", () =>
    Effect.gen(function* () {
      const { routing, register, emit } = registerRouting();
      yield* register;

      yield* emit({
        sessionId: "root",
        type: "assistant.message_delta",
        data: { deltaContent: "from the root" },
      });
      const routed = routing.normalizeSessionUpdate(messageChunk("root", "from the root"));
      expect(routed.sessionId).toBe("root");

      // A chunk that does not match the last raw delta is never attributed to a task.
      yield* emit({
        sessionId: "root",
        type: "assistant.message_delta",
        data: { deltaContent: "one", parentToolCallId: "task-1" },
      });
      const mismatched = routing.normalizeSessionUpdate(messageChunk("root", "two"));
      expect(mismatched.sessionId).toBe("root");
    }),
  );

  it.effect("finishes the subagent and stops routing to it when it completes", () =>
    Effect.gen(function* () {
      const { routing, finished, register, emit } = registerRouting();
      yield* register;

      yield* emit({
        sessionId: "root",
        type: "subagent.started",
        agentId: "agent-1",
        data: { toolCallId: "task-1" },
      });
      yield* emit({
        sessionId: "root",
        type: "subagent.failed",
        agentId: "agent-1",
        data: { toolCallId: "task-1", error: "boom" },
      });

      expect(finished).toEqual([
        {
          sessionId: "root",
          childSessionId: "copilot-task:task-1",
          status: "failed",
          result: "boom",
        },
      ]);

      const afterwards = routing.normalizeSessionUpdate(
        sessionUpdate("root", {
          sessionUpdate: "tool_call",
          toolCallId: "tool-2",
          title: "Read",
          _meta: { "github.com/copilot": { agentId: "agent-1" } },
        }),
      );
      expect(afterwards.sessionId).toBe("root");
    }),
  );
});
