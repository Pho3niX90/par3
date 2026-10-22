import { describe, expect, it } from "@effect/vitest";

import {
  composerModeFlags,
  composerModeOf,
  pendingIntakeBanner,
  resolveComposerMode,
  resolveSpecChoice,
  resolveSpecSendPath,
  togglePlanMode,
  toggleSpecMode,
} from "./specComposer.ts";

const choice = (overrides: Partial<Parameters<typeof resolveSpecChoice>[0]> = {}) =>
  resolveSpecChoice({
    specModeEnabled: true,
    threadBound: false,
    driver: "codex",
    canMutate: true,
    ...overrides,
  });

describe("composer mode", () => {
  it("keeps Spec beside the provider interaction mode and lets it win", () => {
    expect(composerModeOf({ interactionMode: "default", specIntake: false })).toBe("build");
    expect(composerModeOf({ interactionMode: "plan", specIntake: false })).toBe("plan");
    expect(composerModeOf({ interactionMode: "plan", specIntake: true })).toBe("spec");
    expect(composerModeFlags("spec")).toEqual({ interactionMode: "default", specIntake: true });
    expect(composerModeFlags("plan")).toEqual({ interactionMode: "plan", specIntake: false });
    expect(composerModeFlags("build")).toEqual({ interactionMode: "default", specIntake: false });
  });

  it("moves between Plan and Spec through their own toggles without leaving both on", () => {
    expect(togglePlanMode("build")).toBe("plan");
    expect(togglePlanMode("plan")).toBe("build");
    expect(togglePlanMode("spec")).toBe("plan");
    expect(toggleSpecMode("build")).toBe("spec");
    expect(toggleSpecMode("spec")).toBe("build");
    expect(toggleSpecMode("plan")).toBe("spec");
  });
});

describe("resolveSpecChoice", () => {
  it("hides Spec where Spec mode is off or the thread already follows a spec", () => {
    expect(choice({ specModeEnabled: false })).toEqual({ kind: "hidden" });
    expect(choice({ threadBound: true })).toEqual({ kind: "hidden" });
    expect(choice()).toEqual({ kind: "available" });
  });

  it("shows Spec disabled with the reason when the provider or the person cannot start one", () => {
    const provider = choice({ driver: "cursor" });
    expect(provider.kind).toBe("disabled");
    expect(provider.kind === "disabled" && provider.reason).toContain("Cursor");
    expect(choice({ driver: null }).kind).toBe("disabled");
    expect(choice({ canMutate: false }).kind).toBe("disabled");
    expect(choice({ driver: "claudeAgent" }).kind).toBe("available");
  });
});

describe("resolveComposerMode", () => {
  const available = { kind: "available" } as const;
  const unavailable = { kind: "disabled", reason: "no" } as const;

  it("falls back to Build for a mode the composer cannot offer", () => {
    expect(resolveComposerMode({ requested: "spec", planAvailable: true, spec: available })).toBe(
      "spec",
    );
    expect(resolveComposerMode({ requested: "spec", planAvailable: true, spec: unavailable })).toBe(
      "build",
    );
    expect(
      resolveComposerMode({ requested: "spec", planAvailable: true, spec: { kind: "hidden" } }),
    ).toBe("build");
    expect(resolveComposerMode({ requested: "plan", planAvailable: false, spec: available })).toBe(
      "build",
    );
    expect(resolveComposerMode({ requested: "plan", planAvailable: true, spec: unavailable })).toBe(
      "plan",
    );
  });
});

describe("resolveSpecSendPath", () => {
  it("launches the thread with the intake, or marks an existing thread first", () => {
    expect(
      resolveSpecSendPath({ mode: "build", launchesThread: true, multipleModels: false }),
    ).toEqual({ kind: "none" });
    expect(
      resolveSpecSendPath({ mode: "plan", launchesThread: false, multipleModels: true }),
    ).toEqual({ kind: "none" });
    expect(
      resolveSpecSendPath({ mode: "spec", launchesThread: true, multipleModels: false }),
    ).toEqual({ kind: "launch" });
    expect(
      resolveSpecSendPath({ mode: "spec", launchesThread: false, multipleModels: false }),
    ).toEqual({ kind: "mark-then-send" });
  });

  it("refuses a multiple-model send in Spec mode", () => {
    const path = resolveSpecSendPath({ mode: "spec", launchesThread: true, multipleModels: true });
    expect(path.kind).toBe("refused");
    expect(path.kind === "refused" && path.message).toContain("one thread");
  });
});

describe("pendingIntakeBanner", () => {
  const intake = { createdAt: "2026-10-20T00:00:00.000Z" };

  it("allows Cancel only for a person who may, while the thread is idle", () => {
    expect(
      pendingIntakeBanner({ intake, threadRunning: false, canMutate: true }).cancelDisabledReason,
    ).toBeNull();
    expect(
      pendingIntakeBanner({ intake, threadRunning: true, canMutate: true }).cancelDisabledReason,
    ).toContain("stop");
    expect(
      pendingIntakeBanner({ intake, threadRunning: false, canMutate: false }).cancelDisabledReason,
    ).not.toBeNull();
    expect(pendingIntakeBanner({ intake, threadRunning: false, canMutate: true }).title).toBe(
      "Drafting a new spec",
    );
  });
});
