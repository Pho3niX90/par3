import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as AcpSchema from "effect-acp/compat";
import * as AcpErrors from "effect-acp/errors";

import type { AcpAdapterV2ExtensionContext } from "./adapter.ts";
import {
  extractCopilotSubagentUpdate,
  isCopilotLostSessionError,
  makeCopilotNoticeFilter,
  makeCopilotSubagentRouting,
} from "./copilotAcp.ts";
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

describe("makeCopilotNoticeFilter", () => {
  const retry = "Info: Response was interrupted due to a server error. Retrying...";
  const runFailed = (lastError: string) =>
    `Error: Execution failed: Failed to get response from the AI model; retried 5 times (total retry wait time: 23.00 seconds) Last error: ${lastError}`;
  const proxyRefused =
    "Failed native model HTTP request: error sending request for url (https://api.individual.githubcopilot.com/responses): client error (Connect): tunnel error: proxy authorization required: proxy CONNECT failed with status 407 Proxy Authentication Required";
  const endTurn = { stopReason: "end_turn" } as const;

  it.effect("keeps retry notices out of the reply and leaves ordinary text alone", () =>
    Effect.gen(function* () {
      const notices = makeCopilotNoticeFilter();
      const check = yield* notices.watchPromptOutcome("s1");
      expect(notices.ignoreSessionUpdate(messageChunk("s1", retry))).toBe(true);
      for (const text of [
        "Confirmed. Approving #110.",
        "Info: see the README.",
        "Error: missing",
      ]) {
        expect(notices.ignoreSessionUpdate(messageChunk("s1", text))).toBe(false);
      }
      expect(yield* check(endTurn)).toBeUndefined();
    }),
  );

  it.effect("fails the prompt a failed-run notice ended, and only that prompt", () =>
    Effect.gen(function* () {
      const notices = makeCopilotNoticeFilter();
      const failed = yield* notices.watchPromptOutcome("s1");
      const other = yield* notices.watchPromptOutcome("s2");
      expect(notices.ignoreSessionUpdate(messageChunk("s1", runFailed(proxyRefused)))).toBe(true);
      expect(yield* other(endTurn)).toBeUndefined();
      const failure = yield* failed(endTurn);
      expect(failure?.class).toBe("provider_error");
      expect(failure?.message).toBe(runFailed(proxyRefused).slice("Error: ".length));
      expect(yield* (yield* notices.watchPromptOutcome("s1"))(endTurn)).toBeUndefined();
    }),
  );

  it.effect("reports a failed run that hit a rate limit as a usage limit", () =>
    Effect.gen(function* () {
      const notices = makeCopilotNoticeFilter();
      const check = yield* notices.watchPromptOutcome("s1");
      notices.ignoreSessionUpdate(messageChunk("s1", runFailed("429 Too Many Requests")));
      expect((yield* check(endTurn))?.class).toBe("usage_limit");
    }),
  );
});

describe("isCopilotLostSessionError", () => {
  const promptError = (code: number, errorMessage: string) =>
    new AcpErrors.AcpRequestError({ code, errorMessage, method: "session/prompt" });

  it("recognizes a prompt to a session Copilot does not have", () => {
    expect(
      isCopilotLostSessionError(
        promptError(-32602, "Session d7d8a9f3-ed43-4aa4-ab81-9b4bf6625f4d not found"),
      ),
    ).toBe(true);
    expect(isCopilotLostSessionError(promptError(-32602, "Invalid params: prompt"))).toBe(false);
    expect(
      isCopilotLostSessionError(
        new AcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: "Session d7d8a9f3 not found",
          method: "session/set_model",
        }),
      ),
    ).toBe(false);
  });
});
