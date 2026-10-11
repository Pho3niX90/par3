import { describe, expect, it } from "@effect/vitest";
import { isEnterpriseHost, normalizeEnterpriseHost } from "./enterpriseHost.ts";

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
