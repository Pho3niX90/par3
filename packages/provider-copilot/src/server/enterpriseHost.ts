/**
 * Enterprise host and URI normalization utilities for GitHub Copilot.
 *
 * @module provider-copilot/server/enterpriseHost
 */
import type { CopilotSettings } from "../settings.ts";

export function normalizeEnterpriseHost(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return url.hostname.toLowerCase();
    } catch {
      // Fall through to regex stripping
    }
  }
  return trimmed
    .replace(/^[a-zA-Z]+:\/\//, "")
    .replace(/[/?:#].*$/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
}

function isGitHubDotCom(host: string): boolean {
  return host === "" || host === "github.com";
}

/** Whether a normalized host represents any GitHub Enterprise instance. */
export function isEnterpriseHost(host: string): boolean {
  return !isGitHubDotCom(host);
}

/**
 * Environment one Copilot instance launches the CLI with, shared by the status probe and the
 * ACP session so the two cannot drift. Only an explicit token from settings is injected, as
 * `COPILOT_GITHUB_TOKEN`, which the CLI ranks above `GH_TOKEN` and `GITHUB_TOKEN`; ambient
 * variables are left alone so a missing token falls back to the CLI's own login. An enterprise
 * host sets `GH_HOST` and the token also goes out as `GH_ENTERPRISE_TOKEN`, the variable GitHub
 * documents for that host.
 */
export function copilotLaunchEnvironment(
  settings: Pick<CopilotSettings, "enterpriseUrl" | "enterpriseToken">,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const host = normalizeEnterpriseHost(settings.enterpriseUrl);
  const enterprise = isEnterpriseHost(host);
  const token = settings.enterpriseToken?.trim();
  const env: NodeJS.ProcessEnv = { ...base };
  if (enterprise) env.GH_HOST = host;
  if (token) {
    env.COPILOT_GITHUB_TOKEN = token;
    if (enterprise) env.GH_ENTERPRISE_TOKEN = token;
  }
  return env;
}
