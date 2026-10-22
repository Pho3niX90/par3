import { useEnvironmentScope } from "../../state/session";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import { memo, useState } from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { findRevealRef } from "./markdownFindContext";
import { buildCollapsedProposedPlanPreviewMarkdown } from "../../proposedPlan";
import { useRightPanelStore } from "../../rightPanelStore";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { cn } from "~/lib/utils";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  planId,
  itemId,
  environmentId,
  threadRef,
  cwd,
  onImplement,
  busy = false,
  findActive = false,
}: {
  onImplement?: (() => void) | undefined;
  planMarkdown: string;
  planId: string;
  itemId?: string | undefined;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | undefined;
  cwd: string | undefined;
  busy?: boolean;
  findActive?: boolean;
}) {
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const [expanded, setExpanded] = useState(false);
  const revealRef = findRevealRef(() => setExpanded(true));
  const isCollapsed = !expanded;
  return (
    <div className="rounded-xl border border-border/80 bg-card/70 p-4">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">Plan</Badge>
        <h3 data-thread-find-text="true" className="truncate text-sm font-medium">
          {proposedPlanTitle(planMarkdown) ?? "Proposed plan"}
        </h3>
      </div>
      <div
        ref={revealRef}
        data-thread-find-text="true"
        data-thread-find-fold={isCollapsed ? "" : undefined}
        className={cn("mt-3", isCollapsed && "max-h-36 overflow-hidden")}
      >
        <ChatMarkdown
          text={
            isCollapsed && !findActive
              ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 4 })
              : stripDisplayedPlanMarkdown(planMarkdown)
          }
          cwd={cwd}
          environmentId={environmentId}
          threadRef={threadRef}
          isStreaming={false}
          headingLevelOffset={3}
        />
      </div>
      <div className="mt-3 flex gap-2">
        {canOperate && onImplement ? (
          <Button size="sm" disabled={busy} onClick={onImplement}>
            Implement
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={!threadRef}
          onClick={() => {
            if (threadRef) useRightPanelStore.getState().openPlan(threadRef, planId, itemId);
          }}
        >
          Open plan
        </Button>
      </div>
    </div>
  );
});
