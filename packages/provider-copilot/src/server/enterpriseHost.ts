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

/** A plain DNS hostname, so a configured host can never reshape the URL it is placed in. */
const SAFE_HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * The Copilot settings page on the instance's GitHub host. It shows the credits used and the
 * allowance for the signed-in account, including seats an enterprise or organization pays for,
 * which have no personal billing page. `undefined` when the configured host is not a plain
 * hostname, so no link is better than one that points somewhere unintended.
 */
export function copilotUsagePageUrl(enterpriseUrl: string | null | undefined): string | undefined {
  const host = normalizeEnterpriseHost(enterpriseUrl);
  if (!isEnterpriseHost(host)) return "https://github.com/settings/copilot/features";
  return SAFE_HOSTNAME.test(host) ? `https://${host}/settings/copilot/features` : undefined;
}

/**
 * The CLI's launch environment, shared by the status probe and ACP sessions so they cannot drift.
 * Only an explicit settings token is injected, as `COPILOT_GITHUB_TOKEN` (ranked above `GH_TOKEN`);
 * an enterprise host adds `GH_HOST` and `GH_ENTERPRISE_TOKEN`. Ambient variables are left alone.
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
