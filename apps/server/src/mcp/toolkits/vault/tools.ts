import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  VaultEntry,
  VaultError,
  VaultSecretName,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as VaultService from "../../../vault/VaultService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  VaultService.VaultService,
];

const failure = Schema.Union([VaultError, OrchestratorMcpFailure, McpCapabilityUnavailableError]);

const VaultListTool = Tool.make("vault_list", {
  description:
    "List the secrets in the user's Par3 vault: names, descriptions, and whether agents may read them. Never returns values. Prefer using a secret by reference: settings fields such as provider environment variables and shared MCP server headers accept `vault:NAME`, which Par3 fills in on the server.",
  success: Schema.Struct({ entries: Schema.Array(VaultEntry) }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List vault secrets")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SecretGetTool = Tool.make("secret_get", {
  description:
    "Read a secret's value from the user's Par3 vault. Only secrets the user marked as readable by agents, and only from a full-access thread; every read is recorded for the user. Use this only when a value must appear in a command or file. The value lands in this conversation, so never echo it back, write it to the repository, or pass it to another agent.",
  parameters: Schema.Struct({ name: VaultSecretName }),
  success: Schema.Struct({ name: Schema.String, value: Schema.String }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a vault secret")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const VaultToolkit = Toolkit.make(VaultListTool, SecretGetTool);
