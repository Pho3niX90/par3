import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { memo } from "react";
import { ComposerBanner } from "./ComposerBanner";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
  threadRef,
  planId,
  itemId,
}: {
  planTitle: string | null;
  threadRef: ScopedThreadRef;
  planId: string;
  itemId?: string | undefined;
}) {
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon />
      <ComposerBanner.Content>
        <span className="shrink-0 font-medium text-muted-foreground">Plan ready</span>
        {planTitle ? (
          <span className="min-w-0 flex-1 truncate text-foreground/85">{planTitle}</span>
        ) : null}
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => useRightPanelStore.getState().openPlan(threadRef, planId, itemId)}
        >
          Open
        </Button>
      </ComposerBanner.Actions>
    </ComposerBanner.Row>
  );
});
