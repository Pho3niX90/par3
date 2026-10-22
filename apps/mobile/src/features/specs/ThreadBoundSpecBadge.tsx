import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ProjectId, SpecIntake, ThreadId } from "@t3tools/contracts";
import { pendingIntakeBanner } from "@t3tools/shared/specComposer";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { useRunSpecIntake, useSpecIntakePermission } from "../../state/spec-intake";
import { useThreadBoundSpec } from "../../state/specs";
import { SpecStatusBadge } from "./SpecStatusBadge";

export interface ThreadBoundSpecBadgeProps {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly threadRunning: boolean;
}

/** A thread asked to start a spec and is waiting for its agent to draft it. */
function ThreadSpecIntakeRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly intake: SpecIntake;
  readonly threadRunning: boolean;
}) {
  const canStartSpec = useSpecIntakePermission(props.environmentId);
  const runIntake = useRunSpecIntake();
  const [error, setError] = useState<string | null>(null);
  const banner = pendingIntakeBanner({
    intake: props.intake,
    threadRunning: props.threadRunning,
    canMutate: canStartSpec,
  });
  return (
    <View className="flex-row items-center justify-between gap-2 border-b border-border-subtle bg-surface px-4 py-2">
      <SymbolView name="doc.text" size={15} tintColorClassName="text-accent" />
      <View className="flex-1 min-w-0">
        <Text className="text-xs font-t3-bold text-foreground" numberOfLines={1}>
          {banner.title}
        </Text>
        <Text className="text-[10px] text-foreground-muted" numberOfLines={2}>
          {error ?? banner.cancelDisabledReason ?? banner.description}
        </Text>
      </View>
      <Button
        label="Cancel"
        tone="text"
        accessibilityLabel="Cancel drafting a new spec"
        disabled={banner.cancelDisabledReason !== null}
        onPress={() =>
          void runIntake(props.environmentId, {
            projectId: props.projectId,
            threadId: props.threadId,
            action: "cancel",
          }).then((outcome) => setError(outcome.ok ? null : outcome.message))
        }
      />
    </View>
  );
}

export function ThreadBoundSpecBadge(props: ThreadBoundSpecBadgeProps) {
  const navigation = useNavigation();
  const { boundSpec, intake } = useThreadBoundSpec(
    props.environmentId,
    props.projectId,
    props.threadId,
  );

  const { environmentId, projectId } = props;
  if (!boundSpec && intake && environmentId && projectId && props.threadId) {
    return (
      <ThreadSpecIntakeRow
        environmentId={environmentId}
        projectId={projectId}
        threadId={props.threadId}
        intake={intake}
        threadRunning={props.threadRunning}
      />
    );
  }
  if (!boundSpec || !environmentId || !projectId) {
    return null;
  }

  const binding = boundSpec.bindings?.find((b) => b.threadId === props.threadId);
  const role = binding?.role ?? "implementation";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Bound spec: ${boundSpec.title}`}
      onPress={() =>
        navigation.navigate("SpecDetail", {
          environmentId,
          projectId,
          slug: boundSpec.slug,
        })
      }
      className="flex-row items-center justify-between border-b border-border-subtle bg-surface px-4 py-2 active:opacity-75"
    >
      <View className="flex-row items-center gap-2 flex-1 min-w-0 pr-2">
        <SymbolView name="doc.text" size={15} tintColorClassName="text-accent" />
        <View className="flex-1 min-w-0">
          <View className="flex-row items-center gap-1.5 flex-wrap">
            <Text className="text-xs font-t3-bold text-foreground" numberOfLines={1}>
              {boundSpec.title}
            </Text>
            <View className="rounded-full bg-subtle px-1.5 py-0.2">
              <Text className="text-[10px] font-t3-medium capitalize text-foreground-muted">
                {role}
              </Text>
            </View>
          </View>
          <Text className="text-[10px] font-mono text-foreground-muted" numberOfLines={1}>
            {boundSpec.slug} · Rev {boundSpec.revision}
          </Text>
        </View>
      </View>

      <SpecStatusBadge
        status={boundSpec.status}
        approvalValid={boundSpec.approvalValid}
        showApprovalStatus
      />
    </Pressable>
  );
}
