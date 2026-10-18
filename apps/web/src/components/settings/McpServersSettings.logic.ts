import {
  isMcpServerHttpUrl,
  McpServerName,
  type McpServerConfig,
  type McpServerHeader,
  type McpServerToolPolicy,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isServerName = Schema.is(McpServerName);

export function mcpServerNameError(
  name: string,
  servers: ReadonlyArray<McpServerConfig>,
  id: string,
): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Enter a name.";
  if (!isServerName(trimmed)) {
    return "Use lowercase letters, digits, - and _, starting with a letter or digit.";
  }
  return servers.some((server) => server.id !== id && server.name === trimmed)
    ? "Another server already uses this name."
    : null;
}

const VARIABLE_NAME_PATTERNS = {
  env: /^[A-Za-z_][A-Za-z0-9_]*$/,
  header: /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/,
} as const;

export function mcpVariableNameValid(kind: "env" | "header", name: string): boolean {
  return VARIABLE_NAME_PATTERNS[kind].test(name.trim());
}

export function mcpServerUrlValid(url: string): boolean {
  return isMcpServerHttpUrl(url.trim());
}

export type McpVariableDraft = McpServerHeader & {
  readonly key: string;
  /** The name a saved secret was stored under; its value never reaches the client. */
  readonly savedSecretName?: string;
};

/**
 * A saved secret shows as an empty field. Typing into it and clearing it again under the same name
 * keeps the saved value instead of saving an empty one; a renamed secret must be entered again.
 */
export function editMcpVariable(
  variable: McpVariableDraft,
  change: Partial<Pick<McpServerHeader, "name" | "value" | "sensitive">>,
): McpVariableDraft {
  const { valueRedacted: _, ...rest } = variable;
  const next = { ...rest, ...change };
  return next.sensitive && next.value === "" && next.savedSecretName === next.name.trim()
    ? { ...next, valueRedacted: true }
    : next;
}

/**
 * Unticking a tool under `all` switches to an allow-list of every other tool the server offers.
 * The list is kept under `all`, as the contract says.
 */
export function toggleToolAllowed(
  policy: McpServerToolPolicy,
  offeredTools: ReadonlyArray<string>,
  tool: string,
  allowed: boolean,
): McpServerToolPolicy {
  const current = policy.mode === "all" ? offeredTools : policy.tools;
  const tools = allowed
    ? [...new Set([...current, tool])]
    : current.filter((candidate) => candidate !== tool);
  return offeredTools.every((candidate) => tools.includes(candidate))
    ? { ...policy, mode: "all", tools }
    : { ...policy, mode: "allow", tools };
}

export function upsertMcpServer(
  servers: ReadonlyArray<McpServerConfig>,
  server: McpServerConfig,
): ReadonlyArray<McpServerConfig> {
  return servers.some((candidate) => candidate.id === server.id)
    ? servers.map((candidate) => (candidate.id === server.id ? server : candidate))
    : [...servers, server];
}

export function parseMcpServerArgs(text: string): ReadonlyArray<string> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function describeMcpServerTransport(server: McpServerConfig): string {
  return server.transport.type === "http"
    ? server.transport.url
    : [server.transport.command, ...server.transport.args].join(" ");
}
