import type { APIRoute } from "astro";

import { absoluteUrl } from "../../lib/seo";
import { GITHUB_REPOSITORY_URL } from "../../lib/site";

// RFC 9116 requires an Expires date. Deriving it from the build keeps the file valid as long as
// the site deploys at least once a year.
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export const GET: APIRoute = () => {
  const body = [
    // Reports go through GitHub's private vulnerability reporting; /security-policy redirects there.
    `Contact: ${GITHUB_REPOSITORY_URL}/security/advisories/new`,
    `Policy: ${GITHUB_REPOSITORY_URL}/security`,
    `Canonical: ${absoluteUrl("/.well-known/security.txt")}`,
    "Preferred-Languages: en",
    `Expires: ${new Date(Date.now() + ONE_YEAR_MS).toISOString()}`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
