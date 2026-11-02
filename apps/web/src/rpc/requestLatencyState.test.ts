import { WS_METHODS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  acknowledgeRpcRequest,
  subscribeSlowRpcAckRequests,
  trackRpcRequestSent,
} from "./requestLatencyState";

it("gives a thread cost scan the long-running allowance before warning", () => {
  vi.useFakeTimers();
  const seen: Array<ReadonlyArray<{ readonly requestId: string; readonly thresholdMs: number }>> =
    [];
  const unsubscribe = subscribeSlowRpcAckRequests((requests) => seen.push(requests));
  try {
    trackRpcRequestSent("cost", WS_METHODS.serverGetThreadCost);
    vi.advanceTimersByTime(15_000);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(105_000);
    expect(seen.at(-1)).toMatchObject([{ requestId: "cost", thresholdMs: 120_000 }]);
  } finally {
    acknowledgeRpcRequest("cost");
    unsubscribe();
    vi.useRealTimers();
  }
});
