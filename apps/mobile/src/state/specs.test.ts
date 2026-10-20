import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../lib/uuid", () => ({
  uuidv4: () => "mock-uuid",
  randomHex: () => "0123456789abcdef",
}));

vi.mock("./server", () => ({
  serverEnvironment: {
    specsQuery: () => {},
    specsLive: () => {},
    specsMutate: { permissionAtom: () => {} },
  },
}));

import { isSpecRoleSupported, explainSpecRoleSupport } from "./specs";

describe("specs role support", () => {
  it("enforces Codex and Claude only for requirements, researcher, and verifier", () => {
    expect(isSpecRoleSupported("codex", "requirements")).toBe(true);
    expect(isSpecRoleSupported("claudeAgent", "requirements")).toBe(true);
    expect(isSpecRoleSupported("cursor", "requirements")).toBe(false);
    expect(isSpecRoleSupported("antigravity", "requirements")).toBe(false);

    expect(isSpecRoleSupported("codex", "researcher")).toBe(true);
    expect(isSpecRoleSupported("grok", "researcher")).toBe(false);

    expect(isSpecRoleSupported("claudeAgent", "verifier")).toBe(true);
    expect(isSpecRoleSupported("opencode", "verifier")).toBe(false);
  });

  it("supports broader set of providers for implementation and test", () => {
    const supportedDrivers = ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"];
    for (const driver of supportedDrivers) {
      expect(isSpecRoleSupported(driver, "implementation")).toBe(true);
      expect(isSpecRoleSupported(driver, "test")).toBe(true);
    }
    expect(isSpecRoleSupported("unknown-driver", "implementation")).toBe(false);
  });

  it("provides helpful explanation on unsupported combinations", () => {
    const explanation = explainSpecRoleSupport("cursor", "requirements");
    expect(explanation).toContain('does not support the "requirements" role');
    expect(explanation).toContain("requires Codex or Claude");

    const implExplanation = explainSpecRoleSupport("unknown-driver", "implementation");
    expect(implExplanation).toContain('does not support the "implementation" role');

    expect(explainSpecRoleSupport("codex", "requirements")).toBeNull();
  });
});
