import {
  WS_METHODS,
  type JiraIssueKey,
  type OrchestrationV2ConversationMessage,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { findJiraIssueKeys, normalizeJiraProjectKeys } from "@t3tools/shared/jira";
import { Atom } from "effect/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { arrayElementsEqual, parseThreadKey, threadKey } from "./entities.ts";
import type { EnvironmentThread } from "./models.ts";

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

/** A thread can mention many issues; the details card shows only the latest few. */
export const MAX_MENTIONED_JIRA_ISSUES = 5;

const EMPTY_KEYS: ReadonlyArray<JiraIssueKey> = [];

/**
 * Issue keys of the given projects mentioned in finished user and assistant messages, most
 * recently mentioned first. `scan` caches each message's keys, so only new messages are read.
 */
export function mentionedJiraIssueKeys(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  projectKeys: ReadonlyArray<string>,
  scan: (message: OrchestrationV2ConversationMessage) => ReadonlyArray<JiraIssueKey> = (message) =>
    findJiraIssueKeys({ branch: null, texts: [message.text], projectKeys }),
): JiraIssueKey[] {
  const keys: JiraIssueKey[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.streaming || message.role === "system") continue;
    for (const key of scan(message)) {
      if (keys.includes(key)) continue;
      keys.push(key);
      if (keys.length === MAX_MENTIONED_JIRA_ISSUES) return keys;
    }
  }
  return keys;
}

/**
 * Per thread and project keys, the Jira issues its messages mention. The value keeps its
 * identity until the set of keys changes, so a streaming reply does not re-render readers.
 */
export function createThreadJiraMentionAtoms(
  threadAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThread | null>,
) {
  const family = Atom.family((key: string) => {
    const separator = key.indexOf("\n");
    const ref = parseThreadKey(key.slice(0, separator));
    const projectKeys = key.slice(separator + 1).split(",");
    const scanned = new WeakMap<object, ReadonlyArray<JiraIssueKey>>();
    const scan = (message: OrchestrationV2ConversationMessage) => {
      let keys = scanned.get(message);
      if (keys === undefined) {
        keys = findJiraIssueKeys({ branch: null, texts: [message.text], projectKeys });
        scanned.set(message, keys);
      }
      return keys;
    };
    let previous = EMPTY_KEYS;
    return Atom.make((get) => {
      const messages = get(threadAtom(ref))?.projection.messages ?? [];
      const keys = mentionedJiraIssueKeys(messages, projectKeys, scan);
      if (!arrayElementsEqual(keys, previous)) previous = keys.length === 0 ? EMPTY_KEYS : keys;
      return previous;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`thread-jira-mentions:${key}`));
  });
  const empty = Atom.make(EMPTY_KEYS).pipe(Atom.keepAlive);
  return {
    /** Without project keys nothing matches, since chat mentions `UTF-8` far more than issues. */
    mentionsAtom: (ref: ScopedThreadRef | null, projectKeys: ReadonlyArray<string>) => {
      const keys = normalizeJiraProjectKeys(projectKeys);
      return ref === null || keys.length === 0
        ? empty
        : family(`${threadKey(ref)}\n${keys.join(",")}`);
    },
  };
}
