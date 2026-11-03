// @effect-diagnostics nodeBuiltinImport:off - the test runs a real TLS h2 server to see which protocol fetch negotiates.
import * as NodeHttp2 from "node:http2";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Undici from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, vi } from "vite-plus/test";

import {
  builtinFetchUsesHttp2,
  ignoreMacosTypeOfServiceEinval,
  installHttp1FetchDispatcher,
  keepOutboundFetchOnHttp1,
} from "./outboundHttp.ts";

// Non-secret, self-signed 127.0.0.1 certificate, valid until 2126; ALPN h2 requires TLS.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3EwCztQysKTvzdcR
g0LWq+axzUd4tHi9PyMdqh7PlGShRANCAARfQpoLgv/tOsHWCLriDza7Ruaey2b7
mR/nS6mLu6W7+agkEqDm0mE3F/ngpPjL4Jj0IGadeMcKNKFRSBgiLdfn
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVagAwIBAgIUWbn2Wt5kTxii1UU57NJMt/wTaUgwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZdDNjb2RlIG91dGJvdW5kIGh0dHAgdGVzdDAgFw0yNjEwMTEy
MjQyMzZaGA8yMTI2MDkxNzIyNDIzNlowJDEiMCAGA1UEAwwZdDNjb2RlIG91dGJv
dW5kIGh0dHAgdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABF9CmguC/+06
wdYIuuIPNrtG5p7LZvuZH+dLqYu7pbv5qCQSoObSYTcX+eCk+MvgmPQgZp14xwo0
oVFIGCIt1+ejZDBiMB0GA1UdDgQWBBSsekAc30Q/zdIE/tvVDQKJL5oiCDAfBgNV
HSMEGDAWgBSsekAc30Q/zdIE/tvVDQKJL5oiCDAPBgNVHRMBAf8EBTADAQH/MA8G
A1UdEQQIMAaHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgebUrkyP56242EJB7nCV7
A+Ke/q0rNPya3fjQa9O5B+kCIQC1SfmdNaFcNJ4JINlus4FfrRnfKiADS2MIJR9f
99BN0A==
-----END CERTIFICATE-----
`;

const server = NodeHttp2.createSecureServer(
  { allowHTTP1: true, key: TEST_KEY, cert: TEST_CERT },
  (request, response) => response.end(request.httpVersion),
);
let origin = "";
const defaultCaCertificates = NodeTls.getCACertificates("default");
const defaultDispatcher = Undici.getGlobalDispatcher();
const defaultAttemptTimeout = NodeNet.getDefaultAutoSelectFamilyAttemptTimeout();

beforeAll(async () => {
  NodeTls.setDefaultCACertificates([...defaultCaCertificates, TEST_CERT]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/`;
});

afterEach(() => {
  Undici.setGlobalDispatcher(defaultDispatcher);
  NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(defaultAttemptTimeout);
});

afterAll(async () => {
  NodeTls.setDefaultCACertificates(defaultCaCertificates);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const versionViaGlobalDispatcher = async () => (await Undici.request(origin)).body.text();

const versionViaBuiltinFetch = () =>
  HttpClient.get(origin).pipe(
    Effect.flatMap((response) => response.text),
    Effect.provide(FetchHttpClient.layer),
  );

const listenHttpServer = Effect.fn("outboundHttp.test.listen")(function* (server: NodeHttp.Server) {
  yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
    () => Effect.promise(() => server[Symbol.asyncDispose]()),
  );
  return (server.address() as NodeNet.AddressInfo).port;
});

describe("installHttp1FetchDispatcher", () => {
  it.live.each(["http_proxy", "all_proxy"])(
    "uses %s for Connect HTTP requests and keeps loopback requests local",
    (variable) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            vi.unstubAllEnvs();
          }),
        );
        const targetPort = yield* listenHttpServer(
          NodeHttp.createServer((request, response) => response.end(request.url)),
        );
        const connections: Array<string | undefined> = [];
        const proxyPort = yield* listenHttpServer(
          NodeHttp.createServer((request, response) => {
            connections.push(request.url);
            response.end(new URL(request.url!).pathname);
          }),
        );
        vi.stubEnv("HTTP_PROXY", "");
        vi.stubEnv("http_proxy", "");
        vi.stubEnv("HTTPS_PROXY", "");
        vi.stubEnv("https_proxy", "");
        vi.stubEnv("ALL_PROXY", "");
        vi.stubEnv("all_proxy", "");
        vi.stubEnv(variable.toUpperCase(), "http://127.0.0.1:1");
        vi.stubEnv(variable, `http://127.0.0.1:${proxyPort}`);
        vi.stubEnv("NO_PROXY", "*");
        vi.stubEnv("no_proxy", "");
        Undici.setGlobalDispatcher(new Undici.Agent());

        keepOutboundFetchOnHttp1();

        const relayUrl = `http://relay.example.test:${targetPort}/.well-known/t3/environment`;
        expect(
          yield* HttpClient.get(relayUrl).pipe(Effect.flatMap((response) => response.text)),
        ).toBe("/.well-known/t3/environment");
        expect(
          yield* HttpClient.get(`http://127.0.0.1:${targetPort}/ready`).pipe(
            Effect.flatMap((response) => response.text),
          ),
        ).toBe("/ready");
        expect(connections).toEqual([relayUrl]);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.live("keeps the server usable when a proxy variable is malformed", () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          vi.unstubAllEnvs();
        }),
      );
      for (const name of [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
      ]) {
        vi.stubEnv(name, "http://");
      }
      Undici.setGlobalDispatcher(new Undici.Agent());

      keepOutboundFetchOnHttp1();

      expect(yield* versionViaBuiltinFetch()).toBe("1.1");
    }),
  );

  it.live("sends Connect HTTPS requests through an authenticated proxy", () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          vi.unstubAllEnvs();
        }),
      );
      const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
      const proxy = NodeHttp.createServer();
      proxy.on("connect", (request, socket) => {
        requests.push({ url: request.url, authorization: request.headers["proxy-authorization"] });
        // A deliberate rejection proves HTTPS reached the proxy without an external TLS server.
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      });
      const port = yield* listenHttpServer(proxy);
      vi.stubEnv("https_proxy", `http://user:p%40ss@127.0.0.1:${port}`);
      vi.stubEnv("no_proxy", "");
      Undici.setGlobalDispatcher(new Undici.Agent());

      keepOutboundFetchOnHttp1();

      yield* HttpClient.get("https://relay.example.test/health").pipe(Effect.flip);
      expect(requests).toEqual([
        { url: "relay.example.test:443", authorization: "Basic dXNlcjpwQHNz" },
      ]);
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it("makes the global dispatcher negotiate HTTP/1.1 and keeps the env proxy agent", async () => {
    Undici.setGlobalDispatcher(new Undici.Agent());
    expect(await versionViaGlobalDispatcher()).toBe("2.0");

    installHttp1FetchDispatcher();
    expect(await versionViaGlobalDispatcher()).toBe("1.1");

    Undici.setGlobalDispatcher(new Undici.EnvHttpProxyAgent());
    installHttp1FetchDispatcher();
    expect(Undici.getGlobalDispatcher()).toBeInstanceOf(Undici.EnvHttpProxyAgent);
  });

  // Only bundled undici 8 (Node 26+) offers fetch h2 and can prove dispatcher replacement.
  it.effect.runIf(builtinFetchUsesHttp2(process.versions.undici))(
    "moves the built-in fetch off HTTP/2",
    () =>
      Effect.gen(function* () {
        expect(yield* versionViaBuiltinFetch()).toBe("2.0");
        installHttp1FetchDispatcher();
        expect(yield* versionViaBuiltinFetch()).toBe("1.1");
      }),
  );
});

const runNode = Effect.fnUntraced(function* (args: Array<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(process.execPath, args));
  return yield* Effect.all(
    {
      stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      exitCode: child.exitCode.pipe(Effect.map(Number)),
    },
    { concurrency: "unbounded" },
  );
}, Effect.scoped);

describe("ignoreMacosTypeOfServiceEinval", () => {
  const errnoError = (code: string) =>
    Object.assign(new Error(`setTypeOfService ${code}`), { code, syscall: "setTypeOfService" });

  it("swallows only an Error with code EINVAL on macOS", () => {
    let error: unknown = errnoError("EINVAL");
    const prototype = {
      setTypeOfService(this: NodeNet.Socket, _typeOfService: number): NodeNet.Socket {
        throw error;
      },
    };
    ignoreMacosTypeOfServiceEinval("darwin", prototype);

    const socket = new NodeNet.Socket();
    expect(prototype.setTypeOfService.call(socket, 0)).toBe(socket);

    error = errnoError("EPERM");
    expect(() => prototype.setTypeOfService.call(socket, 0)).toThrow(error);

    error = { code: "EINVAL" };
    expect(() => prototype.setTypeOfService.call(socket, 0)).toThrow();
  });

  // Bundled undici 7 calls this API from a socket callback. Keep the real fetch
  // in a child so an escaped EINVAL exits that process instead of breaking Vitest.
  it.effect.runIf(
    typeof (NodeNet.Socket.prototype as { setTypeOfService?: unknown }).setTypeOfService ===
      "function" && process.versions.undici?.startsWith("7.") === true,
  )("keeps built-in fetch working when setTypeOfService throws EINVAL", () =>
    Effect.gen(function* () {
      const child = yield* runNode([
        "--input-type=module",
        "--eval",
        `
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import { ignoreMacosTypeOfServiceEinval } from ${JSON.stringify(new URL("./outboundHttp.ts", import.meta.url).href)};

NodeTls.setDefaultCACertificates([${JSON.stringify(TEST_CERT)}]);
let calls = 0;
NodeNet.Socket.prototype.setTypeOfService = () => {
  calls++;
  throw Object.assign(new Error("setTypeOfService EINVAL"), { code: "EINVAL" });
};
ignoreMacosTypeOfServiceEinval("darwin");
console.log(await (await fetch(${JSON.stringify(origin)})).text());
if (calls === 0) throw new Error("fetch did not call setTypeOfService");
`,
      ]);
      expect(child.exitCode, child.stderr).toBe(0);
      expect(child.stdout.trim()).toBe("1.1");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
