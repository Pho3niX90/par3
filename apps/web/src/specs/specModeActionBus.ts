let handler: (() => void) | null = null;

/** The visible Spec button claims the toggle; without one, callers fall back to the Specs page. */
export function registerSpecModeToggleHandler(next: () => void): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** Returns false when no Spec button is on screen to handle the toggle. */
export function requestSpecModeToggle(): boolean {
  if (handler === null) return false;
  handler();
  return true;
}
