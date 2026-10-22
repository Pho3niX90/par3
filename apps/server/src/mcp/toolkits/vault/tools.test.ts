import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { VaultToolkit } from "./tools.ts";

it("advertises an object root for the parameterless vault list tool", () => {
  expect(Tool.getJsonSchema(VaultToolkit.tools.vault_list)).toMatchObject({ type: "object" });
});
