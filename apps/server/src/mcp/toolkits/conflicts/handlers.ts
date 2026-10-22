import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Project from "../../../project/ProjectService.ts";
import * as MergeConflictService from "../../../vcs/MergeConflictService.ts";
import * as ThreadRepositories from "../../../vcs/ThreadRepositories.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import { ConflictsToolkit } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");

/**
 * The repository a call may touch. Only the thread's own folder and the repositories it edited
 * are reachable, so a path the model makes up cannot point the tool anywhere else.
 */
const resolveRepository = Effect.fn("ConflictsToolkit.resolveRepository")(function* (
  requested: string | undefined,
) {
  const context = yield* McpInvocationContext.McpInvocationContext;
  if (!context.capabilities.has("worktree")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot inspect or change the repository.",
    });
  }
  const {
    projection: { thread },
  } = yield* readThread();
  const projects = yield* Project.ProjectService;
  const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) return yield* invalid("The project was not found.");
  const threadFolder = thread.worktreePath ?? project.value.workspaceRoot;
  const children = yield* (yield* ThreadRepositories.ThreadRepositories)
    .list({ threadId: thread.id })
    .pipe(Effect.mapError(unavailable));

  const addressable = [
    { cwd: threadFolder, aliases: [threadFolder, "."] },
    ...children.repositories.map((repository) => ({
      cwd: repository.cwd,
      aliases: [repository.cwd, repository.relativePath],
    })),
  ];
  const repositories = addressable.map((entry) => entry.cwd);
  if (requested === undefined) {
    if (children.repositories.length === 0) return { repository: threadFolder, repositories };
    if (children.repositories.length === 1) {
      return { repository: children.repositories[0]!.cwd, repositories };
    }
    return yield* invalid(
      `This thread works in several repositories; pass repository as one of: ${repositories.join(", ")}`,
    );
  }
  const match = addressable.find((entry) =>
    entry.aliases.some((alias) => normalize(alias) === normalize(requested)),
  );
  if (match === undefined) {
    return yield* invalid(
      `That is not one of this thread's repositories. Use one of: ${repositories.join(", ")}`,
    );
  }
  return { repository: match.cwd, repositories };
});

/** Operation errors carry wording written for the reader; git and process errors carry paths. */
const failure = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error._tag === "MergeConflictError" || error._tag === "MergeConflictStaleError") &&
  "detail" in error &&
  typeof error.detail === "string"
    ? invalid(error.detail)
    : unavailable();

const handlers = {
  t3_conflicts_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { repository, repositories } = yield* resolveRepository(input.repository);
      const conflicts = yield* MergeConflictService.MergeConflictService;
      const list = yield* conflicts.list({ cwd: repository }).pipe(Effect.mapError(failure));
      return { repository, repositories, ...list };
    }),
  ),
  t3_conflicts_auto_resolve: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { repository } = yield* resolveRepository(input.repository);
      const conflicts = yield* MergeConflictService.MergeConflictService;
      const result = yield* conflicts
        .autoResolve({
          cwd: repository,
          ...(input.paths === undefined ? {} : { paths: input.paths }),
        })
        .pipe(Effect.mapError(failure));
      return { repository, ...result };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ConflictsToolkit.tools>;

export const layer = McpToolAccess.toLayer(ConflictsToolkit, handlers);
