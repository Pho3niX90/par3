import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";
import * as AcpErrors from "effect-acp/errors";
import type { AcpSessionRuntimeOptions } from "./AcpSessionRuntime.ts";
import type { AcpToolCallState } from "./runtimeModel.ts";
import type {
  AcpAdapterV2ExtensionContext,
  AcpAdapterV2Flavor,
  AcpAdapterV2SubagentUpdate,
} from "./adapter.ts";

// The opt-in raw feed identifies each chunk by the preceding assistant.*_delta task call id.

const COPILOT_META_KEY = "github.com/copilot";
const COPILOT_SESSION_EVENT = "github.com/copilot/sessionEvent";

export const copilotClientCapabilitiesMeta = {
  [COPILOT_META_KEY]: {
    events: [
      "subagent.started",
      "subagent.completed",
      "subagent.failed",
      "assistant.message_delta",
      "assistant.reasoning_delta",
      "session.compaction_complete",
    ],
  },
};

const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);

/** Copilot keeps failing every prompt with these until its process is replaced. */
const COPILOT_LOST_SESSION_MARKERS = [
  "session event delivery failed: session not found: ",
  "session lock unavailable during is_session_generation_current: acquisition timed out",
];

// Copilot CLI 1.0.110 rejects a prompt for a session it does not have with -32602.
const COPILOT_UNKNOWN_SESSION = /^Session \S+ not found$/;

export function isCopilotLostSessionError(error: unknown): boolean {
  if (!isAcpRequestError(error) || error.method !== "session/prompt") return false;
  if (error.code === -32602) return COPILOT_UNKNOWN_SESSION.test(error.errorMessage);
  if (error.code !== -32603) return false;
  // Older Copilot reports the cause in data.details; its native ACP layer (1.0.105) in the message.
  return [error.errorMessage, record(error.data)?.details].some(
    (text) =>
      typeof text === "string" &&
      COPILOT_LOST_SESSION_MARKERS.some((marker) => text.includes(marker)),
  );
}

const CopilotSessionEvent = Schema.Struct({
  sessionId: Schema.String,
  type: Schema.String,
  agentId: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const childSessionId = (taskToolCallId: string) => `copilot-task:${taskToolCallId}`;

interface CopilotSessionAttribution {
  delta: { readonly kind: string; readonly text: string; readonly task?: string } | undefined;
  readonly taskByAgentId: Map<string, string>;
}

export function makeCopilotSubagentRouting() {
  const sessions = new Map<string, CopilotSessionAttribution>();
  const session = (sessionId: string) => {
    let current = sessions.get(sessionId);
    if (current === undefined) {
      current = { delta: undefined, taskByAgentId: new Map() };
      sessions.set(sessionId, current);
    }
    return current;
  };
  const release = (sessionId: string, current: CopilotSessionAttribution) => {
    if (current.delta === undefined && current.taskByAgentId.size === 0) {
      sessions.delete(sessionId);
    }
  };

  const registerExtensions = (context: AcpAdapterV2ExtensionContext) =>
    context.runtime.handleExtNotification(COPILOT_SESSION_EVENT, CopilotSessionEvent, (event) => {
      const data = event.data ?? {};
      const task = typeof data.parentToolCallId === "string" ? data.parentToolCallId : undefined;
      switch (event.type) {
        case "assistant.message_delta":
        case "assistant.reasoning_delta": {
          if (typeof data.deltaContent !== "string") return Effect.void;
          session(event.sessionId).delta = {
            kind: event.type,
            text: data.deltaContent,
            ...(task === undefined ? {} : { task }),
          };
          return Effect.void;
        }
        case "subagent.started": {
          if (event.agentId !== undefined && typeof data.toolCallId === "string") {
            session(event.sessionId).taskByAgentId.set(event.agentId, data.toolCallId);
          }
          return Effect.void;
        }
        case "subagent.completed":
        case "subagent.failed": {
          const current = sessions.get(event.sessionId);
          if (current !== undefined && event.agentId !== undefined) {
            current.taskByAgentId.delete(event.agentId);
            release(event.sessionId, current);
          }
          if (typeof data.toolCallId !== "string") return Effect.void;
          // Background tasks end only here; their tool call settles at launch.
          return context.finishSubagent({
            sessionId: event.sessionId,
            childSessionId: childSessionId(data.toolCallId),
            status: event.type === "subagent.failed" ? "failed" : "completed",
            result: typeof data.error === "string" ? data.error : null,
          });
        }
        // Copilot sends no ACP compaction_update; agentId marks a subagent's own compaction.
        // Older Copilot builds report a successful compaction without `outcome`.
        case "session.compaction_complete": {
          if (
            event.agentId !== undefined ||
            data.success !== true ||
            (data.outcome !== undefined && data.outcome !== "applied")
          ) {
            return Effect.void;
          }
          return context.markSessionCompacted(event.sessionId);
        }
        default:
          return Effect.void;
      }
    });

  const normalizeSessionUpdate = (
    notification: AcpSchema.SessionNotification,
  ): AcpSchema.SessionNotification => {
    const update = notification.update;
    const current = sessions.get(notification.sessionId);
    if (current === undefined) return notification;
    let task: string | undefined;
    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk"
    ) {
      const delta = current.delta;
      current.delta = undefined;
      release(notification.sessionId, current);
      const kind =
        update.sessionUpdate === "agent_message_chunk"
          ? "assistant.message_delta"
          : "assistant.reasoning_delta";
      if (
        delta?.kind === kind &&
        update.content.type === "text" &&
        update.content.text === delta.text
      ) {
        task = delta.task;
      }
    } else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      const agentId = record(record(update._meta)?.[COPILOT_META_KEY])?.agentId;
      task = typeof agentId === "string" ? current.taskByAgentId.get(agentId) : undefined;
    }
    return task === undefined ? notification : { ...notification, sessionId: childSessionId(task) };
  };

  return { registerExtensions, normalizeSessionUpdate };
}

/**
 * Copilot answers `session/load` right after replaying, but can go quiet for longer first: 3.5 s
 * on a healthy reload, 30 s before a load that fails. Waiting for its answer keeps Par3 from
 * adopting a session Copilot never opened.
 */
export const copilotSessionRuntimeOptions = {
  sessionLoadReplayIdleGap: Duration.infinity,
} satisfies Pick<AcpSessionRuntimeOptions, "sessionLoadReplayIdleGap">;

/**
 * Copilot states its limits as plain text, so whole phrases are matched. Bare status numbers are
 * left out on purpose: request ids and ports contain them.
 */
export const COPILOT_USAGE_LIMIT_MESSAGE =
  /\b(?:rate[\s-]?limit(?:ed)?|too many requests|quota (?:exceeded|exhausted)|(?:insufficient|no) quota|usage limit|payment required)\b/i;

// Copilot CLI 1.0.110 streams its model-request retries and a failed run as reply chunks of their
// own, then ends the prompt with `end_turn`.
const COPILOT_RETRY_NOTICE = /^Info: [^\n]*Retrying\.\.\.$/;
const COPILOT_RUN_FAILED_NOTICE = /^Error: (Execution failed: [\s\S]+)$/;

/** Keeps Copilot's retry and failure notices out of the reply, and fails the turn they end. */
export function makeCopilotNoticeFilter(): Required<
  Pick<AcpAdapterV2Flavor, "ignoreSessionUpdate" | "watchPromptOutcome">
> {
  const failures = new Map<string, string>();
  return {
    ignoreSessionUpdate: (notification) => {
      const update = notification.update;
      if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
        return false;
      }
      if (COPILOT_RETRY_NOTICE.test(update.content.text)) return true;
      const failure = COPILOT_RUN_FAILED_NOTICE.exec(update.content.text)?.[1];
      if (failure === undefined) return false;
      failures.set(notification.sessionId, failure);
      return true;
    },
    watchPromptOutcome: (sessionId) =>
      Effect.sync(() => {
        failures.delete(sessionId);
        return () =>
          Effect.sync(() => {
            const message = failures.get(sessionId);
            failures.delete(sessionId);
            return message === undefined
              ? undefined
              : makeProviderFailure({
                  message,
                  class: COPILOT_USAGE_LIMIT_MESSAGE.test(message)
                    ? "usage_limit"
                    : "provider_error",
                });
          });
      }),
  };
}

export function extractCopilotSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  const input = record(tool.data.rawInput);
  if (typeof input?.agent_type !== "string" || typeof input.prompt !== "string") return undefined;
  const output = record(tool.data.rawOutput)?.content;
  const background = input.mode === "background";
  const status =
    tool.status === "failed"
      ? "failed"
      : tool.status === "completed" && !background
        ? "completed"
        : "running";
  return {
    nativeTaskId: tool.toolCallId,
    childSessionId: childSessionId(tool.toolCallId),
    prompt: input.prompt,
    title: typeof input.description === "string" ? input.description : null,
    model: typeof input.model === "string" ? input.model : null,
    status,
    result: status !== "running" && typeof output === "string" ? output : null,
  };
}
