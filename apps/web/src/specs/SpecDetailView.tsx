import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectId,
  SpecDocument,
  SpecEvidence,
  SpecTask,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { useThreadShell } from "../state/entities";
import { formatSpecTimestamp, SpecApprovalBadge, SpecStatusBadge } from "./SpecParts";
import { resolveSpecActions, type SpecActionId } from "./specs.logic";
import {
  formatSpecRoleLabel,
  makeSpecRevision,
  useProjectSpecModeState,
  useRunSpecMutation,
  useSpecsData,
} from "./state";
import { useStartSpecThread } from "./useStartSpecThread";

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Hash({ label, value }: { readonly label: string; readonly value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <code className="min-w-0 break-all">{value}</code>
    </div>
  );
}

function TaskRow({ task }: { readonly task: SpecTask }) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <code className="text-xs text-muted-foreground">{task.id}</code>
        <span className="min-w-0 flex-1 font-medium">{task.title}</span>
        <Badge
          variant={
            task.status === "passed"
              ? "success"
              : task.status === "failed"
                ? "destructive"
                : task.status === "in-progress"
                  ? "info"
                  : "secondary"
          }
        >
          {task.status}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {task.acs.length > 0 ? <span>Covers {task.acs.join(", ")}</span> : null}
        {task.dependsOn.length > 0 ? <span>After {task.dependsOn.join(", ")}</span> : null}
      </div>
      {task.verify ? (
        <div className="text-xs text-muted-foreground">Verify: {task.verify}</div>
      ) : null}
    </li>
  );
}

function EvidenceRow({
  evidence,
  canConfirm,
  confirming,
  onConfirm,
}: {
  readonly evidence: SpecEvidence;
  readonly canConfirm: boolean;
  readonly confirming: boolean;
  readonly onConfirm: () => void;
}) {
  const needsConfirmation = evidence.kind === "manual" && evidence.confirmedBy === undefined;
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <code className="text-xs text-muted-foreground">{evidence.id}</code>
        <span className="min-w-0 flex-1">{evidence.description}</span>
        <Badge variant="outline">{evidence.kind}</Badge>
        <Badge variant={evidence.passed ? "success" : "destructive"}>
          {evidence.passed ? "Passed" : "Failed"}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {evidence.acs.length > 0 ? <span>Covers {evidence.acs.join(", ")}</span> : null}
        {evidence.checkpoint ? <span>Checkpoint {evidence.checkpoint}</span> : null}
        {evidence.confirmedBy ? <span>Confirmed by {evidence.confirmedBy}</span> : null}
        {needsConfirmation ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!canConfirm || confirming}
            onClick={onConfirm}
          >
            Confirm
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function BoundThreadRow({
  environmentId,
  threadId,
  roleLabel,
  canUnbind,
  busy,
  onUnbind,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly roleLabel: string;
  readonly canUnbind: boolean;
  readonly busy: boolean;
  readonly onUnbind: () => void;
}) {
  const navigate = useNavigate();
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  return (
    <li className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
      <Button
        variant="link"
        size="xs"
        onClick={() =>
          void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } })
        }
      >
        {shell?.title ?? `Thread ${threadId.slice(0, 8)}`}
      </Button>
      <Badge variant="outline">{roleLabel}</Badge>
      <div className="flex-1" />
      <Button size="xs" variant="outline" disabled={!canUnbind || busy} onClick={onUnbind}>
        Leave Spec mode
      </Button>
    </li>
  );
}

export function SpecDetailView({
  environmentId,
  projectId,
  slug,
  onBack,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly slug: string;
  readonly onBack: () => void;
  readonly onEdit: (spec: SpecDocument) => void;
}) {
  const view = useSpecsData(environmentId, { projectId, slug: slug as SpecDocument["slug"] });
  const { canMutate } = useProjectSpecModeState(environmentId, projectId);
  const runMutation = useRunSpecMutation();
  const startThread = useStartSpecThread(environmentId, projectId);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const spec = view.detail;

  if (spec === null) {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeftIcon /> All specs
          </Button>
        </div>
        {view.error ? (
          <Alert variant="error">
            <AlertDescription>{view.error}</AlertDescription>
          </Alert>
        ) : view.isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading spec
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This spec no longer exists.</p>
        )}
      </div>
    );
  }

  const actions = resolveSpecActions({
    status: spec.status,
    canMutate,
    findingCount: spec.findings.length,
    approvalValid: spec.approvalValid,
    hasError: spec.error !== undefined,
  });
  const blockedReason =
    actions.find((entry) => entry.disabledReason !== null)?.disabledReason ?? null;

  const mutate = async (payload: Parameters<typeof runMutation>[1]): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    const outcome = await runMutation(environmentId, payload);
    setBusy(false);
    if (!outcome.ok) setActionError(outcome.message);
    return outcome.ok;
  };
  const base = {
    projectId,
    slug: spec.slug,
    expectedRevision: makeSpecRevision(spec.revision),
  };

  const runAction = async (id: SpecActionId) => {
    switch (id) {
      case "edit":
        onEdit(spec);
        return;
      case "start-implementation":
      case "start-requirements": {
        setBusy(true);
        setActionError(null);
        const outcome = await startThread(
          spec,
          id === "start-requirements" ? "requirements" : "implementation",
        );
        setBusy(false);
        if (!outcome.ok) setActionError(outcome.message);
        return;
      }
      default:
        await mutate({ ...base, action: id });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon /> All specs
        </Button>
      </div>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{spec.title}</h1>
          <SpecStatusBadge status={spec.status} />
          <SpecApprovalBadge status={spec.status} approvalValid={spec.approvalValid} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <code>{spec.slug}</code>
          <span>Revision {spec.revision}</span>
          <span>Updated {formatSpecTimestamp(spec.updatedAt)}</span>
          {spec.supersedes ? <span>Supersedes {spec.supersedes}</span> : null}
        </div>
        <code className="text-xs break-all">{spec.workspacePath}</code>
      </header>

      {spec.error ? (
        <Alert variant="error">
          <TriangleAlertIcon />
          <AlertTitle>This spec has an error</AlertTitle>
          <AlertDescription>{spec.error}</AlertDescription>
        </Alert>
      ) : null}
      {actionError ? (
        <Alert variant="error">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {actions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {actions.map((entry) => (
              <Button
                key={entry.id}
                variant={
                  entry.tone === "primary"
                    ? "default"
                    : entry.tone === "destructive"
                      ? "destructive-outline"
                      : "outline"
                }
                disabled={busy || entry.disabledReason !== null}
                onClick={() => void runAction(entry.id)}
              >
                {entry.label}
              </Button>
            ))}
          </div>
          {blockedReason ? <p className="text-xs text-muted-foreground">{blockedReason}</p> : null}
        </div>
      ) : null}

      {spec.findings.length > 0 ? (
        <Section title="Readiness findings">
          <ul className="flex flex-col gap-1.5">
            {spec.findings.map((finding) => (
              <li
                key={`${finding.code}:${finding.criterion ?? ""}:${finding.message}`}
                className="flex flex-col gap-0.5 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="warning">{finding.code}</Badge>
                  {finding.criterion ? (
                    <code className="text-xs text-muted-foreground">{finding.criterion}</code>
                  ) : null}
                </div>
                <span>{finding.message}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Requirements">
        <ChatMarkdown text={spec.content} cwd={spec.workspacePath} environmentId={environmentId} />
      </Section>

      <Section title="Approval">
        {spec.approval ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm">
              Approved by {spec.approval.subject} ({spec.approval.label}) on{" "}
              {formatSpecTimestamp(spec.approval.approvedAt)} at revision {spec.approval.revision}.
            </p>
            {!spec.approvalValid ? (
              <p className="text-sm text-warning-foreground">
                The spec changed after this approval, so it no longer counts.
              </p>
            ) : null}
            <Hash label="Spec hash" value={spec.approval.specHash} />
            <Hash label="Constitution hash" value={spec.approval.constitutionHash} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Not approved.</p>
        )}
      </Section>

      <Section title={`Tasks (${spec.tasks.length})`}>
        {spec.tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {spec.tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Evidence (${spec.evidence.length})`}>
        {spec.evidence.length === 0 ? (
          <p className="text-sm text-muted-foreground">No evidence recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {spec.evidence.map((entry) => (
              <EvidenceRow
                key={entry.id}
                evidence={entry}
                canConfirm={canMutate}
                confirming={busy}
                onConfirm={() =>
                  void mutate({ ...base, action: "confirm-evidence", evidenceId: entry.id })
                }
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Threads (${spec.bindings.length})`}>
        {spec.bindings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No threads are bound to this spec.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {spec.bindings.map((binding) => (
              <BoundThreadRow
                key={binding.threadId}
                environmentId={environmentId}
                threadId={binding.threadId}
                roleLabel={formatSpecRoleLabel(binding.role)}
                canUnbind={canMutate}
                busy={busy}
                onUnbind={() =>
                  void mutate({ ...base, action: "unbind", threadId: binding.threadId })
                }
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
