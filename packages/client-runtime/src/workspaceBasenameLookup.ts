import { isAbsolutePath, isWindowsAbsolutePath } from "@t3tools/shared/path";

export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// One counter for every caller: they all open the same panel, so the newest
// click wins regardless of which one started the lookup.
let latestLookupSequence = 0;

export function claimWorkspaceBasenameLookup(): () => boolean {
  latestLookupSequence += 1;
  const claimed = latestLookupSequence;
  return () => claimed === latestLookupSequence;
}

export interface WorkspaceEntryCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function needsWorkspaceBasenameLookup(relativePath: string): boolean {
  const trimmed = relativePath.trim();
  return (
    trimmed !== "." &&
    trimmed !== ".." &&
    trimmed.length > 0 &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  );
}

export function pickWorkspaceBasenameMatch(
  basename: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const target = basename.trim();
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  const exact = files.find((entry) => basenameOfPath(entry.path) === target);
  if (exact) return exact.path;
  const folded = target.toLowerCase();
  const foldedMatches = files.filter(
    (entry) => basenameOfPath(entry.path).toLowerCase() === folded,
  );
  return foldedMatches.length === 1 ? (foldedMatches[0]?.path ?? null) : null;
}

// Repository-relative paths can repeat the project's suffix in subfolder projects.
function stripRepeatedWorkspacePrefix(relativePath: string, cwd: string): string | null {
  if (isAbsolutePath(relativePath)) return null;
  const pathSegments = relativePath.split(/[\\/]+/);
  const cwdSegments = cwd.split(/[\\/]+/).filter(Boolean);
  const fold = isWindowsAbsolutePath(cwd)
    ? (segment: string | undefined) => segment?.toLowerCase()
    : (segment: string | undefined) => segment;
  for (let count = Math.min(cwdSegments.length, pathSegments.length - 1); count > 0; count--) {
    const prefix = cwdSegments.slice(-count);
    if (prefix.every((segment, index) => fold(segment) === fold(pathSegments[index]))) {
      return pathSegments.slice(count).join("/") || null;
    }
  }
  return null;
}

function workspacePathKey(cwd: string): (path: string) => string {
  const caseInsensitive = isWindowsAbsolutePath(cwd);
  return (path) => {
    const normalized = path.replaceAll("\\", "/");
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
}

function pickStrippedWorkspaceMatch(
  strippedPath: string,
  cwd: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const key = workspacePathKey(cwd);
  const files = entries.filter((entry) => entry.kind === "file");
  return files.find((entry) => key(entry.path) === key(strippedPath))?.path ?? null;
}

// Agents name files relative to the directory their shell `cd`ed into, which
// can be any subfolder of the project. Only a single candidate is trusted.
function pickSubfolderWorkspaceMatch(
  relativePath: string,
  cwd: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const key = workspacePathKey(cwd);
  const suffix = `/${key(relativePath)}`;
  const matches = entries.filter(
    (entry) => entry.kind === "file" && key(entry.path).endsWith(suffix),
  );
  return matches.length === 1 ? (matches[0]?.path ?? null) : null;
}

function isPlainRelativePath(path: string): boolean {
  return (
    !isAbsolutePath(path) &&
    !path.startsWith("~") &&
    path.split(/[\\/]/).every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export interface WorkspaceFileLookup {
  readonly query: string;
  readonly pick: (entries: ReadonlyArray<WorkspaceEntryCandidate>) => string | null;
}

/**
 * How to find the file a workspace-relative link means when nothing exists at
 * that path. Callers check the literal path first: a link that resolves as
 * written always wins.
 */
export function workspaceFileLookup(relativePath: string, cwd: string): WorkspaceFileLookup | null {
  if (needsWorkspaceBasenameLookup(relativePath)) {
    return {
      query: relativePath,
      pick: (entries) => pickWorkspaceBasenameMatch(relativePath, entries),
    };
  }
  const strippedPath = stripRepeatedWorkspacePrefix(relativePath, cwd);
  if (strippedPath !== null) {
    return {
      query: strippedPath,
      pick: (entries) => pickStrippedWorkspaceMatch(strippedPath, cwd, entries),
    };
  }
  return isPlainRelativePath(relativePath)
    ? {
        query: relativePath,
        pick: (entries) => pickSubfolderWorkspaceMatch(relativePath, cwd, entries),
      }
    : null;
}
