import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createJiraEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // The server caches each issue for a minute, so a panel left open keeps its status current.
    issue: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:jira:issue",
      tag: WS_METHODS.jiraIssue,
      staleTimeMs: 60_000,
      refreshIntervalMs: 5 * 60_000,
    }),
  };
}
