import { useAtomValue } from "@effect/atom-react";
import { buildResolveLocalConflictsPrompt } from "@t3tools/client-runtime/state/merge-conflict-prompt";
import {
  hasRunningTurnInRepository,
  selectMergeConflictState,
} from "@t3tools/client-runtime/state/merge-conflict-state";
import type {
  EnvironmentId,
  MergeConflictListEntry,
  MergeConflictResolution,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { SparklesIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { mergeConflictEnvironment } from "~/state/mergeConflicts";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  abortConfirmation,
  conflictKindLabel,
  conflictRowActions,
  continueLabel,
  continueOutcomeToast,
  fileLevelReasonLabel,
  mutationBlockedReason,
  operationSignature,
  operationTitle,
  rebaseStepLabel,
  sideDescriptions,
  visibleResolved,
  EMPTY_RESOLVED_IN_OPERATION,
  type ConflictSide,
} from "./mergeConflicts.logic";
import { repositoryKey, useMergeConflictSessionStore } from "./mergeConflictSessionStore";
import { MergeFileSession } from "./MergeFileSession";
import {
  useThreadConflictRepositories,
  type ConflictRepository,
} from "./useThreadConflictRepositories";
import { useEnvironmentScope } from "~/state/session";
import { AuthSourceControlWriteScope } from "@t3tools/contracts";

/** Rows rendered per repository; the rest are reachable through "Resolve simple" or Ask agent. */
const MAX_RENDERED_ROWS = 300;

export interface MergeConflictsPanelProps {
  readonly threadRef: ScopedThreadRef;
  /**
   * Sends a prompt into the thread. Absent when the thread has not started, which hides Ask agent.
   */
  readonly onAskAgent: ((prompt: string) => Promise<void>) | undefined;
  readonly keybindings: ResolvedKeybindingsConfig;
  /** The three-pane view needs the width, so the right panel is maximized while it is open. */
  readonly onMaximizedChange: (maximized: boolean) => void;
}

export function MergeConflictsPanel(props: MergeConflictsPanelProps) {
  const { environmentId, repositories } = useThreadConflictRepositories(props.threadRef);
  // The one file open in the three-pane view, if any. Opening it is the single seam
  // `openFileMerge(cwd, path)` between the file list and the view.
  const [merging, setMerging] = useState<{ cwd: string; path: string } | null>(null);
  const openFileMerge = (cwd: string, path: string) => setMerging({ cwd, path });
  const isMerging = merging !== null;
  const reportMaximized = useEffectEvent(props.onMaximizedChange);
  useEffect(() => {
    reportMaximized(isMerging);
    return () => reportMaximized(false);
  }, [isMerging]);
  if (merging !== null && environmentId !== null) {
    return (
      <MergeFileSession
        key={`${merging.cwd}\0${merging.path}`}
        environmentId={environmentId}
        cwd={merging.cwd}
        path={merging.path}
        keybindings={props.keybindings}
        onOpen={(path) => setMerging(path === null ? null : { cwd: merging.cwd, path })}
      />
    );
  }
  if (environmentId === null || repositories.length === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>No repository</EmptyTitle>
          <EmptyDescription>
            This thread has no repository to resolve conflicts in.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-y-auto"
      data-testid="merge-conflicts-panel"
    >
      {repositories.map((repository) => (
        <RepositorySection
          key={repository.cwd}
          environmentId={environmentId}
          repository={repository}
          showHeading={repositories.length > 1}
          onAskAgent={props.onAskAgent}
          openFileMerge={openFileMerge}
        />
      ))}
    </div>
  );
}

function RepositorySection(props: {
  readonly environmentId: EnvironmentId;
  readonly repository: ConflictRepository;
  readonly showHeading: boolean;
  readonly onAskAgent: ((prompt: string) => Promise<void>) | undefined;
  readonly openFileMerge: (cwd: string, path: string) => void;
}) {
  const { environmentId, repository } = props;
  const { cwd } = repository;
  const target = { environmentId, input: { cwd } } as const;

  const statusQuery = useEnvironmentQuery(vcsEnvironment.status(target));
  const conflictState = selectMergeConflictState(statusQuery.data);
  const listQuery = useEnvironmentQuery(mergeConflictEnvironment.list(target));
  const list = listQuery.data;

  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const resolveCommand = useAtomCommand(mergeConflictEnvironment.resolve);
  const autoResolveCommand = useAtomCommand(mergeConflictEnvironment.autoResolve);
  const reopenCommand = useAtomCommand(mergeConflictEnvironment.reopen);
  const runOperationCommand = useAtomCommand(mergeConflictEnvironment.runOperation);

  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const permitted = useAtomValue(mergeConflictEnvironment.resolve.permissionAtom(environmentId));
  const threads = useThreadShells();
  const projects = useProjects();
  const turnRunning = hasRunningTurnInRepository({ environmentId, cwd, threads, projects });
  const blockedReason = mutationBlockedReason({
    canWriteSourceControl: canWriteSourceControl && permitted,
    turnRunningInRepository: turnRunning,
  });

  const sessionKey = repositoryKey(environmentId, cwd);
  const resolvedState = useMergeConflictSessionStore(
    (state) => state.resolvedByRepository[sessionKey] ?? EMPTY_RESOLVED_IN_OPERATION,
  );
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [bulkPending, setBulkPending] = useState<"auto" | "continue" | "abort" | null>(null);
  const [abortOpen, setAbortOpen] = useState(false);

  // A merge can be started or finished in a terminal, so the panel re-reads on open and on focus.
  const refreshAll = useEffectEvent(() => {
    void refreshVcsStatus(target);
    listQuery.refresh();
  });
  useEffect(() => {
    refreshAll();
    window.addEventListener("focus", refreshAll);
    return () => window.removeEventListener("focus", refreshAll);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-read when the repository changes; the event reads the latest target.
  }, [environmentId, cwd]);
  // Status is pushed after every mutation, including ones made elsewhere, so the list follows it.
  const refreshList = useEffectEvent(() => listQuery.refresh());
  useEffect(() => {
    refreshList();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-read when status reports a different operation or count.
  }, [conflictState.operation, conflictState.conflictCount]);

  const operation = list?.operation;
  const kind = operation?.kind ?? conflictState.operation;
  const signature = operationSignature(operation);
  const entries = list?.conflicts ?? [];
  const labels = list?.labels ?? { ours: "ours", theirs: "theirs" };
  const sides = sideDescriptions(kind);
  const resolvedPaths = visibleResolved(
    resolvedState,
    signature,
    entries.map((entry) => entry.path),
  );
  const markResolved = (path: string) =>
    useMergeConflictSessionStore.getState().markResolved(sessionKey, signature, path);

  if (!conflictState.needsResolution) {
    return props.showHeading ? null : (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>Nothing to resolve</EmptyTitle>
          <EmptyDescription>
            No merge, rebase, cherry-pick or revert is in progress here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const resolveEntry = async (
    entry: MergeConflictListEntry,
    resolution: MergeConflictResolution,
  ) => {
    setPendingPath(entry.path);
    const result = await resolveCommand({
      environmentId,
      input: { cwd, path: entry.path, expected: entry.expected, resolution },
    });
    setPendingPath(null);
    if (result._tag === "Success") markResolved(entry.path);
    // A stale or failed attempt leaves the file as it was; the list shows what is true now.
    listQuery.refresh();
  };

  const reopen = async (path: string) => {
    setPendingPath(path);
    const result = await reopenCommand({ environmentId, input: { cwd, path } });
    setPendingPath(null);
    if (result._tag === "Success")
      useMergeConflictSessionStore.getState().markReopened(sessionKey, path);
    listQuery.refresh();
  };

  const resolveSimple = async () => {
    setBulkPending("auto");
    const result = await autoResolveCommand({ environmentId, input: { cwd } });
    setBulkPending(null);
    listQuery.refresh();
    if (result._tag !== "Success") return;
    for (const path of result.value.resolved) markResolved(path);
    const { resolved, skipped } = result.value;
    toastManager.add({
      type: resolved.length > 0 ? "success" : "info",
      title:
        resolved.length > 0
          ? `Resolved ${resolved.length} ${resolved.length === 1 ? "file" : "files"}`
          : "Nothing could be resolved automatically",
      ...(skipped.length > 0
        ? {
            description: `${skipped.length} ${skipped.length === 1 ? "file needs" : "files need"} a decision from you.`,
          }
        : {}),
    });
  };

  const runOperation = async (action: "continue" | "abort") => {
    setBulkPending(action);
    const result = await runOperationCommand({ environmentId, input: { cwd, action } });
    setBulkPending(null);
    listQuery.refresh();
    if (result._tag === "Success") {
      toastManager.add(continueOutcomeToast(kind, result.value.outcome));
    }
  };

  const askAgent = async () => {
    if (props.onAskAgent === undefined) return;
    const prompt = buildResolveLocalConflictsPrompt({
      operation: kind,
      labels,
      paths: entries.map((entry) => entry.path),
      totalCount: list?.conflictCount ?? conflictState.conflictCount,
    });
    try {
      await props.onAskAgent(prompt);
      toastManager.add({ type: "success", title: "Asked the agent to resolve the conflicts" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not ask the agent",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const disabled = blockedReason !== null || bulkPending !== null;
  const confirmation = abortConfirmation(kind);
  const stepLabel = rebaseStepLabel(operation?.step);

  return (
    <section className="flex flex-col gap-3 border-b border-border/60 p-3 last:border-b-0">
      {props.showHeading && repository.label ? (
        <h3 className="truncate text-xs font-medium text-muted-foreground">
          <TruncatedText value={repository.label} />
        </h3>
      ) : null}

      <div className="flex flex-col gap-1.5" role="status">
        <div className="flex min-w-0 items-center gap-2">
          <PullRequestGlyph.merged aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">{operationTitle(kind)}</span>
          {stepLabel ? (
            <Badge variant="outline" size="sm">
              {stepLabel}
            </Badge>
          ) : null}
          <Badge variant={conflictState.conflictCount > 0 ? "warning" : "success"} size="sm">
            {conflictState.conflictCount > 0
              ? `${conflictState.conflictCount} ${conflictState.conflictCount === 1 ? "conflict" : "conflicts"}`
              : "All resolved"}
          </Badge>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs text-muted-foreground">
          <dt>Ours</dt>
          <dd className="min-w-0 truncate">
            <TruncatedText value={labels.ours} className="text-foreground" /> · {sides.ours}
          </dd>
          <dt>Theirs</dt>
          <dd className="min-w-0 truncate">
            <TruncatedText value={labels.theirs} className="text-foreground" /> · {sides.theirs}
          </dd>
        </dl>
      </div>

      {blockedReason ? <p className="text-xs text-warning-foreground">{blockedReason}</p> : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || conflictState.conflictCount === 0}
          onClick={() => void resolveSimple()}
        >
          {bulkPending === "auto" ? <Spinner size="sm" /> : null}
          Resolve simple conflicts in all files
        </Button>
        {props.onAskAgent ? (
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || conflictState.conflictCount === 0}
            onClick={() => void askAgent()}
          >
            <SparklesIcon aria-hidden />
            Ask agent
          </Button>
        ) : null}
        <span className="flex-1" />
        {kind !== null ? (
          <>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={disabled}
              onClick={() => setAbortOpen(true)}
            >
              Abort
            </Button>
            <Button
              size="xs"
              disabled={disabled || conflictState.conflictCount > 0}
              onClick={() => void runOperation("continue")}
            >
              {bulkPending === "continue" ? <Spinner size="sm" /> : null}
              {continueLabel(kind)}
            </Button>
          </>
        ) : null}
      </div>

      {listQuery.error && list === null ? (
        <p className="text-xs text-destructive-foreground">{listQuery.error}</p>
      ) : null}

      <ul className="flex flex-col divide-y divide-border/60 rounded-md border border-border/60">
        {entries.slice(0, MAX_RENDERED_ROWS).map((entry) => (
          <ConflictRow
            key={entry.path}
            entry={entry}
            busy={pendingPath === entry.path}
            disabled={disabled || pendingPath !== null}
            onSide={(side: ConflictSide) => void resolveEntry(entry, { _tag: "side", side })}
            onUseRecorded={() => void resolveEntry(entry, { _tag: "workingCopy" })}
            onMerge={() => props.openFileMerge(cwd, entry.path)}
          />
        ))}
      </ul>
      {entries.length > MAX_RENDERED_ROWS ? (
        <p className="text-xs text-muted-foreground">
          Showing {MAX_RENDERED_ROWS} of {entries.length} files. Resolve simple conflicts or ask the
          agent to handle the rest.
        </p>
      ) : null}

      {resolvedPaths.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">
            Resolved in this {kind ?? "operation"} ({resolvedPaths.length})
          </h4>
          <ul className="flex flex-col divide-y divide-border/60 rounded-md border border-border/60">
            {resolvedPaths.map((path) => (
              <li key={path} className="flex min-w-0 items-center gap-2 px-2 py-1.5">
                <span className="min-w-0 flex-1 text-xs">
                  <MiddleTruncate value={path} />
                </span>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={disabled || pendingPath !== null}
                  onClick={() => void reopen(path)}
                >
                  {pendingPath === path ? <Spinner size="sm" /> : null}
                  Reopen
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <AlertDialog open={abortOpen} onOpenChange={setAbortOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={() => void runOperation("abort")}
            >
              {confirmation.confirmLabel}
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

function ConflictRow(props: {
  readonly entry: MergeConflictListEntry;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onSide: (side: ConflictSide) => void;
  readonly onUseRecorded: () => void;
  readonly onMerge: () => void;
}) {
  const { entry } = props;
  const actions = conflictRowActions(entry);
  return (
    <li className="flex flex-col gap-1.5 px-2 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 text-sm">
          <MiddleTruncate value={entry.path} />
        </span>
        <Badge variant="outline" size="sm">
          {conflictKindLabel(entry.kind)}
        </Badge>
        {entry.fileLevelReason ? (
          <Badge variant="secondary" size="sm">
            {fileLevelReasonLabel(entry.fileLevelReason)}
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled}
          onClick={() => props.onSide("ours")}
        >
          {props.busy ? <Spinner size="sm" /> : null}
          {actions.ours.label}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled}
          onClick={() => props.onSide("theirs")}
        >
          {actions.theirs.label}
        </Button>
        {actions.canMerge ? (
          <Button size="xs" variant="outline" disabled={props.disabled} onClick={props.onMerge}>
            Merge…
          </Button>
        ) : null}
        {actions.canUseRecordedResolution ? (
          <Button
            size="xs"
            variant="outline"
            disabled={props.disabled}
            onClick={props.onUseRecorded}
          >
            Use git's recorded resolution
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** Labels come from the repository and can be long; the full text is one hover away. */
function TruncatedText(props: { readonly value: string; readonly className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={props.className} />}>{props.value}</TooltipTrigger>
      <TooltipPopup side="top">{props.value}</TooltipPopup>
    </Tooltip>
  );
}
