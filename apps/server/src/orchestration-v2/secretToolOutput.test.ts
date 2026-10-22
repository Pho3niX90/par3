import { NodeId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { REDACTED_SECRET_OUTPUT, redactSecretToolOutput } from "./secretToolOutput.ts";

const now = DateTime.makeUnsafe("2026-10-06T00:00:00.000Z");

const toolItem = (toolName: string, output: unknown): OrchestrationV2TurnItem => ({
  id: TurnItemId.make("turn-item:tool"),
  threadId: ThreadId.make("thread:tool"),
  runId: null,
  nodeId: NodeId.make("node:tool"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  type: "dynamic_tool",
  toolName,
  input: { name: "API_TOKEN" },
  output,
});

const outputOf = (item: OrchestrationV2TurnItem) =>
  item.type === "dynamic_tool" ? item.output : undefined;

describe("redactSecretToolOutput", () => {
  it.each([
    "mcp__t3-code__secret_get",
    "t3-code.secret_get",
    "t3-code-thread_1_secret_get",
    "secret_get",
  ])("withholds the value %s returns", (toolName) => {
    const item = toolItem(toolName, { name: "API_TOKEN", value: "s3cret-value" });
    expect(outputOf(redactSecretToolOutput(item))).toBe(REDACTED_SECRET_OUTPUT);
  });

  it("keeps the reason a read failed, which never holds a value", () => {
    const failure = { _tag: "VaultError", reason: "not-allowed", message: "Not readable." };
    const item = toolItem("mcp__t3-code__secret_get", { isError: true, content: [failure] });
    expect(redactSecretToolOutput(item)).toBe(item);
  });

  it("leaves other tools, including other servers' secret_get, alone", () => {
    for (const toolName of ["mcp__t3-code__vault_list", "mcp__other__secret_get", "Read"]) {
      const item = toolItem(toolName, { value: "kept" });
      expect(redactSecretToolOutput(item)).toBe(item);
    }
  });

  it("leaves a call that has no output yet alone", () => {
    const item = toolItem("mcp__t3-code__secret_get", undefined);
    expect(redactSecretToolOutput(item)).toBe(item);
  });
});
