import type { ModelSelection, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

/** What a thread was last sent with in a project; seeds the next new thread there. */
export interface LastUsedThreadSelection {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export type LastUsedThreadSelectionByProjectKey = Readonly<Record<string, LastUsedThreadSelection>>;

// Keys are logical project keys, which outlive deleted projects; cap the map so storage cannot grow forever.
export const MAX_LAST_USED_PROJECTS = 100;

function sameSelection(left: LastUsedThreadSelection, right: LastUsedThreadSelection): boolean {
  return (
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    JSON.stringify(left.modelSelection) === JSON.stringify(right.modelSelection)
  );
}

/**
 * Returns the same reference when nothing changed so stores can skip a write.
 * The most recently sent project is kept last, so trimming drops the stalest.
 */
export function recordLastUsedThreadSelection(
  current: LastUsedThreadSelectionByProjectKey,
  projectKey: string,
  selection: LastUsedThreadSelection,
): LastUsedThreadSelectionByProjectKey {
  if (projectKey.length === 0) {
    return current;
  }
  const keys = Object.keys(current);
  const existing = current[projectKey];
  if (existing && keys[keys.length - 1] === projectKey && sameSelection(existing, selection)) {
    return current;
  }
  const { [projectKey]: _replaced, ...others } = current;
  const next: Record<string, LastUsedThreadSelection> = { ...others, [projectKey]: selection };
  const overflow = Object.keys(next).length - MAX_LAST_USED_PROJECTS;
  if (overflow > 0) {
    for (const key of Object.keys(next).slice(0, overflow)) {
      delete next[key];
    }
  }
  return next;
}

/** Where a resolved project setting came from; only "environment" is a global fallback. */
type SettingSource = "environment" | "project" | "t3.json";

/**
 * Last-used selection beats the environment-wide defaults (which are always
 * present, so they would otherwise win forever) but not a default the user
 * set for this project on purpose.
 */
export function resolveNewThreadSeed(input: {
  readonly lastUsed: LastUsedThreadSelection | null | undefined;
  readonly defaultModelSelection: ModelSelection | null;
  readonly defaultModelSelectionSource: SettingSource;
  readonly defaultRuntimeMode: RuntimeMode;
  readonly defaultRuntimeModeSource: SettingSource;
}): {
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | null;
} {
  const { lastUsed } = input;
  return {
    modelSelection:
      input.defaultModelSelection && input.defaultModelSelectionSource !== "environment"
        ? input.defaultModelSelection
        : (lastUsed?.modelSelection ?? input.defaultModelSelection),
    runtimeMode:
      input.defaultRuntimeModeSource !== "environment"
        ? input.defaultRuntimeMode
        : (lastUsed?.runtimeMode ?? input.defaultRuntimeMode),
    interactionMode: lastUsed?.interactionMode ?? null,
  };
}
