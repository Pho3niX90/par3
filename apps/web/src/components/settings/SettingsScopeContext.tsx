import { type EnvironmentId, PROJECT_FILE_NAMES, type T3ProjectFile } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, type ReactNode, useContext } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { getProjectFileQueryAtom, optimisticFileAtom } from "../files/projectFilesQueryState";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { resolveScopedSettingsTargets, selectScopedSettingsEnvironments } from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import { selectSingleEnvironmentScope } from "./settingsScopeAxis";

type ProjectFileMember = readonly [
  environmentId: EnvironmentId,
  workspaceRoot: string,
  physicalProjectKey: string,
];

const memberProjectFilesAtom = Atom.family((membersKey: string) => {
  const members = JSON.parse(membersKey) as ReadonlyArray<ProjectFileMember>;
  return Atom.make((get) => {
    const files = new Map<string, T3ProjectFile | null>();
    for (const [environmentId, workspaceRoot, physicalProjectKey] of members) {
      // Stops at the first file present, so t3.json is only requested when par3.json is missing.
      for (const fileName of PROJECT_FILE_NAMES) {
        const result = get(getProjectFileQueryAtom(environmentId, workspaceRoot, fileName));
        if (result.waiting) {
          files.delete(physicalProjectKey);
          break;
        }
        const data =
          get(optimisticFileAtom(environmentId, workspaceRoot, fileName))?.data ??
          AsyncResult.getOrElse(result, () => null);
        if (data === null || data.exists === false) {
          files.set(physicalProjectKey, null);
          continue;
        }
        files.set(physicalProjectKey, data.truncated ? null : parseT3ProjectFile(data.contents));
        break;
      }
    }
    return files;
  }).pipe(Atom.withLabel(`web-settings-member-project-files:${membersKey}`));
});

function useMemberProjectFiles(scope: ReturnType<typeof resolveSettingsScope>) {
  const members = scope.kind === "project" || scope.kind === "checkout" ? scope.members : [];
  return useAtomValue(
    memberProjectFilesAtom(
      JSON.stringify(
        members.map((member): ProjectFileMember => [
          member.environmentId,
          member.workspaceRoot,
          member.physicalProjectKey,
        ]),
      ),
    ),
  );
}

function useResolvedSettingsScope(rawSearch: SettingsScopeSearch, singleEnvironment: boolean) {
  const groups = useSettingsProjectGroups();
  const { environments: availableEnvironments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const search = singleEnvironment
    ? selectSingleEnvironmentScope(
        rawSearch,
        resolveSettingsScope(rawSearch, groups, availableEnvironments),
        availableEnvironments,
        primaryEnvironmentId,
      )
    : rawSearch;
  const scope = resolveSettingsScope(search, groups, availableEnvironments);
  const projectFiles = useMemberProjectFiles(scope);
  const selected = selectScopedSettingsEnvironments(
    scope,
    availableEnvironments,
    primaryEnvironmentId,
  );
  const targets = resolveScopedSettingsTargets(scope, selected.connectedEnvironments, projectFiles);
  const target =
    targets.find((candidate) => candidate.environmentId === selected.environment?.environmentId) ??
    targets[0] ??
    null;
  return { scope, groups, search, ...selected, targets, target };
}

const SettingsScopeContext = createContext<
  | (ReturnType<typeof useResolvedSettingsScope> & {
      singleEnvironment: boolean;
      search: SettingsScopeSearch;
      selectScope: (next: SettingsScopeSearch) => void;
    })
  | null
>(null);

export function SettingsScopeProvider({
  search,
  onChange,
  children,
  singleEnvironment = false,
}: {
  singleEnvironment?: boolean;
  search: SettingsScopeSearch;
  onChange: (next: SettingsScopeSearch) => void;
  children: ReactNode;
}) {
  const resolved = useResolvedSettingsScope(search, singleEnvironment);
  const value = { ...resolved, singleEnvironment, selectScope: onChange };
  return <SettingsScopeContext value={value}>{children}</SettingsScopeContext>;
}

export function useOptionalSettingsScope() {
  return useContext(SettingsScopeContext);
}

export function useSettingsScope() {
  const scope = useOptionalSettingsScope();
  if (scope === null) throw new Error("Settings scope must be read inside SettingsScopeProvider.");
  return scope;
}
