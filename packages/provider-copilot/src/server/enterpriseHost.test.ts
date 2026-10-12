import { describe, expect, it } from "@effect/vitest";
import {
  copilotLaunchEnvironment,
  isEnterpriseHost,
  normalizeEnterpriseHost,
} from "./enterpriseHost.ts";

describe("enterpriseHost normalization", () => {
  it("normalizes full URLs with scheme and paths", () => {
    expect(normalizeEnterpriseHost("https://company.ghe.com")).toBe("company.ghe.com");
    expect(normalizeEnterpriseHost("https://company.ghe.com/")).toBe("company.ghe.com");
    expect(normalizeEnterpriseHost("http://github.octocat.com/api/v3")).toBe("github.octocat.com");
    expect(normalizeEnterpriseHost("https://octocat.ghe.com:443/test")).toBe("octocat.ghe.com");
  });

  it("normalizes bare hostnames", () => {
    expect(normalizeEnterpriseHost("COMPANY.GHE.COM")).toBe("company.ghe.com");
    expect(normalizeEnterpriseHost("  git.corp.example.com  ")).toBe("git.corp.example.com");
    expect(normalizeEnterpriseHost("github.com")).toBe("github.com");
  });

  it("handles empty or blank values", () => {
    expect(normalizeEnterpriseHost("")).toBe("");
    expect(normalizeEnterpriseHost(undefined)).toBe("");
    expect(normalizeEnterpriseHost(null)).toBe("");
  });

  it("identifies GitHub.com vs Enterprise hosts", () => {
    expect(isEnterpriseHost("company.ghe.com")).toBe(true);
    expect(isEnterpriseHost("github.octocat.com")).toBe(true);
    expect(isEnterpriseHost("github.com")).toBe(false);
    expect(isEnterpriseHost("")).toBe(false);
  });
});

describe("copilotLaunchEnvironment", () => {
  const ambient = { PATH: "/usr/bin", GH_TOKEN: "ambient-gh-token" };

  it("leaves the environment alone when no host or token is configured", () => {
    expect(copilotLaunchEnvironment({}, ambient)).toEqual(ambient);
  });

  it("does not mutate the base environment", () => {
    const base = { PATH: "/usr/bin" };
    copilotLaunchEnvironment(
      { enterpriseUrl: "https://company.ghe.com", enterpriseToken: "github_pat_x" },
      base,
    );
    expect(base).toEqual({ PATH: "/usr/bin" });
  });

  it("injects only COPILOT_GITHUB_TOKEN for GitHub.com so it never reaches GH_TOKEN", () => {
    const env = copilotLaunchEnvironment({ enterpriseToken: "  github_pat_x  " }, ambient);
    expect(env.COPILOT_GITHUB_TOKEN).toBe("github_pat_x");
    expect(env.GH_TOKEN).toBe("ambient-gh-token");
    expect(env.GH_HOST).toBeUndefined();
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
  });

  it("targets an enterprise host and exposes the token under the enterprise variable", () => {
    const env = copilotLaunchEnvironment(
      { enterpriseUrl: "https://Company.ghe.com/", enterpriseToken: "github_pat_x" },
      ambient,
    );
    expect(env.GH_HOST).toBe("company.ghe.com");
    expect(env.COPILOT_GITHUB_TOKEN).toBe("github_pat_x");
    expect(env.GH_ENTERPRISE_TOKEN).toBe("github_pat_x");
    expect(env.GH_TOKEN).toBe("ambient-gh-token");
  });

  it("sets the host without a token so the CLI uses its own login", () => {
    const env = copilotLaunchEnvironment({ enterpriseUrl: "company.ghe.com" }, ambient);
    expect(env.GH_HOST).toBe("company.ghe.com");
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  it("treats a blank token as unset", () => {
    const env = copilotLaunchEnvironment({ enterpriseToken: "   " }, ambient);
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });
});
