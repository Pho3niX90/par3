// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type UserInputAttachments,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
} from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { dispatchCommand } from "./ThreadMessageIntake.ts";
import * as ThreadSidekick from "./ThreadSidekick.ts";

const layerIntakeTest = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-question-intake-",
}).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(ServerSettings.layerTest()));

const layerFailingDispatch = (captured: OrchestrationV2ServerCommand[]) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    dispatch: (command) => {
      captured.push(command);
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Stop after intake",
        }),
      );
    },
  });

const NOW = DateTime.makeUnsafe("2026-09-13T00:00:00.000Z");

const answeredRespondEvents = (input: {
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly attachmentsByQuestionId: UserInputAttachments;
}): OrchestrationV2StoredEvent[] => [
  {
    sequence: 1,
    commandId: null,
    event: {
      id: EventId.make("evt-recorded-answer"),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: NOW,
      payload: {
        id: TurnItemId.make("item-recorded-answer"),
        type: "user_input_request",
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: NOW,
        updatedAt: NOW,
        requestId: RuntimeRequestId.make(input.requestId),
        questions: [],
        questionAnswer: {
          requestId: input.requestId,
          answers: {},
          attachmentsByQuestionId: input.attachmentsByQuestionId,
        },
      },
    },
  },
];

it.effect("claims question uploads and passes readable paths through the V2 request command", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const id = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-1"),
      threadId: ThreadId.make("thread-answer"),
      requestId: RuntimeRequestId.make("request-1"),
      answers: { q: ["Selected option"] },
      attachmentsByQuestionId: {
        q: [{ type: "image", id, name: "screen.png", mimeType: "image/png", sizeBytes: 3 }],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(captured).toHaveLength(1);
    const command = captured[0]!;
    expect(command.type).toBe("runtime-request.respond");
    if (command.type !== "runtime-request.respond") return;
    const attachment = command.attachmentsByQuestionId?.q?.[0];
    expect(attachment).toBeDefined();
    const path = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: attachment!,
    });
    expect(path).not.toBeNull();
    expect(NodeFS.readFileSync(path!)).toEqual(Buffer.from([1, 2, 3]));
    expect(command.answers?.q).toEqual([
      "Selected option",
      `Attached image "screen.png": "${path}"`,
    ]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("retains claimed copies when dispatch failure may have been accepted", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-ambiguous"),
      threadId: ThreadId.make("thread-ambiguous"),
      requestId: RuntimeRequestId.make("request-ambiguous"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(result._tag).toBe("Failure");
    expect(captured).toHaveLength(1);
    const threadFiles = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
      entry.startsWith("thread-ambiguous-"),
    );
    expect(threadFiles).toHaveLength(1);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when the command was already rejected", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-rejected"),
      threadId: ThreadId.make("thread-rejected"),
      requestId: RuntimeRequestId.make("request-rejected"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (command) =>
            Effect.fail(
              new OrchestratorCommandPreviouslyRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                detail: "rejected earlier",
              }),
            ),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-rejected-"),
      ),
    ).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when dispatch replays an earlier accepted response", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-replay");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const earlierAttachment = {
      type: "image" as const,
      id: ChatAttachmentId.make("thread-replay-00000000-0000-4000-8000-0000000000aa"),
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${earlierAttachment.id}.png`),
      new Uint8Array([4, 4, 4]),
    );
    const storedEvents = answeredRespondEvents({
      threadId,
      requestId: "request-replay",
      attachmentsByQuestionId: { q: [earlierAttachment] },
    });
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-replay"),
      threadId,
      requestId: RuntimeRequestId.make("request-replay"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents }),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Success");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-replay-"),
      ),
    ).toEqual([`${earlierAttachment.id}.png`]);
    expect(
      NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${earlierAttachment.id}.png`)),
    ).toEqual(Buffer.from([4, 4, 4]));
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("a retried response re-claims the preserved pending uploads", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-retry");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    const lateId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const command: OrchestrationV2Command = {
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-retry"),
      threadId,
      requestId: RuntimeRequestId.make("request-retry"),
      answers: { q1: ["one"], q2: ["two"] },
      attachmentsByQuestionId: {
        q1: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        q2: [
          {
            type: "image",
            id: lateId,
            name: "late.png",
            mimeType: "image/png",
            sizeBytes: 2,
          },
        ],
      },
    };
    const captured: OrchestrationV2ServerCommand[] = [];
    const first = yield* dispatchCommand(command).pipe(
      Effect.provide(layerFailingDispatch(captured)),
      Effect.result,
    );
    expect(first._tag).toBe("Failure");
    expect(captured).toHaveLength(0);

    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${lateId}.png`),
      new Uint8Array([7, 7]),
    );
    const retry = yield* dispatchCommand(command).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (dispatched) => {
            captured.push(dispatched);
            return Effect.succeed({ sequence: 1, storedEvents: [] });
          },
        }),
      ),
      Effect.result,
    );
    expect(retry._tag).toBe("Success");
    const dispatched = captured[0]!;
    expect(dispatched.type).toBe("runtime-request.respond");
    if (dispatched.type !== "runtime-request.respond") return;
    for (const attachment of [
      ...(dispatched.attachmentsByQuestionId?.q1 ?? []),
      ...(dispatched.attachmentsByQuestionId?.q2 ?? []),
    ]) {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      expect(path).not.toBeNull();
      expect(NodeFS.existsSync(path!)).toBe(true);
    }
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-retry-"),
      ),
    ).toHaveLength(2);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("accepts a sidekick matching the stored lead while the composer's lead is unsent", () => {
  const codex = ProviderInstanceId.make("codex");
  const storedLead = { instanceId: codex, model: "gpt-6.1-sol" };
  const threadId = ThreadId.make("thread:sidekick-stored-lead");
  const captured: OrchestrationV2ServerCommand[] = [];
  return dispatchCommand({
    type: "thread.sidekick.set",
    commandId: CommandId.make("set-sidekick-stored-lead"),
    threadId,
    sidekickModelSelection: storedLead,
  }).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error).toBeInstanceOf(OrchestratorDispatchError);
        expect(captured.map((command) => command.type)).toEqual(["thread.sidekick.set"]);
      }),
    ),
    Effect.provide(
      ThreadSidekick.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([
                {
                  instanceId: codex,
                  driver: ProviderDriverKind.make("codex"),
                  enabled: true,
                  installed: true,
                  version: "test",
                  status: "ready",
                  auth: { status: "authenticated" },
                  checkedAt: "2026-11-03T00:00:00.000Z",
                  models: [
                    { slug: storedLead.model, name: "Sol", isCustom: false, capabilities: null },
                  ],
                  slashCommands: [],
                  skills: [],
                },
              ]),
            }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([codex]),
            }),
            layerIntakeTest,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    projectId: ProjectId.make("project:sidekick-stored-lead"),
                    modelSelection: storedLead,
                  },
                } as never),
              dispatch: (command) => {
                captured.push(command);
                return Effect.fail(
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: "Stop after intake",
                  }),
                );
              },
            }),
          ),
        ),
      ),
    ),
  );
});
