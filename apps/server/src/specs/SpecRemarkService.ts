import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  SpecError,
  specRoleSupported,
  type SpecMutationInput,
  type SpecMutationResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SpecService from "./SpecService.ts";

const failure = (reason: SpecError["reason"], message: string) =>
  new SpecError({ reason, message });

/**
 * Remark actions that open a thread. The ledger bookkeeping lives in `SpecService`; this service
 * exists because launching a thread depends on `SpecService`, so `SpecService` cannot launch one.
 */
export class SpecRemarkService extends Context.Service<
  SpecRemarkService,
  {
    /**
     * `specs.mutate` with the actions that need more than the spec's own record. A `remarks-send`
     * opens a new requirements thread, bound to the spec before its first turn, whose first
     * message asks the agent to process the document's open remarks; they become `submitted` once
     * the thread exists. The thread starts in the spec's own checkout, so worktrees work.
     * Everything else is `SpecService.mutate`.
     */
    readonly mutate: (
      input: SpecMutationInput,
      caller: SpecService.SpecCaller,
    ) => Effect.Effect<SpecMutationResult, SpecError>;
  }
>()("t3/specs/SpecRemarkService") {}

const make = Effect.gen(function* () {
  const specs = yield* SpecService.SpecService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const db = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(() => failure("io", "Could not read the project.")));

  const send = Effect.fn("SpecRemarkService.send")(function* (
    input: Extract<SpecMutationInput, { action: "remarks-send" }>,
    caller: SpecService.SpecCaller,
  ) {
    const plan = yield* specs.prepareRemarksSend(input, caller);
    const project = yield* db(projects.get(input.projectId));
    if (Option.isNone(project) || project.value.deletedAt)
      return yield* failure("not-found", "Project not found.");

    // The project's default model starts the thread; without one, the model of the thread the
    // person is working in.
    const viewing = input.threadId
      ? (yield* db(projections.getThreadRecords(input.threadId, ["runs"]))).thread
      : undefined;
    const modelSelection = project.value.defaultModelSelection ?? viewing?.modelSelection;
    if (!modelSelection)
      return yield* failure(
        "invalid",
        "Choose a default model for this project, then send the remarks again.",
      );
    const driver = (yield* providers.getProviders).find(
      (provider) => provider.instanceId === modelSelection.instanceId,
    )?.driver;
    if (driver !== undefined && !specRoleSupported(driver, "requirements"))
      return yield* failure(
        "unsupported-provider",
        "Processing remarks needs Codex or Claude. Choose one as the project's default model.",
      );
    yield* specs.assertIntakeAllowed({
      projectId: input.projectId,
      ...(driver === undefined ? {} : { driver }),
    });

    // The thread starts in the checkout that holds the spec; the project root needs no strategy.
    const workspaceStrategy =
      plan.workspace === project.value.workspaceRoot
        ? ({ type: "root" } as const)
        : ({
            type: "existing_worktree",
            worktreePath: plan.workspace,
            ...(viewing?.branch ? { branch: viewing.branch } : {}),
          } as const);

    const launched = yield* launches
      .launch({
        commandId: CommandId.make(input.commandId),
        projectId: input.projectId,
        title: `Remarks: ${input.slug}`,
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy,
        initialMessage: { text: plan.prompt, attachments: [] },
        specBinding: { slug: input.slug, role: "requirements" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError((cause) =>
          failure(
            "io",
            cause._tag === "ThreadLaunchError" &&
              cause.operation === "spec-intake" &&
              cause.cause instanceof Error
              ? cause.cause.message
              : "Could not start the thread that processes the remarks.",
          ),
        ),
      );
    yield* specs.commitRemarksSend(plan);
    return {
      ...(yield* specs.read(input)),
      sent: { threadId: launched.threadId, ids: plan.ids, resent: plan.resent },
    } satisfies SpecMutationResult;
  });

  const mutate = (input: SpecMutationInput, caller: SpecService.SpecCaller) => {
    switch (input.action) {
      case "remarks-send":
        return send(input, caller);
      case "remark-add":
      case "remark-delete":
        return specs
          .remark(input, caller)
          .pipe(
            Effect.flatMap((remark) =>
              specs.read(input).pipe(Effect.map((document) => ({ ...document, remark }))),
            ),
          );
      default:
        return specs.mutate(input, caller);
    }
  };

  return SpecRemarkService.of({ mutate });
});

export const layer = Layer.effect(SpecRemarkService, make);

/** For harnesses that never open threads for specs. */
export const layerDisabled = Layer.succeed(
  SpecRemarkService,
  SpecRemarkService.of({
    mutate: () => Effect.fail(failure("disabled", "Spec mode is unavailable.")),
  }),
);
