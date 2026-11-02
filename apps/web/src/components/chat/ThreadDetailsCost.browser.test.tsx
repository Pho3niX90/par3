import { EnvironmentId, ThreadId, type ThreadCost } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ThreadDetailsCost } from "./ThreadDetailsCost";

const state = vi.hoisted(() => ({
  requests: [] as Array<unknown>,
  result: null as unknown,
}));

vi.mock(
  import("../../state/server"),
  () =>
    ({
      serverEnvironment: {
        threadCost: (input: unknown) => {
          state.requests.push(input);
          return Atom.make(() => state.result);
        },
      },
    }) as never,
);

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread-a");

const estimate = (overrides: Partial<ThreadCost> = {}): ThreadCost => ({
  threadId,
  readAt: "2026-08-02T00:00:00.000Z",
  totalCostUsd: 1.5,
  thread: {
    threadCount: 1,
    costUsd: 1,
    models: [
      {
        provider: "claude",
        model: "claude-fable-5",
        totals: {
          uncachedInputTokens: 10,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
        costUsd: 1.25,
        costSource: "modelPriced",
        records: 1,
        unpricedRecords: 0,
      },
    ],
  },
  subagents: { threadCount: 1, costUsd: 0.5, models: [] },
  coverage: {
    complete: true,
    untrackedConversations: 0,
    conversationsWithoutUsage: 0,
    unreadableSources: 0,
    unpricedRecords: 0,
  },
  pricing: null,
  ...overrides,
});

function setup(result: unknown) {
  state.requests.length = 0;
  state.result = result;
}

const askForEstimate = () => userEvent.click(page.getByRole("button", { name: "Estimate cost" }));

it("does not read cost until asked, then shows the figure, split, and models", async () => {
  setup(AsyncResult.success(estimate()));
  await using _screen = await render(
    <ThreadDetailsCost environmentId={environmentId} threadId={threadId} />,
  );
  expect(state.requests).toEqual([]);

  await askForEstimate();

  expect(state.requests[0]).toEqual({ environmentId, input: { threadId } });
  await expect.element(page.getByText("$1.50")).toBeVisible();
  await expect.element(page.getByText("This thread")).toBeVisible();
  await expect.element(page.getByText("1 sub-agent thread")).toBeVisible();
  await expect.element(page.getByText("claude-fable-5")).toBeVisible();
  await expect.element(page.getByText("API-equivalent, not your subscription bill.")).toBeVisible();
});

it("says why an incomplete figure may be low", async () => {
  setup(
    AsyncResult.success(
      estimate({
        coverage: {
          complete: false,
          untrackedConversations: 1,
          conversationsWithoutUsage: 0,
          unreadableSources: 0,
          unpricedRecords: 0,
        },
      }),
    ),
  );
  await using _screen = await render(
    <ThreadDetailsCost environmentId={environmentId} threadId={threadId} />,
  );
  await askForEstimate();
  await expect.element(page.getByText("$1.50+")).toBeVisible();
  await expect
    .element(page.getByText("1 conversation uses a provider with no usage history."))
    .toBeVisible();
});

it("shows progress while the first read runs", async () => {
  setup(AsyncResult.initial(true));
  await using _screen = await render(
    <ThreadDetailsCost environmentId={environmentId} threadId={threadId} />,
  );
  await askForEstimate();
  await expect.element(page.getByText("Estimating…")).toBeVisible();
});

it("reports a failed read and can retry it", async () => {
  setup(AsyncResult.failure(Cause.fail(new Error("scan failed"))));
  await using _screen = await render(
    <ThreadDetailsCost environmentId={environmentId} threadId={threadId} />,
  );
  await askForEstimate();
  await expect.element(page.getByText("Could not estimate this thread's cost.")).toBeVisible();

  state.result = AsyncResult.success(estimate());
  await userEvent.click(page.getByRole("button", { name: "Retry" }));

  await expect.element(page.getByText("$1.50")).toBeVisible();
});

it("asks again for a different thread instead of showing the last one's figure", async () => {
  setup(AsyncResult.success(estimate()));
  await using screen = await render(
    <ThreadDetailsCost environmentId={environmentId} threadId={threadId} />,
  );
  await askForEstimate();
  await expect.element(page.getByText("$1.50")).toBeVisible();

  await screen.rerender(
    <ThreadDetailsCost environmentId={environmentId} threadId={ThreadId.make("thread-b")} />,
  );

  await expect.element(page.getByRole("button", { name: "Estimate cost" })).toBeVisible();
  await expect.element(page.getByText("$1.50")).not.toBeInTheDocument();
});

it("asks again when coming back to a thread, without reading it", async () => {
  setup(AsyncResult.success(estimate()));
  await using screen = await render(
    <ThreadDetailsCost environmentId={environmentId} threadId={threadId} />,
  );
  await askForEstimate();
  await expect.element(page.getByText("$1.50")).toBeVisible();
  await screen.rerender(
    <ThreadDetailsCost environmentId={environmentId} threadId={ThreadId.make("thread-b")} />,
  );
  await expect.element(page.getByRole("button", { name: "Estimate cost" })).toBeVisible();
  state.requests.length = 0;

  await screen.rerender(<ThreadDetailsCost environmentId={environmentId} threadId={threadId} />);

  await expect.element(page.getByRole("button", { name: "Estimate cost" })).toBeVisible();
  expect(state.requests).toEqual([]);
});

it("asks again for the same thread id on another environment", async () => {
  setup(AsyncResult.success(estimate()));
  await using screen = await render(
    <ThreadDetailsCost environmentId={environmentId} threadId={threadId} />,
  );
  await askForEstimate();
  await expect.element(page.getByText("$1.50")).toBeVisible();
  state.requests.length = 0;

  await screen.rerender(
    <ThreadDetailsCost environmentId={EnvironmentId.make("other")} threadId={threadId} />,
  );

  await expect.element(page.getByRole("button", { name: "Estimate cost" })).toBeVisible();
  expect(state.requests).toEqual([]);
});
