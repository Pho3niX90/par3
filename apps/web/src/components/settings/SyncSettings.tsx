import type { SyncConflict, SyncEnvironmentView } from "@t3tools/client-runtime/sync/plan";
import type { EnvironmentId, SyncSkipReason } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import {
  describeCommandFailure,
  retrySync,
  useResolveSyncConflict,
  useSyncPlan,
  useSyncRunnerStore,
  useSyncViews,
} from "../../state/sync";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { SyncMergeDialog } from "./SyncMergeDialog";
import { defaultSyncCategories, environmentSyncCounts, syncMergeSides } from "./syncSettings.logic";
import { VaultSettings } from "./VaultSettings";

export function VaultSyncSettingsPanel() {
  return (
    <SettingsPageContainer>
      <VaultSettings />
      <SyncSettings />
    </SettingsPageContainer>
  );
}

const SKIP_REASONS: Record<SyncSkipReason, string> = {
  "needs-vault": "Holds a saved secret; move it to the vault to sync",
  "too-large": "Too large to sync",
  binary: "Binary files don't sync",
  symlink: "Symlinks don't sync",
};

/** MCP servers sync by id; people know them by name. */
function itemName(
  categoryId: string,
  name: string,
  environments: ReadonlyArray<EnvironmentPresentation>,
): string {
  if (categoryId !== "mcpServers") return name;
  for (const environment of environments) {
    const server = environment.serverConfig?.settings.mcpServers.find(
      (candidate) => candidate.id === name,
    );
    if (server) return server.name;
  }
  return name;
}

function SyncSettings() {
  const { environments } = useEnvironments();
  const views = useSyncViews();
  const plan = useSyncPlan();
  const running = useSyncRunnerStore((state) => state.running);
  const errors = useSyncRunnerStore((state) => state.lastErrorByEnvironment);
  const resolveConflict = useResolveSyncConflict();
  const [resolving, setResolving] = useState<string | null>(null);
  const [merging, setMerging] = useState<SyncConflict | null>(null);
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const outdated = connected.filter(
    (environment) => environment.serverConfig?.environment.capabilities.sync !== true,
  );
  const unmanaged = connected.filter(
    (environment) =>
      environment.serverConfig?.environment.capabilities.sync === true &&
      !views.some((view) => view.environmentId === environment.environmentId),
  );
  const labelOf = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "another machine";
  const categoryLabel = (categoryId: string) =>
    views.flatMap((view) => view.snapshot.categories).find((category) => category.id === categoryId)
      ?.label ?? categoryId;

  const resolve = async (conflict: SyncConflict, winner: EnvironmentId | "delete") => {
    setResolving(conflict.key);
    const result = await resolveConflict(conflict.key, winner);
    setResolving(null);
    if (result.failed + result.rejected > 0) {
      toastManager.add({
        type: "error",
        title: `Could not settle ${itemName(conflict.categoryId, conflict.name, environments)}`,
        description: "A machine refused the change or could not be reached.",
      });
    }
  };

  return (
    <SettingsSection
      id="sync"
      title="Sync"
      headerAction={
        Object.keys(errors).length > 0 ? (
          <Button size="xs" variant="ghost" disabled={running} onClick={retrySync}>
            <RefreshCwIcon className="size-3.5" /> Retry
          </Button>
        ) : null
      }
    >
      <div className="space-y-4 px-4 py-4 sm:px-5">
        <p className="text-xs text-muted-foreground">
          Keeps the vault, shared MCP servers, and provider instructions, agents, commands, and
          skills the same on every machine you choose. Syncs while Par3 is connected to both
          machines.
        </p>
        {views.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Connect a machine running a current version of Par3 to sync.
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {views.map((view) => (
              <SyncMachineRow
                key={view.environmentId}
                view={view}
                label={labelOf(view.environmentId)}
                counts={environmentSyncCounts(plan, view.environmentId)}
                error={errors[view.environmentId] ?? null}
                running={running}
                environments={environments}
              />
            ))}
          </ul>
        )}
        {outdated.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Update Par3 on {outdated.map((environment) => environment.label).join(", ")} to sync.
          </p>
        ) : null}
        {unmanaged.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            This connection can't manage sync on{" "}
            {unmanaged.map((environment) => environment.label).join(", ")}.
          </p>
        ) : null}
        {plan.conflicts.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm">Different on each machine</p>
            <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
              {plan.conflicts.map((conflict) => (
                <li key={conflict.key} className="space-y-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="font-mono">
                      {itemName(conflict.categoryId, conflict.name, environments)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      · {categoryLabel(conflict.categoryId)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {syncMergeSides(conflict) === null ? null : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={resolving !== null}
                        onClick={() => setMerging(conflict)}
                      >
                        Merge…
                      </Button>
                    )}
                    {conflict.candidates
                      .filter((candidate) => candidate.hash !== null)
                      .map((candidate) => (
                        <Button
                          key={candidate.environmentId}
                          size="xs"
                          variant="outline"
                          disabled={resolving !== null}
                          onClick={() => void resolve(conflict, candidate.environmentId)}
                        >
                          Keep version from {labelOf(candidate.environmentId)}
                        </Button>
                      ))}
                    <Button
                      size="xs"
                      variant="ghost-destructive"
                      disabled={resolving !== null}
                      onClick={() => void resolve(conflict, "delete")}
                    >
                      {resolving === conflict.key ? <Spinner size="xs" /> : null} Delete everywhere
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <SyncMergeDialog
        conflictKey={merging?.key ?? null}
        title={merging ? itemName(merging.categoryId, merging.name, environments) : ""}
        labelOf={labelOf}
        onClose={() => setMerging(null)}
      />
    </SettingsSection>
  );
}

function SyncMachineRow(props: {
  readonly view: SyncEnvironmentView;
  readonly label: string;
  readonly counts: { readonly pending: number; readonly conflicts: number };
  readonly error: string | null;
  readonly running: boolean;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const { snapshot, environmentId } = props.view;
  const participation = snapshot.participation;
  const setParticipation = useAtomCommand(serverEnvironment.syncSetParticipation, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);

  const save = async (enabled: boolean, categories: ReadonlyArray<string>) => {
    setBusy(true);
    const result = await setParticipation({
      environmentId,
      input: {
        enabled,
        categories: [...categories],
        excluded: [...(participation?.excluded ?? [])],
      },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: `Could not change sync on ${props.label}`,
        description: describeCommandFailure(result),
      });
    }
  };

  const enabled = participation?.enabled === true;
  const categories = participation?.categories ?? [];
  const status = !enabled
    ? participation === null
      ? "Not set up"
      : "Not syncing; files stay as they are"
    : props.error
      ? props.error
      : props.counts.conflicts > 0
        ? `${props.counts.conflicts} ${props.counts.conflicts === 1 ? "item differs" : "items differ"}`
        : props.counts.pending > 0
          ? `${props.counts.pending} pending${props.running ? "…" : ""}`
          : "In sync";
  const skipped = snapshot.items.filter(
    (item) => item.skipped !== undefined && categories.includes(item.categoryId),
  );

  return (
    <li className="space-y-3 px-3 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{props.label}</div>
          <p
            className={
              props.error && enabled ? "text-xs text-destructive" : "text-xs text-muted-foreground"
            }
          >
            {status}
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          Sync this machine
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={(next) =>
              void save(
                next,
                next && categories.length === 0 ? defaultSyncCategories(snapshot) : categories,
              )
            }
          />
        </label>
      </div>
      {enabled ? (
        <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {snapshot.categories.map((category) => (
            <li key={category.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm">{category.label}</div>
                {!category.available && category.unavailableReason ? (
                  <p className="text-xs text-muted-foreground">{category.unavailableReason}</p>
                ) : category.location ? (
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {category.location}
                  </p>
                ) : null}
              </div>
              <Switch
                size="sm"
                checked={categories.includes(category.id)}
                disabled={busy || (!category.available && !categories.includes(category.id))}
                aria-label={`Sync ${category.label} on ${props.label}`}
                onCheckedChange={(next) =>
                  void save(
                    true,
                    next
                      ? [...categories, category.id]
                      : categories.filter((id) => id !== category.id),
                  )
                }
              />
            </li>
          ))}
        </ul>
      ) : null}
      {enabled && skipped.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Stays on this machine</p>
          <ul className="space-y-0.5 text-xs">
            {skipped.map((item) => (
              <li key={item.key}>
                <span className="font-mono">
                  {itemName(item.categoryId, item.name, props.environments)}
                </span>
                <span className="text-muted-foreground"> · {SKIP_REASONS[item.skipped!]}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
