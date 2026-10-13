import * as Option from "effect/Option";

/** The proxy variables a shell or IT policy sets. Lowercase names win, as in curl. */
export interface ProxyEnv {
  readonly httpsProxy: Option.Option<string>;
  readonly httpProxy: Option.Option<string>;
  readonly allProxy: Option.Option<string>;
  readonly noProxy: Option.Option<string>;
}

export interface EnvProxy {
  /** Which variable the proxy came from, for logs and error messages. */
  readonly source: "HTTPS_PROXY" | "HTTP_PROXY" | "ALL_PROXY";
  /** `scheme://host:port`, without credentials. Safe to log. */
  readonly server: string;
  readonly proxyBypassRules: string;
  readonly credentials: Option.Option<{ readonly username: string; readonly password: string }>;
}

const DEFAULT_PORTS: Record<string, string> = {
  http: "80",
  https: "443",
  socks: "1080",
  socks4: "1080",
  socks5: "1080",
};

function parseProxyUrl(raw: string): Option.Option<URL> {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    const scheme = url.protocol.slice(0, -1);
    return scheme in DEFAULT_PORTS && url.hostname.length > 0 ? Option.some(url) : Option.none();
  } catch {
    return Option.none();
  }
}

/** Chromium matches `host` exactly, so a curl-style `host` entry also needs `*.host`. */
function toBypassRules(noProxy: string): string {
  return noProxy
    .split(/[\s,]+/)
    .filter((entry) => entry.length > 0)
    .flatMap((entry) => {
      const host = entry.replace(/^\*?\./, "");
      if (host.includes("/") || /^[\d.]+(?::\d+)?$/.test(host) || host.startsWith("[")) {
        return [host];
      }
      return [host, `*.${host}`];
    })
    .join(",");
}

/** Resolves the proxy that HTTPS requests should use according to the environment. */
export function resolveEnvProxy(env: ProxyEnv): Option.Option<EnvProxy> {
  if (Option.getOrUndefined(env.noProxy)?.trim() === "*") return Option.none();

  const candidates = [
    ["HTTPS_PROXY", env.httpsProxy],
    ["HTTP_PROXY", env.httpProxy],
    ["ALL_PROXY", env.allProxy],
  ] as const;
  for (const [source, value] of candidates) {
    if (Option.isNone(value)) continue;
    const url = parseProxyUrl(value.value);
    if (Option.isNone(url)) continue;
    const scheme = url.value.protocol.slice(0, -1);
    const port = url.value.port || DEFAULT_PORTS[scheme];
    const username = decodeURIComponent(url.value.username);
    return Option.some({
      source,
      server: `${scheme}://${url.value.hostname}:${port}`,
      proxyBypassRules: Option.match(env.noProxy, { onNone: () => "", onSome: toBypassRules }),
      credentials:
        username.length > 0
          ? Option.some({ username, password: decodeURIComponent(url.value.password) })
          : Option.none(),
    });
  }
  return Option.none();
}

/** Whether a failure looks like the network refused the request rather than the
    release being bad, so retrying through a different proxy could help. */
export function isProxyRelevantFailure(cause: unknown, depth = 0): boolean {
  if (depth > 3 || typeof cause !== "object" || cause === null) return false;
  const error = cause as {
    readonly message?: unknown;
    readonly code?: unknown;
    readonly statusCode?: unknown;
    readonly cause?: unknown;
  };
  if (error.statusCode === 407) return true;
  const text = `${typeof error.code === "string" ? error.code : ""} ${
    typeof error.message === "string" ? error.message : ""
  }`;
  if (/net::ERR_|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/.test(text)) return true;
  return isProxyRelevantFailure(error.cause, depth + 1);
}
