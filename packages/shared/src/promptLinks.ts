import { DEFAULT_HOSTED_APP_URL } from "./connectAuth.ts";

export const PROMPT_LINK_MAX_PROMPT_LENGTH = 8_000;

export interface PromptLinkRepository {
  readonly owner: string;
  readonly name: string;
}

export interface PromptLinkPullRequest extends PromptLinkRepository {
  readonly number: number;
}

export interface LinkedPrompt {
  readonly text: string;
  readonly hiddenCharacters: number;
}

export type NewThreadLink =
  | {
      readonly kind: "new";
      readonly prompt: LinkedPrompt;
      readonly repository: PromptLinkRepository | null;
      readonly provider: string | null;
      readonly model: string | null;
    }
  | {
      readonly kind: "pull-request";
      readonly pullRequest: PromptLinkPullRequest;
      readonly prompt: LinkedPrompt | null;
    };

export type PromptLinkResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

// Zero-width and bidi controls, tag and variation-selector blocks, and other characters that
// render as nothing. A model reads them; the person checking the draft cannot see them, which
// makes them the usual way to hide instructions in a prompt.
const HIDDEN_CHARACTERS =
  // oxlint-disable-next-line no-control-regex, no-misleading-character-class -- these are the characters it removes.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0D\uFEFF\uFFA0\uFFF0-\uFFFB\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/gu;
// Emoji and the pieces emoji sequences are built from: pictographs, symbols, skin tones, and the
// emoji presentation selector. Numeric ranges, because Hermes lacks Unicode property escapes.
const isEmojiPart = (codePoint: number | undefined) =>
  codePoint !== undefined &&
  ((codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2190 && codePoint <= 0x2bff) ||
    codePoint === 0xfe0f);

export function sanitizeLinkedPrompt(raw: string): LinkedPrompt {
  let hiddenCharacters = 0;
  const visible = Array.from(
    raw.replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(HIDDEN_CHARACTERS, () => {
      hiddenCharacters++;
      return "";
    }),
  );
  const text = visible
    .filter((character, index) => {
      if (character !== "\u200D") return true;
      const kept =
        isEmojiPart(visible[index - 1]?.codePointAt(0)) &&
        isEmojiPart(visible[index + 1]?.codePointAt(0));
      if (!kept) hiddenCharacters++;
      return kept;
    })
    .join("");
  return { text: text.trim(), hiddenCharacters };
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

function repositoryOf(owner: string, name: string): PromptLinkRepository | null {
  const trimmedName = name.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !NAME.test(trimmedName) || /^\.+$/.test(trimmedName)) return null;
  return { owner, name: trimmedName };
}

export function parsePromptLinkRepository(value: string): PromptLinkRepository | null {
  const trimmed = value.trim();
  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/?$/i.exec(trimmed);
  const short = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  const match = url ?? short;
  return match?.[1] && match[2] ? repositoryOf(match[1], match[2]) : null;
}

function parsePromptLinkPullRequest(value: string): PromptLinkPullRequest | null {
  const trimmed = value.trim();
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
      trimmed,
    ) ?? /^([^/\s#]+)\/([^/\s#]+)(?:\/|#)(\d+)$/.exec(trimmed);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const repository = repositoryOf(match[1], match[2]);
  const number = Number(match[3]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { ...repository, number }
    : null;
}

export function promptLinkPullRequestUrl(pullRequest: PromptLinkPullRequest): string {
  return `https://github.com/${pullRequest.owner}/${pullRequest.name}/pull/${pullRequest.number}`;
}

function readPrompt(params: URLSearchParams): PromptLinkResult<LinkedPrompt | null> {
  const raw = params.get("prompt");
  if (raw === null) return { ok: true, value: null };
  if (raw.length > PROMPT_LINK_MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      error: `This prompt is longer than ${PROMPT_LINK_MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters, so Par3 did not open it.`,
    };
  }
  const prompt = sanitizeLinkedPrompt(raw);
  if (prompt.text.length === 0 && prompt.hiddenCharacters > 0) {
    return {
      ok: false,
      error:
        "This prompt had only hidden characters, so it may be malicious. Par3 did not open it.",
    };
  }
  return { ok: true, value: prompt.text.length > 0 ? prompt : null };
}

const optionalParam = (params: URLSearchParams, key: string) => params.get(key)?.trim() || null;

export function parseNewThreadLink(search: string): PromptLinkResult<NewThreadLink> {
  const params = new URLSearchParams(search);
  const prompt = readPrompt(params);
  if (!prompt.ok) return prompt;
  const pr = params.get("pr");
  if (pr !== null) {
    const pullRequest = parsePromptLinkPullRequest(pr);
    if (pullRequest === null) {
      return { ok: false, error: "This link names a pull request Par3 cannot read." };
    }
    return { ok: true, value: { kind: "pull-request", pullRequest, prompt: prompt.value } };
  }
  if (prompt.value === null) return { ok: false, error: "This link has no prompt." };
  const repo = params.get("repo");
  const repository = repo === null ? null : parsePromptLinkRepository(repo);
  if (repo !== null && repository === null) {
    return { ok: false, error: "This link names a repository Par3 cannot read." };
  }
  return {
    ok: true,
    value: {
      kind: "new",
      prompt: prompt.value,
      repository,
      provider: optionalParam(params, "provider")?.toLowerCase() ?? null,
      model: optionalParam(params, "model"),
    },
  };
}

export function parseThreadLinkPrompt(search: string): PromptLinkResult<LinkedPrompt | null> {
  return readPrompt(new URLSearchParams(search));
}

export function withoutPromptLinkParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of ["prompt", "repo", "pr", "provider", "model"]) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

export function buildNewThreadLink(input: {
  readonly prompt: string;
  readonly repository?: PromptLinkRepository | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly origin?: string;
}): string {
  const url = new URL("/new", input.origin ?? DEFAULT_HOSTED_APP_URL);
  url.searchParams.set("prompt", input.prompt);
  if (input.repository) {
    url.searchParams.set("repo", `${input.repository.owner}/${input.repository.name}`);
  }
  if (input.provider) url.searchParams.set("provider", input.provider);
  if (input.provider && input.model) url.searchParams.set("model", input.model);
  return url.toString();
}

const APP_SCHEME = /^(?:par3|t3code)(?:-[a-z]+)?:$/;
const THREAD_PATH = /^\/([^/]+)\/([^/]+)\/?$/;

/** Schemes of GitHub Copilot app links, which desktop opens when no Copilot app claims them. */
export const COPILOT_APP_LINK_SCHEMES = ["ghapp", "github-app"] as const;
const COPILOT_APP_SCHEME = /^(?:ghapp|github-app):$/;
const COPILOT_ITEM_PATH = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/;
const COPILOT_SESSION_PATH = /^\/new(?:\/([^/]+)\/([^/]+))?\/?$/;

/**
 * The `/new` path for a GitHub Copilot app link, such as the one behind GitHub's
 * "Open in GitHub Copilot app" button, or null for shapes Par3 has no match for.
 * Like every prompt link it only fills a draft: an issue becomes a prompt naming it, and a
 * session's `mode` and `branch` are dropped because links never pick those.
 * https://docs.github.com/en/copilot/how-tos/github-copilot-app/open-with-deep-links
 */
function copilotAppLinkPath(url: URL): string | null {
  const params = new URLSearchParams();
  const item = url.host === "github.com" ? COPILOT_ITEM_PATH.exec(url.pathname) : null;
  if (item) {
    const [, owner, name, kind, number] = item;
    if (kind === "pull") {
      params.set("pr", `${owner}/${name}/${number}`);
    } else {
      params.set("repo", `${owner}/${name}`);
      params.set("prompt", `Work on https://github.com/${owner}/${name}/issues/${number}`);
    }
    return `/new?${params}`;
  }
  const session = url.host === "session" ? COPILOT_SESSION_PATH.exec(url.pathname) : null;
  if (!session) return null;
  const repo =
    session[1] && session[2] ? `${session[1]}/${session[2]}` : url.searchParams.get("repo");
  const pr = url.searchParams.get("pr");
  const prompt = url.searchParams.get("prompt");
  if (repo && pr) params.set("pr", `${repo}/${pr}`);
  else if (repo) params.set("repo", repo);
  if (prompt !== null) params.set("prompt", prompt);
  return `/new?${params}`;
}

/**
 * The in-app path a prompt link or thread deep link opens, or null for any other URL.
 * Desktop uses it for links the OS hands over: `par3://` and `t3code://` ones, GitHub Copilot app
 * ones, and, as the default browser on macOS, hosted-app ones.
 */
export function promptLinkAppPath(
  value: string,
  hostedAppUrl: string = DEFAULT_HOSTED_APP_URL,
): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (APP_SCHEME.test(url.protocol)) {
    if (url.host === "new" && (url.pathname === "" || url.pathname === "/")) {
      return `/new${url.search}`;
    }
    const thread = url.host === "threads" ? THREAD_PATH.exec(url.pathname) : null;
    return thread ? `/${thread[1]}/${thread[2]}${url.search}` : null;
  }
  if (COPILOT_APP_SCHEME.test(url.protocol)) return copilotAppLinkPath(url);
  if (!URL.canParse(hostedAppUrl) || url.origin !== new URL(hostedAppUrl).origin) return null;
  if (url.pathname === "/new") return `/new${url.search}`;
  const thread = url.searchParams.has("prompt") ? THREAD_PATH.exec(url.pathname) : null;
  return thread ? `/${thread[1]}/${thread[2]}${url.search}` : null;
}

export function promptLinkDeepLink(appPath: string, scheme = "par3"): string {
  const url = new URL(appPath, "https://app.invalid");
  const host = url.pathname === "/new" ? "new" : `threads${url.pathname}`;
  return `${scheme}://${host}${url.search}`;
}
