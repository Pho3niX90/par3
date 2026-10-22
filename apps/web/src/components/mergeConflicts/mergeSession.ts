import { EditStateManager } from "@pierre/diffs/edit";
import type { EnvironmentId, MergeConflictReadResult } from "@t3tools/contracts";
import {
  computeMerge3,
  splitLines,
  type Merge3Lines,
  type Merge3Result,
} from "@t3tools/shared/merge3";

import { createMergeModel, MergeTimeline } from "./mergeModel";
import { MergeViewController } from "./mergeViewController";

const MAX_RETAINED_SESSIONS = 20;
/**
 * The chunk timelines of merges whose editor drafts pierre keeps. A draft is only meaningful
 * together with the history-keyed chunk states, so the two are kept and dropped together.
 */
const retainedTimelines = new Map<string, MergeTimeline<object>>();

let nextInstance = 0;

/** Identifies one file at one state of the conflict; a draft is only resumed for the same one. */
function mergeEditStateKey(
  environmentId: EnvironmentId,
  cwd: string,
  file: MergeConflictReadResult,
): string {
  const { base, ours, theirs } = file.expected.stages;
  return [
    "merge",
    environmentId,
    cwd,
    file.path,
    base ?? "-",
    ours ?? "-",
    theirs ?? "-",
    file.expected.workingCopyHash ?? "-",
  ].join("\0");
}

export interface MergeSession {
  readonly editStateKey: string;
  readonly lines: Merge3Lines;
  readonly merge: Merge3Result;
  readonly timeline: MergeTimeline<object>;
  readonly controller: MergeViewController;
}

/** One merge computation per load: the three-way merge, its chunk timeline, and the pane controller. */
export function createMergeSession(
  environmentId: EnvironmentId,
  cwd: string,
  file: MergeConflictReadResult,
): MergeSession {
  const editStateKey = mergeEditStateKey(environmentId, cwd, file);
  const input = {
    base: file.base ?? "",
    ours: file.ours ?? "",
    theirs: file.theirs ?? "",
  };
  const lines: Merge3Lines = {
    base: splitLines(input.base),
    ours: splitLines(input.ours),
    theirs: splitLines(input.theirs),
  };
  const merge = computeMerge3(input, { resolveSimple: true });
  const model = createMergeModel(lines, merge);

  const retained = EditStateManager.get("file", editStateKey);
  let timeline = retainedTimelines.get(editStateKey);
  if (retained !== undefined && timeline === undefined) {
    // A draft without its chunk states cannot be reconciled; start over rather than guess.
    EditStateManager.clear("file", editStateKey);
  }
  if (retained === undefined || timeline === undefined) {
    timeline = new MergeTimeline<object>(model);
  }
  retainedTimelines.delete(editStateKey);
  retainedTimelines.set(editStateKey, timeline);
  for (const key of retainedTimelines.keys()) {
    if (retainedTimelines.size <= MAX_RETAINED_SESSIONS) break;
    retainedTimelines.delete(key);
  }

  const controller = new MergeViewController({
    lines,
    model: timeline.model,
    id: String(nextInstance++),
  });
  return {
    editStateKey,
    lines,
    merge,
    timeline,
    controller,
  };
}

/** After a successful apply the draft has nothing left to resume. */
export function discardMergeDraft(editStateKey: string) {
  retainedTimelines.delete(editStateKey);
  // The editor releases its session when the view unmounts, which is just after this runs.
  requestAnimationFrame(() => {
    EditStateManager.clear("file", editStateKey);
  });
}
