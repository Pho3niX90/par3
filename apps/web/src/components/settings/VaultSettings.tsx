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
import { T, useGT, useMessages, Var } from "gt-react";
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
  const gt = useGT();
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
    <SettingsSection id="vault" title={gt("Vault")}>
      <div className="space-y-4 px-4 py-4 sm:px-5">
        <p className="text-xs text-muted-foreground">
          <T>
            Secrets stored once and used by name as <code>vault:NAME</code> in provider and MCP
            server settings. Values never reach this app; machines pass them to each other only
            encrypted with the vault key.
          </T>
        </p>
        {vaultEnvironments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <T>Connect a machine running a current version of Par3 to use the vault.</T>
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
            <T>
              Update Par3 on{" "}
              <Var>{outdated.map((environment) => environment.label).join(", ")}</Var> to use the
              vault there.
            </T>
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
  const gt = useGT();
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the vault list atom when sync reports changed vault items
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
      gt(
        "Leave the vault on {label}?\nThis deletes the vault key and every secret stored on this machine. Settings that use vault:NAME there stop working.",
        { label: environment.label },
      ),
      { variant: "destructive" },
    );
    if (confirmed) {
      await run(
        { _tag: "leave" },
        gt("Could not leave the vault on {label}", { label: environment.label }),
      );
    }
  };

  const remove = async (entry: VaultEntry) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      gt("Delete {name} from the vault?\nMachines that sync the vault delete it too.", {
        name: entry.name,
      }),
      { variant: "destructive" },
    );
    if (confirmed) {
      await run(
        { _tag: "delete", name: entry.name },
        gt("Could not delete {name}", { name: entry.name }),
      );
    }
  };

  const member = data?.status.member === true;
  return (
    <li className="space-y-3 px-3 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{environment.label}</div>
          <p className="text-xs text-muted-foreground">
            {data === null
              ? (error ?? gt("Loading…"))
              : member
                ? data.status.vaultFingerprint
                  ? gt("In the vault {fingerprint}", { fingerprint: data.status.vaultFingerprint })
                  : gt("In the vault")
                : gt("Not in the vault")}
          </p>
          {data ? (
            <p className="text-xs text-muted-foreground">
              <T>
                This machine's vault key fingerprint:{" "}
                <span className="font-mono">
                  <Var>{data.status.recipient.fingerprint}</Var>
                </span>
              </T>
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
                <PlusIcon className="size-3.5" /> <T>Add secret</T>
              </Button>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={busy}
                      aria-label={gt("Vault options for {label}", { label: environment.label })}
                    />
                  }
                >
                  <MoreVertical />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem disabled={!canWrite} onClick={() => setImporting(true)}>
                    <T>Import existing secrets</T>
                  </MenuItem>
                  <MenuItem variant="destructive" disabled={!isOwner} onClick={() => void leave()}>
                    <T>Leave vault on this machine</T>
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
              <T>Join vault</T>
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={!isOwner || busy}
              onClick={() =>
                void run(
                  { _tag: "create" },
                  gt("Could not create a vault on {label}", { label: environment.label }),
                )
              }
            >
              {busy ? <Spinner size="xs" /> : null}{" "}
              <T>
                Create vault on <Var>{environment.label}</Var>
              </T>
            </Button>
          )}
        </div>
      </div>
      {member && data ? (
        <>
          {data.entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              <T>No secrets yet.</T>
            </p>
          ) : (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {data.entries.map((entry) => (
                <li key={entry.name} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="font-mono text-sm">{entry.name}</div>
                    <p className="truncate text-xs text-muted-foreground">
                      {entry.description ? `${entry.description} · ` : ""}
                      <T>
                        Updated <Var>{formatRelativeTimeLabel(entry.updatedAt)}</Var>
                      </T>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <T>Agents may read</T>
                      <Switch
                        size="sm"
                        checked={entry.agentReadable}
                        disabled={!canWrite || busy}
                        onCheckedChange={(agentReadable) =>
                          void run(
                            { _tag: "setAgentReadable", name: entry.name, agentReadable },
                            gt("Could not change {name}", { name: entry.name }),
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
                            aria-label={gt("{name} options", { name: entry.name })}
                          />
                        }
                      >
                        <MoreVertical />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem onClick={() => setEditing(entry)}>
                          <T>Edit</T>
                        </MenuItem>
                        <MenuItem variant="destructive" onClick={() => void remove(entry)}>
                          <T>Delete</T>
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
              <p className="text-xs text-muted-foreground">
                <T>Recent agent reads</T>
              </p>
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
            const saved = await run(input, gt("Could not save {name}", { name: input.name }));
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
              gt("Could not import secrets on {label}", { label: environment.label }),
            );
            if (imported) {
              setImporting(false);
              toastManager.add({
                type: "success",
                title: gt(
                  "Moved {count, plural, one {{count} secret} other {{count} secrets}} into the vault",
                  { count: items.length },
                ),
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
  const gt = useGT();
  const m = useMessages();
  const isNew = props.entry === null;
  const [name, setName] = useState(props.entry?.name ?? "");
  const [description, setDescription] = useState(props.entry?.description ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const nameError = isNew ? vaultSecretNameError(name, props.existingNames, m) : null;
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
          <DialogTitle>
            {isNew ? gt("Add secret") : gt("Edit {name}", { name: props.entry?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>
            <T>
              Use it in settings as{" "}
              <code>
                vault:<Var>{name.trim() || "NAME"}</Var>
              </code>
              .
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="block space-y-1.5 text-sm">
            <span>
              <T>Name</T>
            </span>
            <Input
              autoFocus={isNew}
              required
              value={name}
              disabled={!isNew || busy}
              spellCheck={false}
              // oxlint-disable-next-line t3code/no-untranslated-copy -- example environment variable name
              placeholder="OPENAI_API_KEY"
              onChange={(event) => setName(event.target.value)}
            />
            {name !== "" && nameError ? (
              <span className="block text-xs text-destructive">{nameError}</span>
            ) : null}
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>
              <T>Description</T>
            </span>
            <Input
              value={description}
              maxLength={500}
              disabled={busy}
              placeholder={gt("What it unlocks")}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>
              <T>Value</T>
            </span>
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
            <T>Cancel</T>
          </Button>
          <Button type="submit" disabled={busy || !valid}>
            {busy ? <Spinner size="xs" /> : null} <T>Save secret</T>
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
  const gt = useGT();
  const m = useMessages();
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads importable provider secrets from the server once when the import dialog opens
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    void load();
  }, []);

  const selected = (drafts ?? []).filter((draft) => draft.selected);
  const names = selected.map((draft) => draft.name.trim());
  const errors = new Map(
    selected.map((draft, index) => [
      draft.id,
      vaultSecretNameError(
        draft.name,
        [...props.existingNames, ...names.filter((_, at) => at !== index)],
        m,
      ),
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
          <DialogTitle>
            <T>Import existing secrets</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Moves secrets saved in this machine's settings into the vault and points those
              settings at <code>vault:NAME</code>.
            </T>
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
            <p className="text-sm text-muted-foreground">
              <T>No saved secrets to import.</T>
            </p>
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
                        aria-label={gt("Vault name for {label}", { label: draft.label })}
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
            <T>Cancel</T>
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
            {busy ? <Spinner size="xs" /> : null}{" "}
            <T>
              Import <Var>{selected.length}</Var>
            </T>
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
  const gt = useGT();
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
      title: gt("{label} joined the vault", { label: props.joiner.label }),
      description: gt("Turn on Vault secrets under Sync to copy the secrets to it."),
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
          <DialogTitle>
            {gt("Join {label} to the vault?", { label: props.joiner.label })}
          </DialogTitle>
          <DialogDescription>
            {gt(
              "{member} hands its vault key to {joiner}, encrypted so only that machine can open it. Anyone who controls {joiner} can then read every secret.",
              { member: member?.label ?? gt("A vault machine"), joiner: props.joiner.label },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {props.members.length > 1 ? (
            <div className="flex flex-wrap gap-1.5 text-sm">
              <span className="text-muted-foreground">
                <T>Key from</T>
              </span>
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
            <p>
              <T>
                <Var>{props.joiner.label}</Var>'s vault key fingerprint
              </T>
            </p>
            <p className="font-mono text-base">{props.recipient.fingerprint}</p>
            <p className="text-xs text-muted-foreground">
              <T>
                Open Par3 on <Var>{props.joiner.label}</Var> itself and check that Settings, Vault &
                sync shows the same fingerprint under "This machine's vault key fingerprint".
              </T>
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={confirmed}
              disabled={busy}
              onCheckedChange={(next) => setConfirmed(next)}
            />
            <T>The fingerprints match</T>
          </label>
          {!canWrap && member ? (
            <p className="text-xs text-muted-foreground">
              <T>
                This connection can't hand out the vault key on <Var>{member.label}</Var>.
              </T>
            </p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={props.onClose}>
            <T>Cancel</T>
          </Button>
          <Button disabled={busy || !confirmed || !canWrap || !member} onClick={() => void join()}>
            {busy ? <Spinner size="xs" /> : <KeyRoundIcon className="size-3.5" />} <T>Join vault</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
