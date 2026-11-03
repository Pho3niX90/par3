import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import type * as Undici from "undici";

// undici stays external to the CLI bundle (scripts/lib/cli-external-packages.ts).
// Inside a Node single-executable only `require` can load it from disk.
const requireUndici = NodeModule.createRequire(import.meta.url);

/**
 * Node 26 bundles undici 8, which offers h2 over ALPN to every HTTPS origin.
 * Node 22/24 (and Electron) bundle undici 6/7, whose fetch stays on HTTP/1.1.
 */
export const builtinFetchUsesHttp2 = (bundledUndiciVersion: string | undefined) =>
  Number.parseInt(bundledUndiciVersion ?? "", 10) >= 8;

function environmentProxyUrl(lowercaseName: string): string {
  const value = (process.env[lowercaseName] ?? process.env[lowercaseName.toUpperCase()])?.trim();
  if (!value) return "";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
    return ["http:", "https:", "socks:", "socks5:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

const environmentProxies = () => {
  const fallback = environmentProxyUrl("all_proxy");
  return {
    httpProxy: environmentProxyUrl("http_proxy") || fallback,
    httpsProxy: environmentProxyUrl("https_proxy") || environmentProxyUrl("http_proxy") || fallback,
  };
};

/** Connect's server requests need the same proxy variables as desktop downloads. */
export function installHttp1FetchDispatcher(): void {
  const undici = requireUndici("undici") as typeof Undici;
  const proxies = environmentProxies();
  // Node's agent comes from its internal undici copy, so `instanceof` against the npm class is false.
  const usesEnvProxy =
    Boolean(proxies.httpProxy || proxies.httpsProxy) ||
    undici.getGlobalDispatcher().constructor.name === "EnvHttpProxyAgent";
  undici.setGlobalDispatcher(
    usesEnvProxy
      ? new undici.EnvHttpProxyAgent({
          ...proxies,
          // The local server and cloudflared metrics must never leave this machine.
          noProxy: [
            "localhost",
            "127.0.0.1",
            "[::1]",
            process.env.no_proxy ?? process.env.NO_PROXY ?? "",
          ].join(","),
          allowH2: false,
          // The connection to an HTTPS proxy is built here, not from `allowH2`. ProxyAgent's
          // `connect` option is dropped on purpose: its connector has h2 fixed on.
          clientFactory: (origin) => new undici.Pool(origin, { allowH2: false }),
        })
      : new undici.Agent({ allowH2: false }),
  );
}

/**
 * An undici HTTP/2 session that hits its idle timeout can emit `'error'` on a
 * stream with no listener, which Node turns into an uncaught exception that
 * exits the server (https://github.com/nodejs/undici/issues/5936).
 */
export function keepOutboundFetchOnHttp1(): void {
  const proxies = environmentProxies();
  if (builtinFetchUsesHttp2(process.versions.undici) || proxies.httpProxy || proxies.httpsProxy) {
    installHttp1FetchDispatcher();
  }
}

// @types/node does not declare setTypeOfService yet.
type TypeOfServiceSocket = {
  setTypeOfService?: (this: NodeNet.Socket, typeOfService: number) => NodeNet.Socket;
};

// Bundled undici calls this from a socket callback without catching. On macOS,
// EINVAL after a peer reset must not exit the server over an optional QoS hint.
export function ignoreMacosTypeOfServiceEinval(
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs before ACP dispatch without loading the Effect graph.
  platform = process.platform,
  socketPrototype: TypeOfServiceSocket = NodeNet.Socket.prototype as TypeOfServiceSocket,
): void {
  if (platform !== "darwin") return;
  const setTypeOfService = socketPrototype.setTypeOfService;
  if (typeof setTypeOfService !== "function") return;
  socketPrototype.setTypeOfService = function (...args) {
    try {
      return setTypeOfService.apply(this, args);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EINVAL") return this;
      throw error;
    }
  };
}

/**
 * Node's 250 ms Happy Eyeballs attempt timeout abandons a working-but-slow IPv4
 * connect when IPv6 is advertised but unroutable, which broke the ACP registry
 * fetch (#15039). A larger `--network-family-autoselection-attempt-timeout` still wins.
 */
export function extendConnectionAttemptTimeout(): void {
  NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(
    Math.max(NodeNet.getDefaultAutoSelectFamilyAttemptTimeout(), 1_000),
  );
}
