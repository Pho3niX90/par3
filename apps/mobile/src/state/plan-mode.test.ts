import { describe, expect, it } from "@effect/vitest";

import { resolvePendingTaskInteractionMode, resolveProviderInteractionMode } from "./plan-mode";

describe("resolveProviderInteractionMode", () => {
  it("clears saved plan mode when the provider cannot use T3 interaction modes", () => {
    expect(resolveProviderInteractionMode({ showInteractionModeToggle: false }, "plan")).toBe(
      "default",
    );
  });

  it("keeps supported choices and remains compatible with older server status", () => {
    expect(resolveProviderInteractionMode({ showInteractionModeToggle: true }, "plan")).toBe(
      "plan",
    );
    expect(resolveProviderInteractionMode({}, "plan")).toBe("plan");
    expect(resolveProviderInteractionMode(null, "plan")).toBe("plan");
    expect(resolveProviderInteractionMode(undefined, undefined)).toBe("default");
  });
});

describe("resolvePendingTaskInteractionMode", () => {
  it("clears plan mode the provider cannot use", () => {
    expect(
      resolvePendingTaskInteractionMode({
        planModeEnabled: true,
        draftInteractionMode: "plan",
        provider: { showInteractionModeToggle: false },
      }),
    ).toBe("default");
  });

  it("forces build mode while the plan preference is off or still loading", () => {
    expect(
      resolvePendingTaskInteractionMode({ planModeEnabled: false, draftInteractionMode: "plan" }),
    ).toBe("default");
  });

  it("honors the draft's mode when the plan preference is enabled", () => {
    expect(
      resolvePendingTaskInteractionMode({ planModeEnabled: true, draftInteractionMode: "plan" }),
    ).toBe("plan");
    expect(
      resolvePendingTaskInteractionMode({ planModeEnabled: true, draftInteractionMode: undefined }),
    ).toBe("default");
  });
});
