// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off preferSchemaOverJson:off - Host-side helper for scripts that drive a real server process.
/**
 * Starts a real `apps/server` process against a disposable T3 home and talks to
 * it the way a client does: bootstrap token exchange, project creation over
 * HTTP, and the Effect RPC client over the WebSocket. Shared by the live
 * verifiers and benchmarks under `apps/server/scripts`.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
} from "@t3tools/contracts";

export const repositoryRoot = NodePath.resolve(import.meta.dirname, "../../../..");

// oxlint-disable-next-line t3code/no-global-process-runtime -- Host-side script with no Effect runtime.
const isWindows = process.platform === "win32";

const decodeTokenResponse = Schema.decodeUnknownSync(
  Schema.Struct({ access_token: Schema.String }),
);
const decodeTicketResponse = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }));

/**
 * Reserves an ephemeral port, then releases it for the real server. A bind
 * race fails the caller; it never falls back to an existing environment.
 */
export async function reservePort(): Promise<number> {
  const reservation = NodeHttp.createServer();
  reservation.listen(0, "127.0.0.1");
  await new Promise<void>((done) => reservation.once("listening", done));
  const address = reservation.address();
  NodeAssert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => reservation.close(() => done()));
  return address.port;
}

/** Writes `<home>/userdata/settings.json` before the server first reads it. */
export function writeServerSettings(home: string, settings: Record<string, unknown>): void {
  const stateDir = NodePath.join(home, "userdata");
  NodeFS.mkdirSync(stateDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(stateDir, "settings.json"), JSON.stringify(settings, null, 2));
}

/** Settings that pin the Claude instance and keep unrelated providers from starting. */
export function claudeBenchSettings(input: {
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly model: string;
  readonly effort?: string;
  readonly runtimeMode: string;
  readonly responseStreamingMode: "paragraph" | "turn";
}): Record<string, unknown> {
  return {
    responseStreamingMode: input.responseStreamingMode,
    defaultRuntimeMode: input.runtimeMode,
    defaultModelSelection: claudeModelSelection(input),
    enableProviderUpdateChecks: false,
    continueThreadsAfterServerUpdate: false,
    providerInstances: {
      claudeAgent: {
        driver: "claudeAgent",
        config: {
          ...(input.binaryPath === undefined ? {} : { binaryPath: input.binaryPath }),
          ...(input.homePath === undefined ? {} : { homePath: input.homePath }),
        },
      },
      codex: { driver: "codex", enabled: false },
      copilot: { driver: "copilot", enabled: false },
    },
  };
}

function claudeModelSelection(input: { readonly model: string; readonly effort?: string }) {
  return {
    instanceId: "claudeAgent",
    model: input.model,
    ...(input.effort === undefined ? {} : { options: [{ id: "effort", value: input.effort }] }),
  };
}

export interface StartedServer {
  readonly server: NodeChildProcess.ChildProcess;
  readonly ready: Promise<void>;
}

export interface StartServerInput {
  readonly port: number;
  readonly home: string;
  readonly bootstrap: string;
  /** Server stdout and stderr are appended here, with the bootstrap token redacted. */
  readonly logPath: string;
  readonly logLevel?: string;
  /**
   * Output that marks the server ready. The default is a debug-level log; a
   * caller that raises the log level waits for "Listening on" instead.
   */
  readonly readyText?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Spawns `bin.ts start` with the bootstrap JSON on fd 3 and resolves once the
 * server logs that startup finished. On POSIX the server leads its own process
 * group so `stopServer` can also reap provider children.
 */
export function startServer(input: StartServerInput): StartedServer {
  const server = NodeChildProcess.spawn(
    process.execPath,
    [
      "apps/server/src/bin.ts",
      "start",
      "--bootstrap-fd",
      "3",
      "--log-level",
      input.logLevel ?? "debug",
    ],
    {
      cwd: repositoryRoot,
      detached: !isWindows,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      ...(input.env === undefined ? {} : { env: input.env }),
    },
  );
  const bootstrapPipe = server.stdio[3];
  NodeAssert.ok(bootstrapPipe && "write" in bootstrapPipe);
  bootstrapPipe.end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port: input.port,
      t3Home: input.home,
      host: "127.0.0.1",
      desktopBootstrapToken: input.bootstrap,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }),
  );
  const ready = Promise.withResolvers<void>();
  let output = "";
  for (const pipe of [server.stdout, server.stderr])
    pipe?.on("data", (data: Buffer) => {
      const text = data.toString().replaceAll(input.bootstrap, "[REDACTED]");
      NodeFS.appendFileSync(input.logPath, text);
      output = (output + text).slice(-8192);
      if (output.includes(input.readyText ?? "startup phase: complete")) ready.resolve();
    });
  server.once("error", ready.reject);
  server.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
  const startupDeadline = setTimeout(
    () => ready.reject(new Error("Server startup timed out")),
    60_000,
  );
  return { server, ready: ready.promise.finally(() => clearTimeout(startupDeadline)) };
}

/**
 * Stops a server started by `startServer`, including provider processes it
 * spawned. Only the PID captured at spawn is targeted.
 */
export async function stopServer(server: NodeChildProcess.ChildProcess): Promise<void> {
  const running = server.exitCode === null && server.signalCode === null;
  if (isWindows) {
    // Windows has no process groups or graceful SIGTERM. Kill the tree while
    // the root is still alive, since taskkill /T walks it from the root.
    if (running && server.pid) {
      const stopped = new Promise<void>((done) => server.once("exit", () => done()));
      NodeChildProcess.spawnSync("taskkill", ["/T", "/F", "/PID", String(server.pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      await stopped;
    }
    return;
  }
  if (running) {
    const stopped = new Promise<void>((done) => server.once("exit", () => done()));
    server.kill("SIGTERM");
    const deadline = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await stopped;
    clearTimeout(deadline);
  }
  // Kill only the process group created above, including lingering provider pipes.
  if (server.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}

/** Exchanges the desktop bootstrap token for a bearer access token. */
export async function exchangeBootstrapToken(origin: string, bootstrap: string): Promise<string> {
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  NodeAssert.ok(tokenResponse.ok, `Authentication failed: ${tokenResponse.status}`);
  const token = decodeTokenResponse(await tokenResponse.json());
  return token.access_token;
}

export function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
}

export async function createProject(
  origin: string,
  headers: Record<string, string>,
  input: { readonly title: string; readonly workspaceRoot: string },
): Promise<ProjectId> {
  const projectId = ProjectId.make(NodeCrypto.randomUUID());
  const created = await fetch(`${origin}/api/projects/mutate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title: input.title,
      workspaceRoot: input.workspaceRoot,
    }),
  });
  NodeAssert.ok(created.ok, `Project creation failed: ${created.status} ${await created.text()}`);
  return projectId;
}

/**
 * Returns the RPC protocol layer for one authenticated WebSocket. Provide it
 * to an effect that calls `RpcClient.make(WsRpcGroup)`.
 */
export async function websocketProtocolLayer(origin: string, headers: Record<string, string>) {
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers,
  });
  NodeAssert.ok(ticketResponse.ok, `WebSocket authentication failed: ${ticketResponse.status}`);
  const ticket = decodeTicketResponse(await ticketResponse.json());
  const layerSocket = Socket.layerWebSocket(
    `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(layerSocket),
    Layer.provide(RpcSerialization.layerJson),
  );
}
