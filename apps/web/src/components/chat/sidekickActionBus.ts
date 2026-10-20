import type { ModelSelection } from "@t3tools/contracts";

const SIDEKICK_CHANGE_EVENT = "t3:sidekick-change";

/** Lets surfaces outside the composer, such as the command palette, set the active thread's sidekick. */
export function requestSidekickChange(selection: ModelSelection | null): void {
  window.dispatchEvent(new CustomEvent(SIDEKICK_CHANGE_EVENT, { detail: selection }));
}

export function subscribeSidekickChange(
  listener: (selection: ModelSelection | null) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<ModelSelection | null>).detail);
  };
  window.addEventListener(SIDEKICK_CHANGE_EVENT, handler);
  return () => window.removeEventListener(SIDEKICK_CHANGE_EVENT, handler);
}
