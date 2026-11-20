import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describeThreadCost } from "@t3tools/shared/usageFormat";
import { AsyncResult } from "effect/reactivity";
import { T, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { serverEnvironment } from "../../state/server";
import { useThreadSelection } from "../../state/use-thread-selection";

function CostRow(props: { readonly label: string; readonly amount: string }) {
  return (
    <View className="flex-row justify-between gap-3">
      <Text className="flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {props.label}
      </Text>
      <Text className="text-xs text-foreground-muted">{props.amount}</Text>
    </View>
  );
}

function ThreadCostEstimate(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const atom = serverEnvironment.threadCost({
    environmentId: props.environmentId,
    input: { threadId: props.threadId },
  });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const m = useMessages();
  const cost = AsyncResult.getOrElse(result, () => null);
  if (cost === null) {
    return result._tag === "Failure" ? (
      <Pressable accessibilityRole="button" className="px-4 py-3" onPress={refresh}>
        <Text className="text-sm text-foreground-muted">
          <T>Could not estimate this thread's cost. Tap to retry.</T>
        </Text>
      </Pressable>
    ) : (
      <Text className="px-4 py-3 text-sm text-foreground-muted">
        <T>Estimating…</T>
      </Text>
    );
  }
  const description = describeThreadCost(cost, m);
  return (
    <View className="gap-1 px-4 py-3">
      <View className="flex-row justify-between gap-3">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Estimated cost</T>
        </Text>
        <Text className="text-sm text-foreground">{description.amount}</Text>
      </View>
      {description.breakdown.map((entry) => (
        <CostRow key={entry.label} label={entry.label} amount={entry.amount} />
      ))}
      {description.models.map((entry) => (
        <CostRow key={entry.key} label={entry.label} amount={entry.amount} />
      ))}
      {description.notes.map((note) => (
        <Text key={note} className="text-xs text-foreground-muted">
          {note}
        </Text>
      ))}
      <Text className="text-xs text-foreground-muted">
        <T>API-equivalent, not your subscription bill.</T>
      </Text>
    </View>
  );
}

function ThreadCostRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [requested, setRequested] = useState(false);
  return requested ? (
    <ThreadCostEstimate environmentId={props.environmentId} threadId={props.threadId} />
  ) : (
    <Pressable
      accessibilityRole="button"
      className="min-h-11 flex-row items-center bg-grouped-card px-4 py-2 active:bg-subtle"
      onPress={() => setRequested(true)}
    >
      <Text className="text-sm font-t3-medium text-foreground">
        <T>Estimate cost</T>
      </Text>
    </Pressable>
  );
}

/** Renders nothing on the new-task sheet, which has no thread to price yet. */
export function ThreadCostSection() {
  const { selectedThread } = useThreadSelection();
  if (!selectedThread) return null;
  return (
    <>
      <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">
        <T>Cost</T>
      </Text>
      <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
        <ThreadCostRequest
          key={`${selectedThread.environmentId}:${selectedThread.id}`}
          environmentId={selectedThread.environmentId}
          threadId={selectedThread.id}
        />
      </View>
    </>
  );
}
