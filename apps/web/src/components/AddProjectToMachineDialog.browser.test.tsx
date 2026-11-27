import { EnvironmentId, ProjectId, type ProjectCloneSnapshot } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";

const snapshots = vi.hoisted(() => vi.fn<() => ReadonlyArray<ProjectCloneSnapshot>>());
const SEARCHABLE_ROOT = vi.hoisted(() => "/searchable");

vi.mock(import("../state/projectClones"), async (original) => ({
  ...(await original()),
  // Clones land on the target machine only.
  useEnvironmentProjectClones: (environmentId) =>
    environmentId === "environment-2" ? snapshots() : [],
}));

const project = vi.hoisted(() => {
  let value: unknown = null;
  const listeners = new Set<() => void>();
  return {
    // Each test starts from no project and no listeners left by an earlier test.
    setup: (initial: unknown) => {
      value = initial;
      listeners.clear();
    },
    get: () => value,
    set: (next: unknown) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

const machines = vi.hoisted(() => {
  let environments: unknown[] = [];
  let targets: unknown[] = [];
  return {
    setup: (next: { environments: unknown[]; targets: unknown[] }) => {
      environments = next.environments;
      targets = next.targets;
    },
    environments: () => environments,
    targets: () => targets,
  };
});
const addProjectToMachine = vi.hoisted(() =>
  vi.fn<(input: { projectId: ProjectId }) => Promise<unknown>>(async () => undefined),
);

vi.mock(import("../state/entities"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    readProject: (() => project.get()) as never,
    subscribeProject: ((_ref: unknown, listener: (value: unknown) => void) =>
      project.subscribe(() => listener(project.get()))) as never,
    useProject: (() => useSyncExternalStore(project.subscribe, project.get)) as never,
  };
});
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: machines.environments() })) as never,
}));
vi.mock(import("../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => () => undefined) as never,
}));
vi.mock(import("../hooks/useAddProjectTargets"), async (original) => ({
  ...(await original()),
  useAddProjectTargets: (() => machines.targets()) as never,
}));
vi.mock(import("../hooks/useLogicalProjectEnvironments"), async (original) => ({
  ...(await original()),
  useLogicalProjectEnvironments: (() => []) as never,
}));
vi.mock(import("../lib/addProjectToMachine"), async (original) => ({
  ...(await original()),
  addProjectToMachine: addProjectToMachine as never,
}));
vi.mock(import("../state/projects"), async (original) => {
  const module = await original();
  return {
    ...module,
    projectEnvironment: {
      ...module.projectEnvironment,
      listIgnoredFiles: (({ input }: { input: { cwd: string } }) =>
        Atom.make(
          input.cwd.endsWith("/web")
            ? AsyncResult.fail(new Error("not cloned here"))
            : AsyncResult.success({
                files: [
                  { path: ".env", byteLength: 5 },
                  { path: "notes.txt", byteLength: 5 },
                ],
                // A truncated listing offers the ignored file search.
                truncated: input.cwd === SEARCHABLE_ROOT,
              }),
        )) as never,
    },
  };
});

import {
  AddProjectToMachineDialogHost,
  openAddProjectToMachine,
} from "./AddProjectToMachineDialog";
import { ProjectCloneToastCoordinator } from "./ProjectCloneToastCoordinator";
import { ToastProvider } from "./ui/toast";

const environmentId = EnvironmentId.make("environment-1");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
const nextProjectRef = scopeProjectRef(environmentId, ProjectId.make("project-2"));
// Only environment-3 can list ignored files.
const searchableProjectRef = scopeProjectRef(
  EnvironmentId.make("environment-3"),
  ProjectId.make("project-3"),
);
const PROJECT = {
  environmentId,
  id: projectRef.projectId,
  title: "Repo",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
};

const targetEnvironmentId = EnvironmentId.make("environment-2");
const WORKSPACE_PROJECT = {
  ...PROJECT,
  title: "Acme",
  workspaceRoot: "/work/acme",
  repositoryIdentity: {
    canonicalKey: "workspace:acme",
    locator: { source: "git-remote", remoteName: "workspace", remoteUrl: "workspace:acme" },
    members: [
      {
        path: "api",
        canonicalKey: "github.com/acme/api",
        remoteUrl: "git@github.com:acme/api.git",
      },
      {
        path: "web",
        canonicalKey: "github.com/acme/web",
        remoteUrl: "git@github.com:acme/web.git",
      },
    ],
  },
};
const REMOTE_MACHINE = {
  environments: [{ environmentId: targetEnvironmentId }],
  targets: [{ environmentId: targetEnvironmentId, label: "Remote machine", machine: "linux" }],
};
const MACHINES = {
  environments: [
    {
      environmentId,
      label: "Laptop",
      serverConfig: {
        environment: { capabilities: { ignoredFileListing: true }, platform: {} },
        settings: {},
      },
    },
    {
      environmentId: targetEnvironmentId,
      label: "Server",
      serverConfig: {
        environment: { capabilities: {}, platform: {} },
        settings: { addProjectBaseDirectory: "/srv" },
      },
    },
  ],
  targets: [{ environmentId: targetEnvironmentId, label: "Server", machine: "server" }],
};

function CloneDialogWithToasts() {
  return (
    <ToastProvider>
      <ProjectCloneToastCoordinator />
      <AddProjectToMachineDialogHost />
    </ToastProvider>
  );
}

describe("AddProjectToMachineDialog", () => {
  it("keeps the replacement open after the dismissed clone finishes starting", async () => {
    project.setup(PROJECT);
    machines.setup(REMOTE_MACHINE);
    const reply = Promise.withResolvers<ProjectId>();
    const requested = Promise.withResolvers<ProjectId>();
    addProjectToMachine.mockImplementationOnce(({ projectId }: { projectId: ProjectId }) => {
      requested.resolve(projectId);
      return reply.promise;
    });
    snapshots.mockReturnValue([]);
    await using screen = await render(<CloneDialogWithToasts />);

    await act(() => openAddProjectToMachine({ projectRef, targetEnvironmentId: null }));
    const folder = screen.getByRole("textbox", { name: /^Folder on/ });
    await folder.fill("/checkout");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    const projectId = await requested.promise;
    snapshots.mockReturnValue([
      {
        projectId,
        remoteUrl: "https://example.com/repo.git",
        destinationPath: "/checkout",
        repository: null,
        phase: "running",
        stage: "connecting",
        percent: null,
        detail: null,
        error: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
        sequence: 1,
      },
    ]);
    await screen.rerender(<CloneDialogWithToasts />);
    await userEvent.keyboard("{Escape}");

    await act(() => {
      project.set({ ...PROJECT, id: nextProjectRef.projectId, title: "Next repo" });
      openAddProjectToMachine({ projectRef: nextProjectRef, targetEnvironmentId: null });
    });
    await expect.element(screen.getByText(/Clone Next repo/)).toBeVisible();
    const progress = page.getByText("Cloning checkout", { exact: true });
    await expect.element(progress).not.toBeInTheDocument();
    reply.resolve(projectId);
    await expect.element(progress).toBeVisible();
    await expect.element(screen.getByText(/Clone Next repo/)).toBeVisible();
  });

  it("clones every workspace member over the chosen protocol and copies files per member", async () => {
    project.setup(WORKSPACE_PROJECT);
    machines.setup(MACHINES);
    addProjectToMachine.mockClear();
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() => openAddProjectToMachine({ projectRef, targetEnvironmentId: null }));
    await expect.element(screen.getByText(/Clone the 2 repositories in Acme/)).toBeInTheDocument();
    await expect.element(screen.getByText("web: not cloned here")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "HTTPS" }));
    await userEvent.type(screen.getByLabelText("Folder on Server"), "{Enter}");

    await vi.waitFor(() => expect(addProjectToMachine).toHaveBeenCalledOnce());
    expect(addProjectToMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        clone: {
          repositories: [
            { path: "api", remoteUrl: "https://github.com/acme/api.git" },
            { path: "web", remoteUrl: "https://github.com/acme/web.git" },
          ],
        },
        destinationPath: "/srv/acme",
        files: [
          expect.objectContaining({
            sourceCwd: "/work/acme/api",
            relativePath: ".env",
            targetRelativePath: "api/.env",
          }),
        ],
      }),
    );
  });

  it("closes when its project goes away", async () => {
    project.setup(PROJECT);
    machines.setup({ environments: [], targets: [] });
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() => openAddProjectToMachine({ projectRef, targetEnvironmentId: null }));
    await expect.element(screen.getByText("Add to another machine")).toBeInTheDocument();

    await act(() => project.set(null));
    await act(() => project.set(PROJECT));
    await expect.element(screen.getByText("Add to another machine")).not.toBeInTheDocument();
  });

  it("does not reopen for a project that vanished before the dialog showed", async () => {
    project.setup(PROJECT);
    machines.setup({ environments: [], targets: [] });
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() => {
      openAddProjectToMachine({ projectRef, targetEnvironmentId: null });
      project.set(null);
    });
    await act(() => project.set(PROJECT));

    await expect.element(screen.getByText("Add to another machine")).not.toBeInTheDocument();
  });

  it("clears the ignored file search on Escape before closing", async () => {
    project.setup({
      ...PROJECT,
      environmentId: searchableProjectRef.environmentId,
      id: searchableProjectRef.projectId,
      workspaceRoot: SEARCHABLE_ROOT,
    });
    machines.setup({
      environments: [
        ...REMOTE_MACHINE.environments,
        {
          environmentId: searchableProjectRef.environmentId,
          serverConfig: {
            environment: {
              platform: { machine: "linux" },
              capabilities: { ignoredFileListing: true, ignoredFileSearch: true },
            },
          },
        },
      ],
      targets: REMOTE_MACHINE.targets,
    });
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() =>
      openAddProjectToMachine({ projectRef: searchableProjectRef, targetEnvironmentId: null }),
    );
    const file = screen.getByRole("checkbox", { name: /\.env/ });
    await file.click();
    await expect.element(file).not.toBeChecked();
    const dialog = screen.getByRole("dialog", { name: "Add to another machine" });
    const search = screen.getByRole("searchbox", { name: "Search ignored files" });
    await search.fill("env");
    for (const composition of [
      { key: "Escape", isComposing: true, keyCode: 27 },
      { key: "Escape", isComposing: false, keyCode: 229 },
    ]) {
      // Safari ends the composition just before the Escape keydown.
      await act(() => {
        search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        search
          .element()
          .dispatchEvent(
            new KeyboardEvent("keydown", { ...composition, bubbles: true, cancelable: true }),
          );
      });
      await expect.element(search).toHaveValue("env");
      await expect.element(dialog).toHaveAttribute("data-open");
    }

    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect.element(search).toHaveFocus();
    await expect.element(search).toHaveAttribute("type", "text");
    await expect.element(file).not.toBeChecked();
    // Holding Escape repeats the keydown, which must not also close the dialog.
    await act(() => {
      search.element().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect.element(dialog).toHaveAttribute("data-open");

    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
  });
});
