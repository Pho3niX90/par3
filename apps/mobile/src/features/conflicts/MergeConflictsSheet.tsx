import { buildResolveLocalConflictsPrompt } from "@t3tools/client-runtime/state/merge-conflict-prompt";
import {
  hasRunningTurnInRepository,
  mergeOperationNoun,
  selectMergeConflictState,
} from "@t3tools/client-runtime/state/merge-conflict-state";
import {
  AuthSourceControlWriteScope,
  CommandId,
  EnvironmentId,
  MessageId,
  type MergeConflictListEntry,
  type MergeConflictResolution,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { T, useGT, useMessages, Var } from "gt-react-native";
import { useEffect, useEffectEvent, useState } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
import { mergeConflictEnvironment } from "../../state/mergeConflicts";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import { vcsEnvironment } from "../../state/vcs";
import {
  abortCopy,
  conflictChoices,
  conflictKindLabel,
  operationOutcomeMessage,
} from "./mergeConflictChoices";

const MAX_ROWS = 200;

type MergeConflictsSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function MergeConflictsSheet(props: MergeConflictsSheetProps) {
  const navigation = useNavigation();
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();

  const statusQuery = useEnvironmentQuery(
    selectedThreadCwd !== null
      ? vcsEnvironment.status({ environmentId, input: { cwd: selectedThreadCwd } })
      : null,
  );
  // A folder that holds several repositories has no status of its own.
  const childrenQuery = useEnvironmentQuery(
    selectedThread !== null && statusQuery.data?.isRepo === false
      ? vcsEnvironment.threadRepositories({
          environmentId,
          input: { threadId: selectedThread.id },
        })
      : null,
  );
  const repositories =
    statusQuery.data?.isRepo === false
      ? (childrenQuery.data?.repositories ?? []).map((repository) => ({
          cwd: repository.cwd,
          label: repository.relativePath as string | null,
        }))
      : selectedThreadCwd === null
        ? []
        : [{ cwd: selectedThreadCwd, label: null as string | null }];

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: 28, sheetAllowedDetents: "fitToContents" }}
        />
      ) : null}
      {Platform.OS === "android" ? (
        <AppBar
          sheet
          title={gt("Merge conflicts")}
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : (
        <View className="min-h-4 pt-2" />
      )}
      <ScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          className="android:shrink android:grow-0 ios:flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerClassName="gap-4 p-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 8 }}
        >
          {repositories.length === 0 ? (
            <EmptyState
              variant="plain"
              title={gt("No repository")}
              detail={gt("This thread has no repository to resolve conflicts in.")}
            />
          ) : (
            repositories.map((repository) => (
              <RepositoryConflicts
                key={repository.cwd}
                environmentId={environmentId}
                cwd={repository.cwd}
                label={repository.label}
                showLabel={repositories.length > 1}
                thread={selectedThread}
              />
            ))
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}

function RepositoryConflicts(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly label: string | null;
  readonly showLabel: boolean;
  readonly thread: EnvironmentThreadShell | null;
}) {
  const { environmentId, cwd } = props;
  const gt = useGT();
  const m = useMessages();
  const target = { environmentId, input: { cwd } } as const;
  const statusQuery = useEnvironmentQuery(vcsEnvironment.status(target));
  const state = selectMergeConflictState(statusQuery.data);
  const listQuery = useEnvironmentQuery(mergeConflictEnvironment.list(target));
  const list = listQuery.data;

  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const resolveCommand = useAtomCommand(mergeConflictEnvironment.resolve);
  const autoResolveCommand = useAtomCommand(mergeConflictEnvironment.autoResolve);
  const runOperationCommand = useAtomCommand(mergeConflictEnvironment.runOperation);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  const canWrite = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const threads = useThreadShells();
  const projects = useProjects();
  const turnRunning = hasRunningTurnInRepository({ environmentId, cwd, threads, projects });
  const blockedReason = !canWrite
    ? gt("This connection cannot change source control.")
    : turnRunning
      ? gt("An agent is working in this repository. Wait for it to finish, or stop it first.")
      : null;

  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A merge may have been started in a terminal, so the sheet re-reads when it opens and
  // whenever pushed status changes.
  const refreshAll = useEffectEvent(() => {
    void refreshVcsStatus(target);
    listQuery.refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads the repository's conflict status from the server when the sheet opens or the repository changes
  useEffect(() => {
    refreshAll();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-read when the repository changes.
  }, [environmentId, cwd]);
  const refreshList = useEffectEvent(() => listQuery.refresh());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads the conflict list when the server's pushed status reports another operation or count
  useEffect(() => {
    refreshList();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-read when status reports a different operation or count.
  }, [state.operation, state.conflictCount]);

  const operation = state.operation;
  const labels = list?.labels ?? { ours: "ours", theirs: "theirs" };
  const entries = list?.conflicts ?? [];
  const disabled = blockedReason !== null || pending !== null;

  if (!state.needsResolution) {
    return props.showLabel ? null : (
      <EmptyState
        variant="plain"
        title={gt("Nothing to resolve")}
        detail={gt("No merge, rebase, cherry-pick or revert is in progress here.")}
      />
    );
  }

  const resolve = async (entry: MergeConflictListEntry, resolution: MergeConflictResolution) => {
    setPending(entry.path);
    // Only list metadata travels: the stage ids and working-copy hash a stale check needs.
    await resolveCommand({
      environmentId,
      input: { cwd, path: entry.path, expected: entry.expected, resolution },
    });
    setPending(null);
    listQuery.refresh();
  };

  const chooseFor = (entry: MergeConflictListEntry) => {
    const choices = conflictChoices(entry, m).slice(0, 3);
    Dialog.alert(
      entry.path,
      conflictKindLabel(entry.kind, m),
      choices.map((choice) => ({
        text: choice.label,
        onPress: () => void resolve(entry, choice.resolution),
      })),
    );
  };

  const resolveSimple = async () => {
    setPending("*");
    const result = await autoResolveCommand({ environmentId, input: { cwd } });
    setPending(null);
    listQuery.refresh();
    if (result._tag !== "Success") return;
    const { resolved, skipped } = result.value;
    setNotice(
      resolved.length > 0
        ? gt(
            "{resolvedCount, plural, one {Resolved {resolvedCount} file.} other {Resolved {resolvedCount} files.}}{hasSkipped, select, yes { {skippedCount} still need a decision.} other {}}",
            {
              resolvedCount: resolved.length,
              hasSkipped: skipped.length > 0 ? "yes" : "no",
              skippedCount: skipped.length,
            },
          )
        : gt("Nothing could be resolved automatically."),
    );
  };

  const runOperation = async (action: "continue" | "abort") => {
    setPending(action);
    const result = await runOperationCommand({ environmentId, input: { cwd, action } });
    setPending(null);
    listQuery.refresh();
    if (result._tag === "Success") {
      setNotice(operationOutcomeMessage(operation, result.value.outcome, m));
    }
  };

  const confirmAbort = () => {
    const copy = abortCopy(operation, m);
    Dialog.confirm({
      title: copy.title,
      message: copy.message,
      confirmText: copy.confirmText,
      destructive: true,
      onConfirm: () => void runOperation("abort"),
    });
  };

  const askAgent = async () => {
    const thread = props.thread;
    if (thread === null) return;
    setPending("agent");
    const metadata = makeQueuedMessageMetadata();
    const result = await startTurn({
      environmentId,
      input: {
        commandId: CommandId.make(metadata.commandId),
        creationSource: "mobile",
        threadId: thread.id,
        message: {
          messageId: MessageId.make(metadata.messageId),
          role: "user",
          text: buildResolveLocalConflictsPrompt({
            operation,
            labels,
            paths: entries.map((entry) => entry.path),
            totalCount: list?.conflictCount ?? state.conflictCount,
          }),
          attachments: [],
        },
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: metadata.createdAt,
        dispatchMode: "queue",
      },
    });
    setPending(null);
    setNotice(
      result._tag === "Success"
        ? gt("Asked the agent to resolve the conflicts.")
        : gt("Could not ask the agent."),
    );
  };

  const noun = mergeOperationNoun(operation, m);
  const stepLabel = list?.operation?.step
    ? gt("Step {current} of {total}", {
        current: list.operation.step.current,
        total: list.operation.step.total,
      })
    : null;

  return (
    <View className="gap-3">
      {props.showLabel && props.label ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {props.label}
        </Text>
      ) : null}
      <View className="gap-1 px-2">
        <Text textRole="title" className="font-t3-bold text-foreground">
          {state.canContinue
            ? gt("Ready to continue the {noun}", { noun })
            : stepLabel
              ? gt(
                  "{count, plural, one {{count} conflict in the {noun} · {step}} other {{count} conflicts in the {noun} · {step}}}",
                  { count: state.conflictCount, noun, step: stepLabel },
                )
              : gt(
                  "{count, plural, one {{count} conflict in the {noun}} other {{count} conflicts in the {noun}}}",
                  { count: state.conflictCount, noun },
                )}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          <T>
            Ours: <Var>{labels.ours}</Var>
          </T>
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          <T>
            Theirs: <Var>{labels.theirs}</Var>
          </T>
        </Text>
      </View>

      {blockedReason ? <Notice message={blockedReason} icon="exclamationmark.triangle" /> : null}
      {notice ? <Notice message={notice} onDismiss={() => setNotice(null)} /> : null}

      <View className="gap-2">
        <Button
          label={gt("Resolve simple conflicts")}
          icon="bolt.circle"
          fullWidth
          disabled={disabled || state.conflictCount === 0}
          loading={pending === "*"}
          onPress={() => void resolveSimple()}
        />
        {props.thread ? (
          <Button
            label={gt("Ask agent")}
            icon="brain"
            fullWidth
            disabled={disabled || state.conflictCount === 0}
            loading={pending === "agent"}
            onPress={() => void askAgent()}
          />
        ) : null}
        {operation !== null ? (
          <>
            <Button
              label={gt("Continue {noun}", { noun })}
              tone="primary"
              fullWidth
              disabled={disabled || state.conflictCount > 0}
              loading={pending === "continue"}
              onPress={() => void runOperation("continue")}
            />
            <Button
              label={gt("Abort {noun}", { noun })}
              tone="danger"
              fullWidth
              disabled={disabled}
              loading={pending === "abort"}
              onPress={confirmAbort}
            />
          </>
        ) : null}
      </View>

      {entries.length > 0 ? (
        <ListSection
          title={gt("Conflicted files")}
          footer={
            entries.length > MAX_ROWS
              ? gt(
                  "Showing {shown} of {total}. Resolve simple conflicts or ask the agent for the rest.",
                  { shown: MAX_ROWS, total: entries.length },
                )
              : gt("Tap a file to accept a side. Files are never downloaded to this device.")
          }
        >
          {entries.slice(0, MAX_ROWS).map((entry) => (
            <ListActionRow
              key={entry.path}
              label={entry.path}
              description={[conflictKindLabel(entry.kind, m), entry.fileLevelReason]
                .filter(Boolean)
                .join(" · ")}
              disabled={disabled}
              loading={pending === entry.path}
              onPress={() => chooseFor(entry)}
            />
          ))}
        </ListSection>
      ) : null}
    </View>
  );
}
