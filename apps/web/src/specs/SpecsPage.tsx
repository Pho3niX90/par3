import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, type SpecDocument, type SpecSummary } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../env";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useProject } from "../state/entities";
import { SpecDetailView } from "./SpecDetailView";
import { SpecEditorDialog, type SpecEditorTarget } from "./SpecEditorDialog";
import { formatSpecTimestamp, SpecApprovalBadge, SpecStatusBadge } from "./SpecParts";
import { specModeCreateDisabledReason, specPageLimit } from "./specs.logic";
import { useProjectSpecModeState, useSpecsData } from "./state";

function SpecRow({ spec, onOpen }: { readonly spec: SpecSummary; readonly onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col gap-1 rounded-lg border border-border px-3 py-2.5 text-left hover:bg-accent/50"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{spec.title}</span>
          <SpecStatusBadge status={spec.status} />
          <SpecApprovalBadge status={spec.status} approvalValid={spec.approvalValid} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          <code>{spec.slug}</code>
          <span>Revision {spec.revision}</span>
          <span>Updated {formatSpecTimestamp(spec.updatedAt)}</span>
        </div>
        {spec.error ? <p className="text-xs text-destructive-foreground">{spec.error}</p> : null}
      </button>
    </li>
  );
}

function SpecsList({
  environmentId,
  projectId,
  checkoutPath,
  createDisabledReason,
  onOpen,
  onCreate,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly checkoutPath: string | null;
  readonly createDisabledReason: string | null;
  readonly onOpen: (slug: string) => void;
  readonly onCreate: () => void;
}) {
  const [pages, setPages] = useState(1);
  const view = useSpecsData(environmentId, { projectId, limit: specPageLimit(pages) });
  const path = view.specs[0]?.workspacePath ?? checkoutPath;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">Specs are stored in this checkout</span>
          {path ? <code className="text-sm break-all">{path}</code> : null}
        </div>
        <Button disabled={createDisabledReason !== null} onClick={onCreate}>
          <PlusIcon /> New spec
        </Button>
      </div>
      {createDisabledReason ? (
        <p className="text-xs text-muted-foreground">{createDisabledReason}</p>
      ) : null}
      {view.error ? (
        <Alert variant="error">
          <AlertDescription>{view.error}</AlertDescription>
        </Alert>
      ) : null}
      {view.isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading specs
        </div>
      ) : view.specs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No specs in this project yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {view.specs.map((spec) => (
            <SpecRow key={spec.slug} spec={spec} onOpen={() => onOpen(spec.slug)} />
          ))}
        </ul>
      )}
      {view.data?.nextOffset !== undefined ? (
        <div>
          <Button variant="outline" onClick={() => setPages((count) => count + 1)}>
            Show more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SpecsBody({
  environmentId,
  projectId,
  slug,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly slug: string | undefined;
}) {
  const navigate = useNavigate();
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const { capabilitiesSupported, specModeEnabled, canMutate } = useProjectSpecModeState(
    environmentId,
    projectId,
  );
  const [editor, setEditor] = useState<SpecEditorTarget | null>(null);

  const openSpec = (next: string | undefined) =>
    void navigate({
      to: "/specs",
      search: { environment: environmentId, project: projectId, ...(next ? { slug: next } : {}) },
    });

  if (!capabilitiesSupported) {
    return (
      <p className="text-sm text-muted-foreground">
        This environment does not support Spec mode. Update its Par3 server to use specs.
      </p>
    );
  }
  if (project === null) {
    return <p className="text-sm text-muted-foreground">This project is not available.</p>;
  }

  return (
    <>
      {slug ? (
        <SpecDetailView
          environmentId={environmentId}
          projectId={projectId}
          slug={slug}
          onBack={() => openSpec(undefined)}
          onEdit={(spec: SpecDocument) => setEditor({ mode: "edit", spec })}
        />
      ) : (
        <SpecsList
          environmentId={environmentId}
          projectId={projectId}
          checkoutPath={project.workspaceRoot}
          createDisabledReason={specModeCreateDisabledReason({ specModeEnabled, canMutate })}
          onOpen={openSpec}
          onCreate={() => setEditor({ mode: "create" })}
        />
      )}
      {editor ? (
        <SpecEditorDialog
          environmentId={environmentId}
          projectId={projectId}
          target={editor}
          onClose={() => setEditor(null)}
          onSaved={(saved) => {
            setEditor(null);
            openSpec(saved.slug);
          }}
        />
      ) : null}
    </>
  );
}

export function SpecsPage() {
  const search = useSearch({ from: "/specs" });
  const environmentId = search.environment ? EnvironmentId.make(search.environment) : null;
  const projectId = search.project ? ProjectId.make(search.project) : null;
  const project = useProject(
    environmentId && projectId ? scopeProjectRef(environmentId, projectId) : null,
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="min-w-0 truncate text-sm font-medium">
            Specs{project ? ` · ${project.title}` : ""}
          </h1>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {environmentId && projectId ? (
              <SpecsBody environmentId={environmentId} projectId={projectId} slug={search.slug} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Open specs from a project's settings or the command palette.
              </p>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
