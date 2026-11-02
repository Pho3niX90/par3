import { EnvironmentId, ThreadId, type ThreadCost } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  thread: null as { environmentId: string; id: string } | null,
  requests: [] as Array<unknown>,
  result: null as unknown,
}));

vi.mock("react-native", () => ({
  View: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
  }: {
    readonly children?: ReactNode;
    readonly onPress?: () => void;
  }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: state.thread }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    threadCost: (input: unknown) => {
      state.requests.push(input);
      return Atom.make(() => state.result);
    },
  },
}));

const { ThreadCostSection } = await import("./ThreadCostSection");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread-a");

const estimate: ThreadCost = {
  threadId,
  readAt: "2026-08-02T00:00:00.000Z",
  totalCostUsd: 2,
  thread: {
    threadCount: 1,
    costUsd: 1,
    models: [
      {
        provider: "claude",
        model: "claude-fable-5",
        totals: {
          uncachedInputTokens: 1,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 1,
          reasoningTokens: 0,
        },
        costUsd: 1,
        costSource: "modelPriced",
        records: 1,
        unpricedRecords: 0,
      },
    ],
  },
  subagents: { threadCount: 1, costUsd: 1, models: [] },
  coverage: {
    complete: false,
    untrackedConversations: 1,
    conversationsWithoutUsage: 0,
    unreadableSources: 0,
    unpricedRecords: 0,
  },
  pricing: null,
};

function mount(input: { readonly thread: typeof state.thread; readonly result?: unknown }) {
  state.thread = input.thread;
  state.requests.length = 0;
  state.result = input.result ?? null;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ThreadCostSection />));
  return {
    container,
    press: (label: RegExp) => {
      const button = [...container.querySelectorAll("button")].find((candidate) =>
        label.test(candidate.textContent ?? ""),
      );
      if (!button) throw new Error(`No button matches ${label}`);
      act(() => button.click());
    },
    rerender: () => act(() => root.render(<ThreadCostSection />)),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

const thread = { environmentId, id: threadId };

it("renders nothing on the new-task sheet, where there is no thread", () => {
  using view = mount({ thread: null });
  expect(view.container.textContent).toBe("");
});

it("does not read cost until asked, then shows the figure and its caveats", () => {
  using view = mount({ thread, result: AsyncResult.success(estimate) });
  expect(state.requests).toEqual([]);
  view.press(/Estimate cost/);
  expect(state.requests[0]).toEqual({ environmentId, input: { threadId } });
  const text = view.container.textContent;
  expect(text).toContain("$2.00+");
  expect(text).toContain("1 sub-agent thread");
  expect(text).toContain("claude-fable-5");
  expect(text).toContain("1 conversation uses a provider with no usage history.");
  expect(text).toContain("not your subscription bill");
});

it("shows progress while the first read runs", () => {
  using view = mount({ thread, result: AsyncResult.initial(true) });
  view.press(/Estimate cost/);
  expect(view.container.textContent).toContain("Estimating…");
});

it("reports a failed read and retries on press", () => {
  using view = mount({
    thread,
    result: AsyncResult.failure(Cause.fail(new Error("scan failed"))),
  });
  view.press(/Estimate cost/);
  expect(view.container.textContent).toContain("Could not estimate this thread's cost.");
  state.result = AsyncResult.success(estimate);
  view.press(/Tap to retry/);
  expect(view.container.textContent).toContain("$2.00+");
});

it("asks again for a different thread", () => {
  using view = mount({ thread, result: AsyncResult.success(estimate) });
  view.press(/Estimate cost/);
  expect(view.container.textContent).toContain("$2.00+");
  state.thread = { environmentId, id: ThreadId.make("thread-b") };
  view.rerender();
  expect(view.container.textContent).toContain("Estimate cost");
  expect(view.container.textContent).not.toContain("$2.00+");
});

it("asks again when coming back to a thread, without reading it", () => {
  using view = mount({ thread, result: AsyncResult.success(estimate) });
  view.press(/Estimate cost/);
  expect(view.container.textContent).toContain("$2.00+");
  state.thread = { environmentId, id: ThreadId.make("thread-b") };
  view.rerender();
  state.requests.length = 0;
  state.thread = thread;
  view.rerender();
  expect(view.container.textContent).toContain("Estimate cost");
  expect(state.requests).toEqual([]);
});

it("asks again for the same thread id on another environment", () => {
  using view = mount({ thread, result: AsyncResult.success(estimate) });
  view.press(/Estimate cost/);
  expect(view.container.textContent).toContain("$2.00+");
  state.requests.length = 0;
  state.thread = { environmentId: EnvironmentId.make("other"), id: threadId };
  view.rerender();
  expect(view.container.textContent).toContain("Estimate cost");
  expect(state.requests).toEqual([]);
});
