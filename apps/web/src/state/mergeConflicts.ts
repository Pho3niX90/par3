import { createMergeConflictEnvironmentAtoms } from "@t3tools/client-runtime/state/merge-conflicts";

import { connectionAtomRuntime } from "../connection/runtime";

export const mergeConflictEnvironment = createMergeConflictEnvironmentAtoms(connectionAtomRuntime);
