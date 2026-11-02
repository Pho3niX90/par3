import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describeThreadCost } from "@t3tools/shared/usageFormat";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

interface ThreadDetailsCostProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

function CostRow({ label, amount }: { readonly label: string; readonly amount: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{amount}</span>
    </div>
  );
}

function ThreadCostEstimate({ environmentId, threadId }: ThreadDetailsCostProps) {
  const atom = serverEnvironment.threadCost({ environmentId, input: { threadId } });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const cost = AsyncResult.getOrElse(result, () => null);

  if (cost === null) {
    return result._tag === "Failure" ? (
      <div className="flex items-center justify-between gap-3 px-3 py-1 text-xs">
        <span className="text-muted-foreground">Could not estimate this thread's cost.</span>
        <ThreadDetailsControl size="xs" variant="ghost" part="row" panel onClick={refresh}>
          Retry
        </ThreadDetailsControl>
      </div>
    ) : (
      <p className="px-3 py-1 text-xs text-muted-foreground">Estimating…</p>
    );
  }

  const description = describeThreadCost(cost);
  return (
    <div className="flex flex-col gap-1 px-3 py-1 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">Estimated cost</span>
        <span className="font-medium tabular-nums text-foreground">{description.amount}</span>
      </div>
      {description.breakdown.map((entry) => (
        <CostRow key={entry.label} label={entry.label} amount={entry.amount} />
      ))}
      {description.models.map((entry) => (
        <CostRow key={entry.key} label={entry.label} amount={entry.amount} />
      ))}
      {description.notes.map((note) => (
        <p key={note} className="text-muted-foreground">
          {note}
        </p>
      ))}
      <p className="text-muted-foreground">API-equivalent, not your subscription bill.</p>
    </div>
  );
}

/** Asks only on request: an estimate scans provider history, which opening a thread must not do. */
export function ThreadDetailsCost({ environmentId, threadId }: ThreadDetailsCostProps) {
  const [requestedThreadId, setRequestedThreadId] = useState<ThreadId | null>(null);
  return (
    <ThreadDetailsSection headingId="thread-details-cost-heading" title="Cost" showHeading={false}>
      {requestedThreadId === threadId ? (
        <ThreadCostEstimate environmentId={environmentId} threadId={threadId} />
      ) : (
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="row"
          panel
          onClick={() => setRequestedThreadId(threadId)}
        >
          Estimate cost
        </ThreadDetailsControl>
      )}
    </ThreadDetailsSection>
  );
}
