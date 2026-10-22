import type { StaticScreenProps } from "@react-navigation/native";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { proposedPlanTitle } from "@t3tools/shared/proposedPlanText";
import { View } from "react-native";

import { LoadingScreen } from "../../components/LoadingScreen";
import { EmptyState } from "../../components/ui/EmptyState";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProject, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { FileMarkdownPreview } from "../files/FileMarkdownPreview";

type ThreadPlanScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly itemId: string;
  readonly revision?: string;
}>;

export function ThreadPlanScreen({ route }: ThreadPlanScreenProps) {
  const params = route.params;
  const environmentId = EnvironmentId.make(params.environmentId);
  const threadId = ThreadId.make(params.threadId);
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const project = useProject(
    thread?.projectId ? scopeProjectRef(environmentId, thread.projectId) : null,
  );
  const baseDirectory = thread?.worktreePath ?? project?.workspaceRoot ?? undefined;
  const detail = useEnvironmentQuery(
    orchestrationEnvironment.turnItem({
      environmentId,
      input: {
        threadId,
        itemId: TurnItemId.make(params.itemId),
        ...(params.revision === undefined ? {} : { revision: params.revision }),
      },
    }),
  );
  const item = detail.data?.item;
  if (!item && detail.isPending) return <LoadingScreen message="Loading plan…" embedded />;
  if (detail.error || item?.type !== "proposed_plan")
    return (
      <View className="flex-1 justify-center bg-screen px-5">
        <EmptyState
          title="Plan unavailable"
          detail={detail.error ?? "This plan could not be found."}
          actionLabel="Retry"
          onAction={detail.refresh}
        />
      </View>
    );
  return (
    <>
      <NativeStackScreenOptions options={{ title: proposedPlanTitle(item.markdown) ?? "Plan" }} />
      <FileMarkdownPreview
        cwd={baseDirectory ?? ""}
        baseDirectory={baseDirectory ?? ""}
        relativePath=""
        environmentId={environmentId}
        threadId={threadId}
        markdown={item.markdown}
        onRefresh={detail.refresh}
      />
    </>
  );
}
