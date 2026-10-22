import type {
  EnvironmentId,
  ProjectId,
  SpecDocument,
  SpecIntake,
  SpecRole,
  SpecSlug,
  SpecSummary,
  ThreadId,
} from "@t3tools/contracts";
import { pendingIntakeBanner } from "@t3tools/shared/specComposer";
import { useNavigate } from "@tanstack/react-router";
import { FileTextIcon } from "lucide-react";
import { useState } from "react";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SpecEditorDialog } from "./SpecEditorDialog";
import { nextSpecStepHint, specRoleRefusal } from "./specs.logic";
import {
  ALL_SPEC_ROLES,
  formatSpecRoleLabel,
  formatSpecStatusLabel,
  makeSpecRevision,
  type SpecMutationOutcome,
  useProjectSpecModeState,
  useRunSpecIntake,
  useRunSpecMutation,
  useThreadSpecBinding,
} from "./state";

export interface ThreadSpecState {
  /** Spec mode is on for the project, whether or not the thread exists yet. */
  readonly usable: boolean;
  /** Spec mode is on and the thread exists on the server, so it can be bound. */
  readonly available: boolean;
  readonly canMutate: boolean;
  /** The person may start or cancel a spec from a message. */
  readonly canStartSpec: boolean;
  readonly specs: ReadonlyArray<SpecSummary>;
  readonly boundSpec: SpecDocument | null;
  readonly boundRole: SpecRole | null;
  /** The thread is waiting for its agent to draft a new spec. */
  readonly intake: SpecIntake | null;
}

/**
 * Turning Spec mode off only hides new spec work. A thread already bound to a spec stays
 * restricted by the server, so its binding is still read and shown.
 */
export function useThreadSpecState(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  threadId: ThreadId | null,
): ThreadSpecState {
  const { capabilitiesSupported, specModeEnabled, canMutate, canStartSpec } =
    useProjectSpecModeState(environmentId, projectId);
  const usable = capabilitiesSupported && specModeEnabled && projectId !== null;
  const available = usable && threadId !== null;
  const bindingReadable = capabilitiesSupported && projectId !== null && threadId !== null;
  const binding = useThreadSpecBinding(environmentId, projectId, threadId, bindingReadable);
  return {
    usable,
    available,
    canMutate,
    canStartSpec,
    specs: binding.specs,
    boundSpec: bindingReadable ? binding.boundSpec : null,
    boundRole: bindingReadable ? binding.boundRole : null,
    intake: bindingReadable ? binding.intake : null,
  };
}

function useLeaveSpecMode(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  threadId: ThreadId | null,
) {
  const runMutation = useRunSpecMutation();
  return async (spec: SpecDocument): Promise<SpecMutationOutcome> => {
    if (projectId === null || threadId === null) {
      return { ok: false, message: "This thread is not in a project." };
    }
    return runMutation(environmentId, {
      action: "unbind",
      projectId,
      threadId,
      slug: spec.slug,
      expectedRevision: makeSpecRevision(spec.revision),
    });
  };
}

export function useThreadSpecBannerItem(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  threadId: ThreadId | null,
  threadRunning: boolean,
): ComposerBannerStackItem | null {
  const state = useThreadSpecState(environmentId, projectId, threadId);
  const navigate = useNavigate();
  const leave = useLeaveSpecMode(environmentId, projectId, threadId);
  const runIntake = useRunSpecIntake();
  const [error, setError] = useState<string | null>(null);
  const { boundSpec, boundRole, intake } = state;
  if (projectId === null) return null;
  if (boundSpec === null && intake !== null && threadId !== null) {
    const banner = pendingIntakeBanner({
      intake,
      threadRunning,
      canMutate: state.canStartSpec,
    });
    return {
      id: "spec-intake",
      variant: error ? "warning" : "info",
      icon: <FileTextIcon />,
      title: banner.title,
      description: error ?? banner.cancelDisabledReason ?? banner.description,
      actions: (
        <Button
          size="xs"
          variant="ghost"
          disabled={banner.cancelDisabledReason !== null}
          onClick={() =>
            void runIntake(environmentId, { projectId, threadId, action: "cancel" }).then(
              (outcome) => setError(outcome.ok ? null : outcome.message),
            )
          }
        >
          Cancel
        </Button>
      ),
    };
  }
  if (boundSpec === null || boundRole === null) return null;
  return {
    id: `spec-mode:${boundSpec.slug}`,
    variant: error ? "warning" : "info",
    icon: <FileTextIcon />,
    title: `${boundSpec.title} · ${formatSpecRoleLabel(boundRole)} · ${formatSpecStatusLabel(boundSpec.status)}`,
    description: error ?? nextSpecStepHint(boundSpec.status),
    actions: (
      <>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void navigate({
              to: "/specs",
              search: { environment: environmentId, project: projectId, slug: boundSpec.slug },
            })
          }
        >
          Open spec
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!state.canMutate}
          onClick={() =>
            void leave(boundSpec).then((outcome) => setError(outcome.ok ? null : outcome.message))
          }
        >
          Leave Spec mode
        </Button>
      </>
    ),
  };
}

/** Binds a thread that already exists to a spec that already exists, or to a new one made by hand. */
export function ThreadSpecBindDialog({
  environmentId,
  projectId,
  threadId,
  driver,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly driver: string | null;
  readonly onClose: () => void;
}) {
  const state = useThreadSpecState(environmentId, projectId, threadId);
  const [creating, setCreating] = useState(false);
  const [role, setRole] = useState<SpecRole>("requirements");
  const [slug, setSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runMutation = useRunSpecMutation();

  const selectedSlug = slug ?? state.specs[0]?.slug ?? null;
  const refusal = specRoleRefusal(driver, role);

  const bind = async (target: { slug: SpecSlug; revision: number }) => {
    setBusy(true);
    setError(null);
    const outcome = await runMutation(environmentId, {
      action: "bind",
      projectId,
      threadId,
      slug: target.slug,
      expectedRevision: makeSpecRevision(target.revision),
      role,
    });
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    onClose();
  };

  if (creating) {
    return (
      <SpecEditorDialog
        environmentId={environmentId}
        projectId={projectId}
        target={{ mode: "create" }}
        onClose={() => setCreating(false)}
        onSaved={(created) => {
          setCreating(false);
          void bind(created);
        }}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Use an existing spec</DialogTitle>
          <DialogDescription>
            This thread follows the spec you pick. To start a new one from a message, choose Spec in
            the composer instead.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Role for this thread</Label>
              <Select value={role} onValueChange={(value) => value && setRole(value as SpecRole)}>
                <SelectTrigger aria-label="Spec role">
                  <SelectValue>{formatSpecRoleLabel(role)}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {ALL_SPEC_ROLES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {formatSpecRoleLabel(entry)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Spec</Label>
              {state.specs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No specs in this project yet.</p>
              ) : (
                <Select value={selectedSlug} onValueChange={(value) => setSlug(value)}>
                  <SelectTrigger aria-label="Spec">
                    <SelectValue>
                      {state.specs.find((entry) => entry.slug === selectedSlug)?.title ??
                        "Choose a spec"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {state.specs.map((entry) => (
                      <SelectItem key={entry.slug} value={entry.slug}>
                        {entry.title} ({formatSpecStatusLabel(entry.status)})
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              )}
            </div>
            {refusal ? <p className="text-xs text-warning-foreground">{refusal}</p> : null}
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!state.canMutate || refusal !== null}
            onClick={() => setCreating(true)}
          >
            New spec
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !state.canMutate || refusal !== null || selectedSlug === null}
            onClick={() => {
              const target = state.specs.find((entry) => entry.slug === selectedSlug);
              if (target) void bind(target);
            }}
          >
            Use spec
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
