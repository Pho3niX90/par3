import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolvePlanModeEnabled } from "../../state/plan-mode";

export function usePlanModeState(): { readonly enabled: boolean; readonly loaded: boolean } {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  return {
    enabled: resolvePlanModeEnabled({
      loaded,
      preference: loaded ? preferences.value.composerPlanModeEnabled : undefined,
    }),
    loaded,
  };
}
