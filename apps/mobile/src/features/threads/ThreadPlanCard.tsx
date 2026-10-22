import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

export function ThreadPlanCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
}) {
  const navigation = useNavigation();
  const { item } = props.projectedItem;
  if (item.type !== "proposed_plan") return null;
  const preview = stripDisplayedPlanMarkdown(item.markdown)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}\s+|[-*>]+\s+|\d+[.)]\s+|`{3,}.*|~{3,}.*)/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return (
    <View className="mb-3 gap-3 rounded-2xl border border-border bg-card p-4">
      <Text className="font-t3-bold text-base text-foreground" numberOfLines={2}>
        {proposedPlanTitle(item.markdown) ?? "Proposed plan"}
      </Text>
      {preview ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={3}>
          {preview}
        </Text>
      ) : null}
      <Button
        label="View plan"
        onPress={() =>
          navigation.navigate("ThreadPlan", {
            environmentId: props.environmentId,
            threadId: props.projectedItem.sourceThreadId,
            itemId: props.projectedItem.sourceItemId,
            revision: turnItemDetailRevision(item),
          })
        }
      />
    </View>
  );
}
