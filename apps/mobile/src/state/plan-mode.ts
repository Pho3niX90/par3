import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ProviderInteractionMode,
  type ServerProvider,
} from "@t3tools/contracts";

type InteractionModeProvider = Pick<ServerProvider, "showInteractionModeToggle">;

export function resolveProviderInteractionMode(
  provider: InteractionModeProvider | null | undefined,
  interactionMode: ProviderInteractionMode | null | undefined,
): ProviderInteractionMode {
  return provider?.showInteractionModeToggle === false
    ? DEFAULT_PROVIDER_INTERACTION_MODE
    : (interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE);
}

/** Plan mode is on by default; it stays hidden until the preference has loaded. */
export function resolvePlanModeEnabled(input: {
  readonly loaded: boolean;
  readonly preference: boolean | undefined;
}): boolean {
  return input.loaded && input.preference !== false;
}

/** The mode an existing thread's next send uses. Matches web: off means build mode. */
export function resolveThreadInteractionMode(input: {
  readonly provider: InteractionModeProvider | null | undefined;
  readonly preferenceLoaded: boolean;
  readonly planModeEnabled: boolean;
  readonly draftInteractionMode: ProviderInteractionMode | null | undefined;
  readonly threadInteractionMode: ProviderInteractionMode;
}): ProviderInteractionMode {
  if (input.provider?.showInteractionModeToggle === false) {
    return DEFAULT_PROVIDER_INTERACTION_MODE;
  }
  // Until the preference loads, keep the thread's mode instead of sending a change either way.
  if (!input.preferenceLoaded) return input.threadInteractionMode;
  if (!input.planModeEnabled) return DEFAULT_PROVIDER_INTERACTION_MODE;
  return input.draftInteractionMode ?? input.threadInteractionMode;
}

export function resolvePendingTaskInteractionMode(input: {
  readonly planModeEnabled: boolean;
  readonly draftInteractionMode: ProviderInteractionMode | undefined;
  readonly provider?: InteractionModeProvider | null;
}): ProviderInteractionMode {
  if (input.provider?.showInteractionModeToggle === false || !input.planModeEnabled) {
    return DEFAULT_PROVIDER_INTERACTION_MODE;
  }
  return input.draftInteractionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
}
