import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { DraftId } from "~/composerDraftStore";
import { render } from "../../../test/render";
import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

const state = vi.hoisted(() => ({ items: {} as Record<string, boolean> }));

vi.mock(import("../../hooks/useSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  useClientSettings: ((select: (settings: unknown) => unknown) =>
    select({ threadDetailsItems: state.items, threadDetailsUsageEnabled: false })) as never,
}));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({ children }: { readonly children: (density: "full") => ReactNode }) => (
    <div>{children("full")}</div>
  ),
}));
vi.mock("./ThreadDetailsCost", () => ({
  ThreadDetailsCost: () => <p>cost row</p>,
}));
vi.mock("./ThreadServersPanel", () => ({ ThreadServersPanel: () => null }));
vi.mock("./ThreadAutomationsPanel", () => ({ ThreadAutomationsPanel: () => null }));
vi.mock("./ThreadRelationshipsControl", () => ({ ThreadRelationshipsPanel: () => null }));
vi.mock("../BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("../GitActionsControl", () => ({ default: () => null }));
vi.mock("../../hooks/useT3ProjectFileScripts", () => ({ useT3ProjectFileScripts: () => [] }));

const props = (overrides: Partial<ThreadDetailsPanelProps> = {}) =>
  ({
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    projectId: ProjectId.make("project"),
    worktreePath: null,
    isServerThread: true,
    activeProjectName: undefined,
    activeProjectScripts: undefined,
    preferredScriptId: null,
    keybindings: [],
    availableEditors: [],
    showOpenInPicker: false,
    openInShortcutEnabled: false,
    gitCwd: null,
    isGitRepo: false,
    childRepositories: [],
    envLocked: false,
    availableEnvironments: [],
    onEnvModeChange: () => undefined,
    envMode: "local",
    startFromOrigin: false,
    onStartFromOriginChange: () => undefined,
    onComposerFocusRequest: () => undefined,
    onRunProjectScript: () => undefined,
    usage: { providerInstanceId: null, providers: [], sources: [], contextWindow: null },
    ...overrides,
  }) as unknown as ThreadDetailsPanelProps;

it("offers the cost row on a thread that exists", async () => {
  state.items = {};
  await using _screen = await render(<ThreadDetailsPanel {...props()} />);
  await expect.element(page.getByText("cost row")).toBeVisible();
});

it("leaves the cost row off a draft, which has no history to price", async () => {
  state.items = {};
  await using _screen = await render(
    <ThreadDetailsPanel {...props({ draftId: DraftId.make("draft") })} />,
  );
  await expect.element(page.getByText("cost row")).not.toBeInTheDocument();
});

it("honours turning the cost row off", async () => {
  state.items = { cost: false };
  await using _screen = await render(<ThreadDetailsPanel {...props()} />);
  await expect.element(page.getByText("cost row")).not.toBeInTheDocument();
});
