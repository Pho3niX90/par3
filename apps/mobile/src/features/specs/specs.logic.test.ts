import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../lib/uuid", () => ({
  uuidv4: () => "mock-uuid",
  randomHex: () => "0123456789abcdef",
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    specsQuery: () => {},
    specsLive: () => {},
    specsMutate: { permissionAtom: () => {} },
  },
}));

import { isSpecRoleSupported, explainSpecRoleSupport } from "../../state/specs";

describe("Spec mode logic and role capabilities", () => {
  it("strictly enforces provider constraints for requirements role", () => {
    expect(isSpecRoleSupported("codex", "requirements")).toBe(true);
    expect(isSpecRoleSupported("claudeAgent", "requirements")).toBe(true);
    expect(isSpecRoleSupported("cursor", "requirements")).toBe(false);
    expect(isSpecRoleSupported("antigravity", "requirements")).toBe(false);
    expect(isSpecRoleSupported("grok", "requirements")).toBe(false);
    expect(isSpecRoleSupported("opencode", "requirements")).toBe(false);
  });

  it("strictly enforces provider constraints for researcher and verifier roles", () => {
    expect(isSpecRoleSupported("codex", "researcher")).toBe(true);
    expect(isSpecRoleSupported("claudeAgent", "researcher")).toBe(true);
    expect(isSpecRoleSupported("antigravity", "researcher")).toBe(false);

    expect(isSpecRoleSupported("codex", "verifier")).toBe(true);
    expect(isSpecRoleSupported("claudeAgent", "verifier")).toBe(true);
    expect(isSpecRoleSupported("cursor", "verifier")).toBe(false);
  });

  it("allows all primary providers for implementation and test roles", () => {
    const allProviders = ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"];

    for (const provider of allProviders) {
      expect(isSpecRoleSupported(provider, "implementation")).toBe(true);
      expect(isSpecRoleSupported(provider, "test")).toBe(true);
    }
  });

  it("explains unsupported provider selections with clear explanations", () => {
    expect(explainSpecRoleSupport("cursor", "requirements")).toContain(
      'does not support the "requirements" role',
    );
    expect(explainSpecRoleSupport("antigravity", "verifier")).toContain(
      'does not support the "verifier" role',
    );
    expect(explainSpecRoleSupport("codex", "requirements")).toBeNull();
    expect(explainSpecRoleSupport("claudeAgent", "implementation")).toBeNull();
  });
});
