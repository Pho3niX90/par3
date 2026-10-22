import {
  MergeConflictAutoResolveInput,
  MergeConflictAutoResolveResult,
  MergeConflictListResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as MergeConflictService from "../../../vcs/MergeConflictService.ts";
import * as ThreadRepositories from "../../../vcs/ThreadRepositories.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  ThreadRepositories.ThreadRepositories,
  MergeConflictService.MergeConflictService,
];

const RepositoryParameter = Schema.optional(Schema.String).annotate({
  description:
    "Which of this thread's repositories to act on: its absolute path, or its path relative to the thread's folder. Omit it when the thread works in a single repository; the error for a folder that holds several lists them.",
});

const ConflictsStatusResult = Schema.Struct({
  /** The repository the result is about. */
  repository: Schema.String,
  /** Every repository this thread can address, as absolute paths. */
  repositories: Schema.Array(Schema.String),
  ...MergeConflictListResult.fields,
});

const ConflictsAutoResolveResult = Schema.Struct({
  repository: Schema.String,
  ...MergeConflictAutoResolveResult.fields,
});

const ConflictsAutoResolveParameters = Schema.Struct({
  repository: RepositoryParameter,
  paths: MergeConflictAutoResolveInput.fields.paths,
});

const ConflictsStatusTool = Tool.make("t3_conflicts_status", {
  description:
    "Needs an agent running inside a Par3 thread. Report the merge, rebase, cherry-pick or revert in progress in this thread's repository: its kind, the rebase step, what 'ours' and 'theirs' are, and every conflicted file with its kind (both-modified, deleted-by-us, ...) and whether it can only be resolved by choosing a side. During a rebase git swaps the sides: 'ours' is the branch being rebased onto and 'theirs' is your commit being replayed. Call this first when asked to resolve conflicts. Then run t3_conflicts_auto_resolve before editing any file by hand; edit only what it leaves, remove the conflict markers, and stage each file with `git add`. Do not continue, commit or abort the operation unless the user asked you to.",
  parameters: Schema.Struct({ repository: RepositoryParameter }),
  success: ConflictsStatusResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get merge conflict status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ConflictsAutoResolveTool = Tool.make("t3_conflicts_auto_resolve", {
  description:
    "Needs an agent running inside a Par3 thread. Resolve the conflicts in this thread's repository that need no judgment: it merges each conflicted text file again word by word and, for every file that then has no conflict left, writes the result and stages it. Files that still conflict, binary or filtered files, files with a custom merge driver, and files already edited by hand are left alone and listed as skipped with the reason. Use it before resolving anything by hand, then resolve the skipped files yourself and stage them with `git add`. It never continues, commits or aborts the operation; do not do that either unless the user asked you to. Pass paths to limit it to some files.",
  parameters: ConflictsAutoResolveParameters,
  success: ConflictsAutoResolveResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Auto-resolve simple merge conflicts")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ConflictsToolkit = Toolkit.make(ConflictsStatusTool, ConflictsAutoResolveTool);
