import type { McpServerConfig, McpServerToolPolicy } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  editMcpVariable,
  type McpVariableDraft,
  mcpServerNameError,
  toggleToolAllowed,
} from "./McpServersSettings.logic";

const all: McpServerToolPolicy = { mode: "all", tools: [], readOnlyClientsMayCall: "readOnlyHint" };
const offered = ["lookup", "write", "search"];

describe("toggleToolAllowed", () => {
  it("switches to an allow-list of the other tools when one is unticked under all", () => {
    expect(toggleToolAllowed(all, offered, "write", false)).toEqual({
      ...all,
      mode: "allow",
      tools: ["lookup", "search"],
    });
  });

  it("returns to all once every offered tool is allowed again", () => {
    const allow = { ...all, mode: "allow" as const, tools: ["lookup", "search"] };
    expect(toggleToolAllowed(allow, offered, "write", true)).toMatchObject({ mode: "all" });
  });
});

describe("editMcpVariable", () => {
  const saved: McpVariableDraft = {
    key: "k",
    name: "Authorization",
    value: "",
    sensitive: true,
    valueRedacted: true,
    savedSecretName: "Authorization",
  };

  it("keeps a saved secret when its field is typed into and cleared again", () => {
    const typed = editMcpVariable(saved, { value: "Bearer new" });
    expect(typed.valueRedacted).toBeUndefined();
    expect(editMcpVariable(typed, { value: "" }).valueRedacted).toBe(true);
  });

  it("drops a saved secret once it is renamed, and keeps a new value", () => {
    expect(editMcpVariable(saved, { name: "X-Api-Key" }).valueRedacted).toBeUndefined();
    const replaced = editMcpVariable(saved, { value: "Bearer new" });
    expect(replaced.value).toBe("Bearer new");
    expect(replaced.valueRedacted).toBeUndefined();
  });

  it("never marks a new, empty secret as saved", () => {
    const fresh: McpVariableDraft = { key: "n", name: "Authorization", value: "", sensitive: true };
    expect(editMcpVariable(fresh, { value: "" }).valueRedacted).toBeUndefined();
  });
});

describe("mcpServerNameError", () => {
  const servers = [{ id: "a", name: "linear" }] as unknown as ReadonlyArray<McpServerConfig>;

  it("accepts a new slug and the server's own name", () => {
    expect(mcpServerNameError("sentry", servers, "b")).toBeNull();
    expect(mcpServerNameError("linear", servers, "a")).toBeNull();
  });

  it("rejects names agents could not type or that another server uses", () => {
    expect(mcpServerNameError("Linear Issues", servers, "b")).toMatch(/lowercase/);
    expect(mcpServerNameError("linear", servers, "b")).toMatch(/already/);
  });
});
