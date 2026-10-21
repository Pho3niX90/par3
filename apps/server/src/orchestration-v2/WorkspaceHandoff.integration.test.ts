import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("claudeAgent");
const providerInstanceId = ProviderInstanceId.make("claude-handoff-workspace-test");
const selection = {
  instanceId: providerInstanceId,
  model: "handoff-model",
} satisfies ModelSelection;
// Claude runs one provider thread per session, so a workspace change releases it.
const exclusiveCapabilities: OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};

// The first turn never finishes on its own, like a turn blocked in a tool call
// that is about to hand off; later turns complete immediately.
function makeAdapter(
  startedCwds: Ref.Ref<ReadonlyArray<string | null>>,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: providerInstanceId,
    driver,
    getCapabilities: () => Effect.succeed(exclusiveCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        return {
          instanceId: providerInstanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver,
            providerInstanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
            model: sessionInput.modelSelection.model,
            capabilities: exclusiveCapabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                driver,
                providerInstanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              const previousStarts = yield* Ref.getAndUpdate(startedCwds, (current) => [
                ...current,
                input.runtimePolicy.cwd,
              ]);
              const occurredAt = yield* DateTime.now;
              const completes = previousStarts.length > 0;
              const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${providerTurnId}`,
                    strength: "strong",
                  },
                  ordinal: input.providerTurnOrdinal,
                  status: completes ? "completed" : "running",
                  startedAt: occurredAt,
                  completedAt: completes ? occurredAt : null,
                },
              });
              if (!completes) return;
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: input.providerThread.id,
                providerTurnId,
                runOrdinal: input.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

it.live(
  "starts the queued continuation after a workspace handoff releases the active session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("workspace-handoff-continuation");
        const worktreeCwd = yield* checkpointWorkspace("workspace-handoff-continuation-worktree");
        const threadId = ThreadId.make("thread:workspace-handoff-continuation");
        const startedCwds = yield* Ref.make<ReadonlyArray<string | null>>([]);
        const layerRegistry = ProviderAdapterRegistry.layerSingle(makeAdapter(startedCwds));

        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;

          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:workspace-handoff:create"),
            threadId,
            projectId: ProjectId.make("project:workspace-handoff"),
            title: "Workspace handoff",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          const running = yield* eventSink
            .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
            .pipe(
              Stream.map((stored) => stored.event),
              Stream.filter(
                (event) =>
                  event.type === "provider-turn.updated" && event.payload.status === "running",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:workspace-handoff:first"),
            threadId,
            messageId: MessageId.make("message:workspace-handoff:first"),
            text: "first",
            attachments: [],
            modelSelection: selection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* Fiber.join(running);
          yield* worker.drain();

          // The handoff tool queues the continuation, then binds the worktree.
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make("command:workspace-handoff:continuation"),
            threadId,
            messageId: MessageId.make("message:workspace-handoff:continuation"),
            text: "continue in the worktree",
            attachments: [],
            modelSelection: selection,
            dispatchMode: { type: "queue_after_active" },
          });
          const continued = yield* eventSink
            .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
            .pipe(
              Stream.map((stored) => stored.event),
              Stream.filter(
                (event) =>
                  event.type === "run.updated" &&
                  (event.payload.status === "completed" || event.payload.status === "failed") &&
                  event.payload.userMessageId ===
                    MessageId.make("message:workspace-handoff:continuation"),
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.timeout("10 seconds"),
              Effect.forkScoped,
            );
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("command:workspace-handoff:bind"),
            threadId,
            branch: "handoff-branch",
            worktreePath: worktreeCwd,
            expectedWorktreePath: cwd,
          });
          yield* worker.drain();
          yield* Fiber.join(continued);
          yield* worker.drain();
          return yield* orchestrator.getThreadProjection(threadId);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "workspace-handoff-continuation" },
              layerRegistry,
            ),
          ),
        );

        const continuation = projection.runs.find(
          (run) => run.userMessageId === MessageId.make("message:workspace-handoff:continuation"),
        );
        assert.equal(projection.runs[0]?.status, "interrupted");
        assert.equal(continuation?.status, "completed");
        assert.deepEqual(yield* Ref.get(startedCwds), [cwd, worktreeCwd]);
      }),
    ),
);
