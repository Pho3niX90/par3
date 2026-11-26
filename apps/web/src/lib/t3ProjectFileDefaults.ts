import {
  PROJECT_FILE_NAMES,
  type EnvironmentId,
  type ProjectReadFileResult,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

function toT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  fileName: string,
  result: ProjectReadFileResult | null,
): T3ProjectFile | null | "missing" {
  const data = resolveProjectFileQueryData(environmentId, workspaceRoot, fileName, result);
  if (data === null || data.exists === false) return "missing";
  return data.truncated ? null : parseT3ProjectFile(data.contents);
}

export async function readT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<T3ProjectFile | null> {
  for (const fileName of PROJECT_FILE_NAMES) {
    const result = await executeAtomQuery(
      appAtomRegistry,
      getProjectFileQueryAtom(environmentId, workspaceRoot, fileName),
      { reportDefect: false, reportFailure: false, signal },
    );
    const parsed = toT3ProjectFile(
      environmentId,
      workspaceRoot,
      fileName,
      result._tag === "Success" ? result.value : null,
    );
    if (parsed === "missing") continue;
    return parsed;
  }
  return null;
}

/** The project's par3.json/t3.json from an earlier read, or `undefined` when none has loaded yet. */
export function peekT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): T3ProjectFile | null | undefined {
  for (const fileName of PROJECT_FILE_NAMES) {
    const result = appAtomRegistry.get(
      getProjectFileQueryAtom(environmentId, workspaceRoot, fileName),
    );
    if (!AsyncResult.isSuccess(result)) return undefined;
    const parsed = toT3ProjectFile(environmentId, workspaceRoot, fileName, result.value);
    if (parsed !== "missing") return parsed;
  }
  return null;
}
