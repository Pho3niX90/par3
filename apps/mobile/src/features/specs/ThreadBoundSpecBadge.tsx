import React from "react";
import { Pressable, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useThreadBoundSpec } from "../../state/specs";
import { SpecStatusBadge } from "./SpecStatusBadge";

export interface ThreadBoundSpecBadgeProps {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
}

export function ThreadBoundSpecBadge(props: ThreadBoundSpecBadgeProps) {
  const navigation = useNavigation();
  const { boundSpec } = useThreadBoundSpec(props.environmentId, props.projectId, props.threadId);

  const { environmentId, projectId } = props;
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
