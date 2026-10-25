// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - Standalone eval tooling; the driver runs in task containers without the monorepo's Effect runtime.
/**
 * Minimal client for Par3's Effect RPC over WebSocket (JSON serialization), speaking the encoded
 * RpcMessage shapes directly so it runs in a task container without the monorepo. Unary RPCs only;
 * payloads must already be encoded. VERIFY: decimal-string request ids, possibly batched frames.
 */

type ServerMessage = {
  readonly _tag: string;
  readonly requestId?: string | number;
  readonly exit?: {
    readonly _tag: "Success" | "Failure";
    readonly value?: unknown;
    readonly cause?: unknown;
  };
  readonly defect?: unknown;
  readonly error?: unknown;
};

export class RpcError extends Error {
  readonly tag: string;
  readonly detail: unknown;
  constructor(tag: string, detail: unknown) {
    super(`${tag} failed: ${JSON.stringify(detail)}`);
    this.tag = tag;
    this.detail = detail;
  }
}

interface Pending {
  readonly tag: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class Par3RpcClient {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
    socket.addEventListener("close", () => this.failAll(new Error("websocket closed")));
  }

  /**
   * Bearer clients cannot put headers on a WebSocket upgrade, so they trade the bearer token
   * for a short-lived ticket over HTTP and pass it as `?wsTicket=` (docs/internals/environment-auth.md).
   */
  static async connect(baseUrl: string, bearerToken: string): Promise<Par3RpcClient> {
    const response = await fetch(new URL("/api/auth/websocket-ticket", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    if (!response.ok) throw new Error(`websocket ticket: HTTP ${response.status}`);
    const { ticket } = (await response.json()) as { ticket: string };
    const url = new URL("/ws", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket);
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("websocket connect failed")), {
        once: true,
      });
    });
    return new Par3RpcClient(socket);
  }

  request(tag: string, payload: unknown): Promise<unknown> {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { tag, resolve, reject });
      this.socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }

  close(): void {
    this.socket.close();
  }

  private onMessage(data: string): void {
    const parsed = JSON.parse(data) as ServerMessage | ReadonlyArray<ServerMessage>;
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (message._tag === "Ping") {
        this.socket.send(JSON.stringify({ _tag: "Pong" }));
        continue;
      }
      if (message._tag === "Defect" || message._tag === "ClientProtocolError") {
        this.failAll(new RpcError(message._tag, message.defect ?? message.error));
        continue;
      }
      if (message._tag !== "Exit" || message.requestId === undefined) continue;
      const pending = this.pending.get(String(message.requestId));
      if (pending === undefined) continue;
      this.pending.delete(String(message.requestId));
      if (message.exit?._tag === "Success") pending.resolve(message.exit.value);
      else pending.reject(new RpcError(pending.tag, message.exit?.cause));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
