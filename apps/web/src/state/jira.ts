import {
  createJiraEnvironmentAtoms,
  createThreadJiraMentionAtoms,
} from "@t3tools/client-runtime/state/jira";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadDetails } from "./threads";

export const jiraEnvironment = createJiraEnvironmentAtoms(connectionAtomRuntime);

export const threadJiraMentions = createThreadJiraMentionAtoms(environmentThreadDetails.threadAtom);
