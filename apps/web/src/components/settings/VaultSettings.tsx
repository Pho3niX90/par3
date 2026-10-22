import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type VaultEntry,
  type VaultImportCandidate,
  type VaultListResult,
  type VaultMutation,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { KeyRoundIcon, MoreVertical, PlusIcon } from "lucide-react";
import { useContext, useEffect, useEffectEvent, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { describeCommandFailure, useSyncViews } from "../../state/sync";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SecretInput } from "./SecretInput";
import { SettingsSection } from "./settingsLayout";
import { vaultSecretNameError } from "./vaultSettings.logic";

const vaultListsAtom = environmentAtomList("web-vault-lists", (environmentId) =>
  serverEnvironment.vaultList({ environmentId, input: {} }),
);

const vaultListAtom = (environmentId: EnvironmentId) =>
  serverEnvironment.vaultList({ environmentId, input: {} });

function isVaultEnvironment(environment: EnvironmentPresentation): boolean {
  return (
    environment.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.vault === true
  );
}

interface VaultMachine {
  readonly environment: EnvironmentPresentation;
  readonly data: VaultListResult | null;
  readonly error: string | null;
}

export function VaultSettings() {
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const vaultEnvironments = connected.filter(isVaultEnvironment);
  const outdated = connected.filter((environment) => !isVaultEnvironment(environment));
  const results = useAtomValue(
    vaultListsAtom(environmentIdsKey(vaultEnvironments.map(({ environmentId }) => environmentId))),
  );
  const machines: VaultMachine[] = vaultEnvironments.map((environment, index) => {
    const result = results[index];
    return {
      environment,
      data: result ? Option.getOrNull(AsyncResult.value(result)) : null,
      error: result?._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    };
  });
  const members = machines.filter((machine) => machine.data?.status.member === true);

  return (
    <SettingsSection id="vault" title="Vault">
      <div className="space-y-4 px-4 py-4 sm:px-5">
        <p className="text-xs text-muted-foreground">
          Secrets stored once and used by name as <code>vault:NAME</code> in provider and MCP server
          settings. Values never reach this app; machines pass them to each other only encrypted
          with the vault key.
        </p>
        {vaultEnvironments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Connect a machine running a current version of Par3 to use the vault.
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {machines.map((machine) => (
              <VaultMachineRow
                key={machine.environment.environmentId}
                machine={machine}
                members={members.filter(
                  (member) =>
                    member.environment.environmentId !== machine.environment.environmentId,
                )}
                anyMember={members.length > 0}
              />
            ))}
          </ul>
        )}
        {outdated.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Update Par3 on {outdated.map((environment) => environment.label).join(", ")} to use the
            vault there.
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function useRunVaultMutation(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const mutate = useAtomCommand(serverEnvironment.vaultMutate, { reportFailure: false });
  return async (input: VaultMutation, failureTitle: string): Promise<VaultListResult | null> => {
    const result = await mutate({ environmentId, input });
    registry.refresh(vaultListAtom(environmentId));
    if (result._tag === "Success") return result.value;
    toastManager.add({
      type: "error",
      title: failureTitle,
      description: describeCommandFailure(result),
    });
    return null;
  };
}

function VaultMachineRow(props: {
  readonly machine: VaultMachine;
  readonly members: ReadonlyArray<VaultMachine>;
  readonly anyMember: boolean;
}) {
  const { environment, data, error } = props.machine;
  const environmentId = environment.environmentId;
  const registry = useContext(RegistryContext);
  const canWrite = useAtomValue(serverEnvironment.vaultMutate.permissionAtom(environmentId));
  const isOwner = useAtomValue(
    serverEnvironment.vaultMutate.permissionAtom(environmentId, { _tag: "create" }),
  );
  const runMutation = useRunVaultMutation(environmentId);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<VaultEntry | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [joining, setJoining] = useState(false);

  // Secrets arrive from other machines through sync; a changed vault category means a stale list.
  const syncView = useSyncViews().find((view) => view.environmentId === environmentId);
  const vaultItemsKey = (syncView?.snapshot.items ?? [])
    .filter((item) => item.categoryId === "vault")
    .map((item) => `${item.name}:${item.hash}`)
    .join(",");
  useEffect(() => {
    if (vaultItemsKey !== "") registry.refresh(vaultListAtom(environmentId));
  }, [registry, environmentId, vaultItemsKey]);

  const run = async (input: VaultMutation, failureTitle: string) => {
    setBusy(true);
    const result = await runMutation(input, failureTitle);
    setBusy(false);
    return result;
  };

  const leave = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Leave the vault on ${environment.label}?\nThis deletes the vault key and every secret stored on this machine. Settings that use vault:NAME there stop working.`,
      { variant: "destructive" },
    );
    if (confirmed)
      await run({ _tag: "leave" }, `Could not leave the vault on ${environment.label}`);
  };

  const remove = async (entry: VaultEntry) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Delete ${entry.name} from the vault?\nMachines that sync the vault delete it too.`,
      { variant: "destructive" },
    );
    if (confirmed)
      await run({ _tag: "delete", name: entry.name }, `Could not delete ${entry.name}`);
  };

  const member = data?.status.member === true;
  return (
    <li className="space-y-3 px-3 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{environment.label}</div>
          <p className="text-xs text-muted-foreground">
            {data === null
              ? (error ?? "Loading…")
              : member
                ? `In the vault${data.status.vaultFingerprint ? ` ${data.status.vaultFingerprint}` : ""}`
                : "Not in the vault"}
          </p>
          {data ? (
            <p className="text-xs text-muted-foreground">
              This machine's vault key fingerprint:{" "}
              <span className="font-mono">{data.status.recipient.fingerprint}</span>
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {data === null ? null : member ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={!canWrite || busy}
                onClick={() => setEditing("new")}
              >
                <PlusIcon className="size-3.5" /> Add secret
              </Button>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={busy}
                      aria-label={`Vault options for ${environment.label}`}
                    />
                  }
                >
                  <MoreVertical />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem disabled={!canWrite} onClick={() => setImporting(true)}>
                    Import existing secrets
                  </MenuItem>
                  <MenuItem variant="destructive" disabled={!isOwner} onClick={() => void leave()}>
                    Leave vault on this machine
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </>
          ) : props.anyMember ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!isOwner || busy || props.members.length === 0}
              onClick={() => setJoining(true)}
            >
              Join vault
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={!isOwner || busy}
              onClick={() =>
                void run({ _tag: "create" }, `Could not create a vault on ${environment.label}`)
              }
            >
              {busy ? <Spinner size="xs" /> : null} Create vault on {environment.label}
            </Button>
          )}
        </div>
      </div>
      {member && data ? (
        <>
          {data.entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">No secrets yet.</p>
          ) : (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {data.entries.map((entry) => (
                <li key={entry.name} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="font-mono text-sm">{entry.name}</div>
                    <p className="truncate text-xs text-muted-foreground">
                      {entry.description ? `${entry.description} · ` : ""}
                      Updated {formatRelativeTimeLabel(entry.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      Agents may read
                      <Switch
                        size="sm"
                        checked={entry.agentReadable}
                        disabled={!canWrite || busy}
                        onCheckedChange={(agentReadable) =>
                          void run(
                            { _tag: "setAgentReadable", name: entry.name, agentReadable },
                            `Could not change ${entry.name}`,
                          )
                        }
                      />
                    </label>
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost-muted"
                            disabled={!canWrite || busy}
                            aria-label={`${entry.name} options`}
                          />
                        }
                      >
                        <MoreVertical />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem onClick={() => setEditing(entry)}>Edit</MenuItem>
                        <MenuItem variant="destructive" onClick={() => void remove(entry)}>
                          Delete
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data.audit.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Recent agent reads</p>
              <ul className="space-y-0.5 text-xs">
                {data.audit.slice(0, 10).map((entry) => (
                  <li key={`${entry.name}:${entry.at}`} className="flex gap-2">
                    <span className="font-mono">{entry.name}</span>
                    <span
                      className={
                        entry.outcome === "read" ? "text-muted-foreground" : "text-destructive"
                      }
                    >
                      {entry.outcome}
                    </span>
                    <span className="text-muted-foreground">
                      {formatRelativeTimeLabel(entry.at)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      {editing !== null ? (
        <VaultSecretDialog
          entry={editing === "new" ? null : editing}
          existingNames={data?.entries.map((entry) => entry.name) ?? []}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            const saved = await run(input, `Could not save ${input.name}`);
            if (saved) setEditing(null);
          }}
        />
      ) : null}
      {importing ? (
        <VaultImportDialog
          environmentId={environmentId}
          existingNames={data?.entries.map((entry) => entry.name) ?? []}
          onClose={() => setImporting(false)}
          onImport={async (items) => {
            const imported = await run(
              { _tag: "import", items },
              `Could not import secrets on ${environment.label}`,
            );
            if (imported) {
              setImporting(false);
              toastManager.add({
                type: "success",
                title: `Moved ${items.length} ${items.length === 1 ? "secret" : "secrets"} into the vault`,
              });
            }
          }}
        />
      ) : null}
      {joining && data ? (
        <JoinVaultDialog
          joiner={environment}
          recipient={data.status.recipient}
          members={props.members.map((member) => member.environment)}
          onClose={() => setJoining(false)}
        />
      ) : null}
    </li>
  );
}

function VaultSecretDialog(props: {
  readonly entry: VaultEntry | null;
  readonly existingNames: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onSave: (input: Extract<VaultMutation, { _tag: "set" }>) => Promise<void>;
}) {
  const isNew = props.entry === null;
  const [name, setName] = useState(props.entry?.name ?? "");
  const [description, setDescription] = useState(props.entry?.description ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const nameError = isNew ? vaultSecretNameError(name, props.existingNames) : null;
  const valid = nameError === null && (!isNew || value !== "");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup
        showCloseButton={!busy}
        render={
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (!valid || busy) return;
              setBusy(true);
              await props.onSave({
                _tag: "set",
                name: name.trim(),
                description: description.trim(),
                ...(value === "" ? {} : { value }),
              });
              setBusy(false);
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>{isNew ? "Add secret" : `Edit ${props.entry?.name}`}</DialogTitle>
          <DialogDescription>
            Use it in settings as <code>vault:{name.trim() || "NAME"}</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="block space-y-1.5 text-sm">
            <span>Name</span>
            <Input
              autoFocus={isNew}
              required
              value={name}
              disabled={!isNew || busy}
              spellCheck={false}
              placeholder="OPENAI_API_KEY"
              onChange={(event) => setName(event.target.value)}
            />
            {name !== "" && nameError ? (
              <span className="block text-xs text-destructive">{nameError}</span>
            ) : null}
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>Description</span>
            <Input
              value={description}
              maxLength={500}
              disabled={busy}
              placeholder="What it unlocks"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>Value</span>
            <SecretInput
              autoFocus={!isNew}
              configured={!isNew}
              value={value}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !valid}>
            {busy ? <Spinner size="xs" /> : null} Save secret
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

type ImportDraft = VaultImportCandidate & { readonly selected: boolean; readonly name: string };

function VaultImportDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly existingNames: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onImport: (items: ReadonlyArray<{ id: string; name: string }>) => Promise<void>;
}) {
  const loadCandidates = useAtomCommand(serverEnvironment.vaultImportCandidates, {
    reportFailure: false,
  });
  const [drafts, setDrafts] = useState<ReadonlyArray<ImportDraft> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { environmentId } = props;
  const load = useEffectEvent(async () => {
    const result = await loadCandidates({ environmentId, input: {} });
    if (result._tag !== "Success") {
      setLoadError(describeCommandFailure(result));
      return;
    }
    setDrafts(
      result.value.candidates.map((candidate) => ({
        ...candidate,
        selected: true,
        name: candidate.suggestedName,
      })),
    );
  });
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    void load();
  }, []);

  const selected = (drafts ?? []).filter((draft) => draft.selected);
  const names = selected.map((draft) => draft.name.trim());
  const errors = new Map(
    selected.map((draft, index) => [
      draft.id,
      vaultSecretNameError(draft.name, [
        ...props.existingNames,
        ...names.filter((_, at) => at !== index),
      ]),
    ]),
  );
  const valid = selected.length > 0 && [...errors.values()].every((error) => error === null);
  const update = (id: string, patch: Partial<ImportDraft>) =>
    setDrafts((current) =>
      (current ?? []).map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)),
    );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Import existing secrets</DialogTitle>
          <DialogDescription>
            Moves secrets saved in this machine's settings into the vault and points those settings
            at <code>vault:NAME</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {drafts === null ? (
            loadError ? (
              <p className="text-sm text-destructive">{loadError}</p>
            ) : (
              <Spinner size="xs" />
            )
          ) : drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No saved secrets to import.</p>
          ) : (
            <ul className="space-y-2">
              {drafts.map((draft) => {
                const error = errors.get(draft.id) ?? null;
                return (
                  <li key={draft.id} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={draft.selected}
                      disabled={busy}
                      onCheckedChange={(next) => update(draft.id, { selected: next })}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="truncate text-xs text-muted-foreground">{draft.label}</p>
                      <Input
                        aria-label={`Vault name for ${draft.label}`}
                        value={draft.name}
                        disabled={busy || !draft.selected}
                        spellCheck={false}
                        onChange={(event) => update(draft.id, { name: event.target.value })}
                      />
                      {error ? <p className="text-xs text-destructive">{error}</p> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !valid}
            onClick={async () => {
              setBusy(true);
              await props.onImport(
                selected.map((draft) => ({ id: draft.id, name: draft.name.trim() })),
              );
              setBusy(false);
            }}
          >
            {busy ? <Spinner size="xs" /> : null} Import {selected.length}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function JoinVaultDialog(props: {
  readonly joiner: EnvironmentPresentation;
  readonly recipient: VaultListResult["status"]["recipient"];
  readonly members: ReadonlyArray<EnvironmentPresentation>;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const [memberId, setMemberId] = useState(props.members[0]?.environmentId ?? null);
  const member = props.members.find((candidate) => candidate.environmentId === memberId);
  const canWrap = useAtomValue(serverEnvironment.vaultWrapKeyFor.permissionAtom(memberId));
  const wrapKey = useAtomCommand(serverEnvironment.vaultWrapKeyFor, { reportFailure: false });
  const mutate = useAtomCommand(serverEnvironment.vaultMutate, { reportFailure: false });
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    if (!member) return;
    setBusy(true);
    setError(null);
    const wrapped = await wrapKey({
      environmentId: member.environmentId,
      input: { recipient: props.recipient },
    });
    if (wrapped._tag !== "Success") {
      setBusy(false);
      setError(describeCommandFailure(wrapped));
      return;
    }
    const accepted = await mutate({
      environmentId: props.joiner.environmentId,
      input: { _tag: "acceptKey", wrapped: wrapped.value },
    });
    registry.refresh(vaultListAtom(props.joiner.environmentId));
    setBusy(false);
    if (accepted._tag !== "Success") {
      setError(describeCommandFailure(accepted));
      return;
    }
    toastManager.add({
      type: "success",
      title: `${props.joiner.label} joined the vault`,
      description: "Turn on Vault secrets under Sync to copy the secrets to it.",
    });
    props.onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Join {props.joiner.label} to the vault?</DialogTitle>
          <DialogDescription>
            {member?.label ?? "A vault machine"} hands its vault key to {props.joiner.label},
            encrypted so only that machine can open it. Anyone who controls {props.joiner.label} can
            then read every secret.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {props.members.length > 1 ? (
            <div className="flex flex-wrap gap-1.5 text-sm">
              <span className="text-muted-foreground">Key from</span>
              {props.members.map((candidate) => (
                <Button
                  key={candidate.environmentId}
                  size="xs"
                  variant={candidate.environmentId === memberId ? "secondary" : "ghost"}
                  disabled={busy}
                  onClick={() => setMemberId(candidate.environmentId)}
                >
                  {candidate.label}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="space-y-1 text-sm">
            <p>{props.joiner.label}'s vault key fingerprint</p>
            <p className="font-mono text-base">{props.recipient.fingerprint}</p>
            <p className="text-xs text-muted-foreground">
              Open Par3 on {props.joiner.label} itself and check that Settings, Vault & sync shows
              the same fingerprint under "This machine's vault key fingerprint".
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={confirmed}
              disabled={busy}
              onCheckedChange={(next) => setConfirmed(next)}
            />
            The fingerprints match
          </label>
          {!canWrap && member ? (
            <p className="text-xs text-muted-foreground">
              This connection can't hand out the vault key on {member.label}.
            </p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !confirmed || !canWrap || !member} onClick={() => void join()}>
            {busy ? <Spinner size="xs" /> : <KeyRoundIcon className="size-3.5" />} Join vault
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
