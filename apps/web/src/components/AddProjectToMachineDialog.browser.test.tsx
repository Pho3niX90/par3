import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";

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
const addProjectToMachine = vi.hoisted(() => vi.fn(async () => undefined));

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
                truncated: false,
              }),
        )) as never,
    },
  };
});

import {
  AddProjectToMachineDialogHost,
  openAddProjectToMachine,
} from "./AddProjectToMachineDialog";

const environmentId = EnvironmentId.make("environment-1");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
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

describe("AddProjectToMachineDialog", () => {
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
});
