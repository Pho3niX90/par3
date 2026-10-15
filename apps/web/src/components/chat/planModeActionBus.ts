const PLAN_MODE_TOGGLE_EVENT = "t3:plan-mode-toggle";

/** Lets surfaces outside the composer, such as the command palette, flip Build/Plan. */
export function requestPlanModeToggle(): void {
  window.dispatchEvent(new Event(PLAN_MODE_TOGGLE_EVENT));
}

export function subscribePlanModeToggle(listener: () => void): () => void {
  window.addEventListener(PLAN_MODE_TOGGLE_EVENT, listener);
  return () => window.removeEventListener(PLAN_MODE_TOGGLE_EVENT, listener);
}
