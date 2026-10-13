import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { isProxyRelevantFailure, resolveEnvProxy } from "./envProxy.ts";

const env = (values: {
  readonly httpsProxy?: string;
  readonly httpProxy?: string;
  readonly allProxy?: string;
  readonly noProxy?: string;
}) => ({
  httpsProxy: Option.fromNullishOr(values.httpsProxy),
  httpProxy: Option.fromNullishOr(values.httpProxy),
  allProxy: Option.fromNullishOr(values.allProxy),
  noProxy: Option.fromNullishOr(values.noProxy),
});

describe("resolveEnvProxy", () => {
  it("prefers HTTPS_PROXY and strips credentials from the server", () => {
    const proxy = resolveEnvProxy(
      env({
        httpsProxy: "http://user%40corp:p%3Ass@proxy.company.example:8080",
        httpProxy: "http://other.company.example:80",
      }),
    );
    assert.deepStrictEqual(
      proxy,
      Option.some({
        source: "HTTPS_PROXY" as const,
        server: "http://proxy.company.example:8080",
        proxyBypassRules: "",
        credentials: Option.some({ username: "user@corp", password: "p:ss" }),
      }),
    );
  });

  it("falls back to HTTP_PROXY, defaults the scheme and port", () => {
    const proxy = resolveEnvProxy(env({ httpProxy: "proxy.company.example" }));
    assert.equal(Option.getOrThrow(proxy).server, "http://proxy.company.example:80");
    assert.equal(Option.getOrThrow(proxy).source, "HTTP_PROXY");
  });

  it("translates NO_PROXY into Chromium bypass rules", () => {
    const proxy = resolveEnvProxy(
      env({ httpsProxy: "socks5://proxy:1080", noProxy: "localhost, .company.example,10.0.0.0/8" }),
    );
    assert.equal(
      Option.getOrThrow(proxy).proxyBypassRules,
      "localhost,*.localhost,company.example,*.company.example,10.0.0.0/8",
    );
  });

  it("uses no proxy when NO_PROXY is * or the URL is unusable", () => {
    assert.isTrue(Option.isNone(resolveEnvProxy(env({ httpsProxy: "http://p:1", noProxy: "*" }))));
    assert.isTrue(Option.isNone(resolveEnvProxy(env({ httpsProxy: "ftp://p:21" }))));
    assert.isTrue(Option.isNone(resolveEnvProxy(env({}))));
  });
});

describe("isProxyRelevantFailure", () => {
  it("matches network errors and proxy auth, not bad releases", () => {
    assert.isTrue(isProxyRelevantFailure(new Error("net::ERR_TUNNEL_CONNECTION_FAILED")));
    assert.isTrue(isProxyRelevantFailure({ message: "Cannot download", statusCode: 407 }));
    assert.isTrue(
      isProxyRelevantFailure(new Error("wrapped", { cause: { code: "ECONNREFUSED" } })),
    );
    assert.isFalse(isProxyRelevantFailure(new Error("sha512 checksum mismatch")));
    assert.isFalse(isProxyRelevantFailure({ message: "Not Found", statusCode: 404 }));
  });
});
