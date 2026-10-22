import { specRoleSupported, type SpecIntake, type SpecRole } from "@t3tools/contracts";

/**
 * What a composer's next message starts. Plan is a provider interaction mode; Spec is not, so it
 * is kept beside the interaction mode rather than as a third value of it.
 */
export type ComposerMode = "build" | "plan" | "spec";

export interface ComposerModeFlags {
  readonly interactionMode: "default" | "plan";
  readonly specIntake: boolean;
}

export function composerModeOf(flags: ComposerModeFlags): ComposerMode {
  if (flags.specIntake) return "spec";
  return flags.interactionMode === "plan" ? "plan" : "build";
}

export function composerModeFlags(mode: ComposerMode): ComposerModeFlags {
  return { interactionMode: mode === "plan" ? "plan" : "default", specIntake: mode === "spec" };
}

/** Plan and Spec exclude each other, so each toggle leaves the other for Build only by toggling off. */
export function togglePlanMode(mode: ComposerMode): ComposerMode {
  return mode === "plan" ? "build" : "plan";
}

export function toggleSpecMode(mode: ComposerMode): ComposerMode {
  return mode === "spec" ? "build" : "spec";
}

const DRIVER_LABELS: Record<string, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  antigravity: "Antigravity",
};

/** Why a provider cannot run a spec role, or null when it can. */
export function specRoleRefusal(driver: string | null, role: SpecRole): string | null {
  if (driver === null) return "Choose a provider before binding this thread to a spec.";
  if (specRoleSupported(driver, role)) return null;
  const label = DRIVER_LABELS[driver] ?? driver;
  return `The ${role} role needs Codex or Claude. ${label} supports the implementation and test roles only.`;
}

function requirementsRoleRefusal(driver: string | null): string | null {
  return driver === null
    ? "Choose a provider before using Spec mode."
    : specRoleRefusal(driver, "requirements");
}

export type SpecChoice =
  | { readonly kind: "hidden" }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "available" };

export const SPEC_CHOICE_NO_PERMISSION = "You don't have permission to start specs here.";

/**
 * Spec is offered where Spec mode is on and the thread has no spec yet. It is shown but disabled
 * when the person or the provider cannot start one, so the reason is visible.
 */
export function resolveSpecChoice(input: {
  readonly specModeEnabled: boolean;
  /** The thread already follows a spec; its spec banner carries that state. */
  readonly threadBound: boolean;
  readonly driver: string | null;
  readonly canMutate: boolean;
}): SpecChoice {
  if (!input.specModeEnabled || input.threadBound) return { kind: "hidden" };
  if (!input.canMutate) return { kind: "disabled", reason: SPEC_CHOICE_NO_PERMISSION };
  const refusal = requirementsRoleRefusal(input.driver);
  return refusal === null ? { kind: "available" } : { kind: "disabled", reason: refusal };
}

/** The mode a send uses: a requested mode the composer cannot offer falls back to Build. */
export function resolveComposerMode(input: {
  readonly requested: ComposerMode;
  readonly planAvailable: boolean;
  readonly spec: SpecChoice;
}): ComposerMode {
  if (input.requested === "plan") return input.planAvailable ? "plan" : "build";
  if (input.requested === "spec") return input.spec.kind === "available" ? "spec" : "build";
  return "build";
}

export const SPEC_MULTIPLE_MODELS_REFUSAL =
  "Spec mode starts one thread. Switch to Build or Plan, or choose a single model.";

export type SpecSendPath =
  /** Not in Spec mode. */
  | { readonly kind: "none" }
  /** The first send creates the thread; it carries `bootstrap.specIntake`. */
  | { readonly kind: "launch" }
  /** The thread exists: mark its intake, then send. */
  | { readonly kind: "mark-then-send" }
  | { readonly kind: "refused"; readonly message: string };

export function resolveSpecSendPath(input: {
  readonly mode: ComposerMode;
  /** The send builds a launch bootstrap (a draft's first send, or a worktree launch). */
  readonly launchesThread: boolean;
  readonly multipleModels: boolean;
}): SpecSendPath {
  if (input.mode !== "spec") return { kind: "none" };
  if (input.multipleModels) return { kind: "refused", message: SPEC_MULTIPLE_MODELS_REFUSAL };
  return input.launchesThread ? { kind: "launch" } : { kind: "mark-then-send" };
}

export interface PendingIntakeBanner {
  readonly title: string;
  readonly description: string;
  /** Why Cancel is unavailable, or null when it can be used. */
  readonly cancelDisabledReason: string | null;
}

export function pendingIntakeBanner(input: {
  readonly intake: SpecIntake;
  readonly threadRunning: boolean;
  readonly canMutate: boolean;
}): PendingIntakeBanner {
  return {
    title: "Drafting a new spec",
    description: "The agent turns your message into a spec and names it. Cancel to stop.",
    cancelDisabledReason: !input.canMutate
      ? SPEC_CHOICE_NO_PERMISSION
      : input.threadRunning
        ? "Wait for the agent to finish or stop the thread first."
        : null,
  };
}
