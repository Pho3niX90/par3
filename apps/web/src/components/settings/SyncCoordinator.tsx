import { useAtomValue } from "@effect/atom-react";
import type { SyncEnvironmentView } from "@t3tools/client-runtime/sync/plan";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { type MessageResolver } from "../../i18n/messages";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { isSyncParticipating, useSyncRunner, useSyncViews } from "../../state/sync";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Spinner } from "../ui/spinner";
import {
  defaultSyncCategories,
  peerSyncCategories,
  summarizeSyncJoin,
  type JoinCategorySummary,
} from "./syncSettings.logic";

const DISMISSED_STORAGE_KEY = "t3:sync-setup-dismissed:v1";

// Dismissing asks again next session, so the memory lives in sessionStorage.
function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(DISMISSED_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Runs sync in the background and asks about machines nobody has decided on yet. */
export function SyncCoordinator() {
  const gt = useGT();
  useSyncRunner();
  const views = useSyncViews();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [dismissed, setDismissed] = useState(readDismissed);
  // A lone machine has nothing to sync with, so nobody is asked until a second one is connected.
  const candidate =
    views.length < 2
      ? undefined
      : views.find(
          (view) => view.snapshot.participation === null && !dismissed.includes(view.environmentId),
        );
  if (!candidate) return null;
  const labelOf = (view: SyncEnvironmentView) =>
    presentations.get(view.environmentId)?.entry.target.label ?? gt("this machine");
  const peers = views.filter(
    (view) => view.environmentId !== candidate.environmentId && isSyncParticipating(view),
  );
  return (
    <SyncSetupDialog
      key={candidate.environmentId}
      candidate={candidate}
      label={labelOf(candidate)}
      peers={peers}
      peerLabels={peers.map(labelOf)}
      onDismiss={() => {
        const next = [...dismissed, candidate.environmentId];
        setDismissed(next);
        try {
          sessionStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(next));
        } catch {}
      }}
    />
  );
}

function describeJoin(
  summary: JoinCategorySummary | undefined,
  resolve: MessageResolver,
): string | null {
  if (!summary) return null;
  const parts = [
    summary.incoming > 0 ? resolve(msg("{count} to copy here", { count: summary.incoming })) : null,
    summary.outgoing > 0 ? resolve(msg("{count} to share", { count: summary.outgoing })) : null,
    summary.conflicts > 0 ? resolve(msg("{count} differ", { count: summary.conflicts })) : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? resolve(msg("Already the same")) : parts.join(" · ");
}

function SyncSetupDialog(props: {
  readonly candidate: SyncEnvironmentView;
  readonly label: string;
  readonly peers: ReadonlyArray<SyncEnvironmentView>;
  readonly peerLabels: ReadonlyArray<string>;
  readonly onDismiss: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { candidate, peers } = props;
  const joining = peers.length > 0;
  const setParticipation = useAtomCommand(serverEnvironment.syncSetParticipation);
  const [categories, setCategories] = useState<ReadonlyArray<string>>(() =>
    joining
      ? peerSyncCategories(peers, candidate.snapshot)
      : defaultSyncCategories(candidate.snapshot),
  );
  const [busy, setBusy] = useState(false);
  const summaries = joining ? summarizeSyncJoin(peers, candidate, categories) : [];

  const decide = async (enabled: boolean) => {
    setBusy(true);
    const result = await setParticipation({
      environmentId: candidate.environmentId,
      input: { enabled, categories: enabled ? [...categories] : [], excluded: [] },
    });
    setBusy(false);
    // The snapshot that follows records the decision and closes this dialog.
    if (result._tag !== "Success") props.onDismiss();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onDismiss();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {joining
              ? gt("Join {label} to sync?", { label: props.label })
              : gt("Set up sync on {label}?", { label: props.label })}
          </DialogTitle>
          <DialogDescription>
            {joining
              ? gt("Shares the chosen settings with {peers}.", {
                  peers: props.peerLabels.join(", "),
                })
              : gt("Shares the chosen settings with the other machines you sync.")}{" "}
            <T>Syncs while Par3 is connected to both machines.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-2">
            {candidate.snapshot.categories.map((category) => {
              const checked = categories.includes(category.id);
              const summary = checked
                ? describeJoin(
                    summaries.find((entry) => entry.categoryId === category.id),
                    m,
                  )
                : null;
              return (
                <label key={category.id} className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={checked}
                    disabled={!category.available || busy}
                    onCheckedChange={(next) =>
                      setCategories(
                        next
                          ? [...categories, category.id]
                          : categories.filter((id) => id !== category.id),
                      )
                    }
                  />
                  <span className="min-w-0">
                    <span className="block">{category.label}</span>
                    {!category.available && category.unavailableReason ? (
                      <span className="block text-xs text-muted-foreground">
                        {category.unavailableReason}
                      </span>
                    ) : summary ? (
                      <span className="block text-xs text-muted-foreground">{summary}</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => void decide(false)}>
            <T>Don't sync this machine</T>
          </Button>
          <Button disabled={busy || categories.length === 0} onClick={() => void decide(true)}>
            {busy ? <Spinner size="xs" /> : null} <T>Start syncing</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
