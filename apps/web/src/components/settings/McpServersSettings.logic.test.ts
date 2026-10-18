import type { McpServerConfig, McpServerToolPolicy } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mcpServerNameError, toggleToolAllowed } from "./McpServersSettings.logic";

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
    expect(toggleToolAllowed(allow, offered, "write", true)).toEqual(all);
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
