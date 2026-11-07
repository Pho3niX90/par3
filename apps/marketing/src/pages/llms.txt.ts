import type { APIRoute } from "astro";

import { GITHUB_REPOSITORY_URL, PRIVACY_POLICY_URL, RELEASES_URL, TERMS_URL } from "../lib/site";
import { absoluteUrl, SITE_TAGLINE } from "../lib/seo";

// https://llmstxt.org: a plain index that tells AI agents which domain and links are official.
export const GET: APIRoute = () => {
  const body = `# Par3

> ${SITE_TAGLINE}. Par3 is built by Parity Labs. It runs Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, and other coding agents from one desktop, web, and mobile app.

## Official links

- [Download Par3](${absoluteUrl("/download")}): macOS, Windows, and Linux installers
- [Web app](https://app.paritylabs.co.za): connect to a Par3 server from a browser
- [Source code](${GITHUB_REPOSITORY_URL})
- [Releases](${RELEASES_URL}): release builds and changelogs
- [npm package](https://www.npmjs.com/package/@paritylabs/par3): run \`npx @paritylabs/par3\`

## Policies

- [Privacy policy](${PRIVACY_POLICY_URL})
- [Terms of service](${TERMS_URL})
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
