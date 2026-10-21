import type {
  EnvironmentId,
  ProjectId,
  SpecDocument,
  SpecRole,
  SpecSlug,
  SpecSummary,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FileTextIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useComposerMenuProps } from "../components/chat/composerEventScope";
import {
  ComposerControl,
  ComposerControlIcon,
  type ComposerControlSize,
} from "../components/chat/ComposerControl";
import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { useComposerMenuState } from "../components/chat/useComposerMenuState";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { registerSpecModeToggleHandler, requestSpecModeToggle } from "./specModeActionBus";
import { SpecEditorDialog } from "./SpecEditorDialog";
import { SpecStatusBadge } from "./SpecParts";
import { nextSpecStepHint, specRoleRefusal } from "./specs.logic";
import {
  ALL_SPEC_ROLES,
  formatSpecRoleLabel,
  formatSpecStatusLabel,
  makeSpecRevision,
  type SpecMutationOutcome,
  useProjectSpecModeState,
  useRunSpecMutation,
  useThreadSpecBinding,
} from "./state";

export interface ThreadSpecState {
  /** Spec mode is on for the project, whether or not the thread exists yet. */
  readonly usable: boolean;
  /** Spec mode is on and the thread exists on the server, so it can be bound. */
  readonly available: boolean;
  readonly canMutate: boolean;
  readonly specs: ReadonlyArray<SpecSummary>;
  readonly boundSpec: SpecDocument | null;
  readonly boundRole: SpecRole | null;
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
  const { capabilitiesSupported, specModeEnabled, canMutate } = useProjectSpecModeState(
    environmentId,
    projectId,
  );
  const usable = capabilitiesSupported && specModeEnabled && projectId !== null;
  const available = usable && threadId !== null;
  const bindingReadable = capabilitiesSupported && projectId !== null && threadId !== null;
  const binding = useThreadSpecBinding(environmentId, projectId, threadId, bindingReadable);
  return {
    usable,
    available,
    canMutate,
    specs: binding.specs,
    boundSpec: bindingReadable ? binding.boundSpec : null,
    boundRole: bindingReadable ? binding.boundRole : null,
  };
}

/** Opens the Spec popover when its button is on screen, otherwise the project's Specs page. */
export function useOpenSpecMode(environmentId: EnvironmentId, projectId: ProjectId | null) {
  const navigate = useNavigate();
  return () => {
    if (requestSpecModeToggle() || projectId === null) return;
    void navigate({ to: "/specs", search: { environment: environmentId, project: projectId } });
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
): ComposerBannerStackItem | null {
  const state = useThreadSpecState(environmentId, projectId, threadId);
  const navigate = useNavigate();
  const leave = useLeaveSpecMode(environmentId, projectId, threadId);
  const [error, setError] = useState<string | null>(null);
  const { boundSpec, boundRole } = state;
  if (boundSpec === null || boundRole === null || projectId === null) return null;
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

export function ThreadSpecModeControl({
  environmentId,
  projectId,
  threadId,
  driver,
  size = "sm",
  hidden = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly driver: string | null;
  readonly size?: ComposerControlSize;
  readonly hidden?: boolean;
}) {
  const state = useThreadSpecState(environmentId, projectId, threadId);
  const floatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(hidden);
  const [creating, setCreating] = useState(false);
  const [role, setRole] = useState<SpecRole>("requirements");
  const [slug, setSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const runMutation = useRunSpecMutation();

  const registered = state.available && !hidden;
  useEffect(() => {
    if (!registered) return;
    return registerSpecModeToggleHandler(() => setOpen((current) => !current));
  }, [registered, setOpen]);

  if ((!state.usable && state.boundSpec === null) || projectId === null) return null;
  if (threadId === null) {
    const label = "Open this project's specs";
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size={size}
              className="shrink-0 whitespace-nowrap"
              aria-label={label}
              onClick={() =>
                void navigate({
                  to: "/specs",
                  search: { environment: environmentId, project: projectId },
                })
              }
            />
          }
        >
          <ComposerControlIcon icon={FileTextIcon} size={size} />
          <span data-composer-control-label className="sr-only sm:not-sr-only">
            Spec
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    );
  }

  const bound = state.boundSpec;
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
    setOpen(false);
  };

  const leave = async () => {
    if (bound === null) return;
    setBusy(true);
    setError(null);
    const outcome = await runMutation(environmentId, {
      action: "unbind",
      projectId,
      threadId,
      slug: bound.slug,
      expectedRevision: makeSpecRevision(bound.revision),
    });
    setBusy(false);
    if (!outcome.ok) setError(outcome.message);
    else setOpen(false);
  };

  const label = bound
    ? "Spec mode is on. Manage this thread's spec."
    : "Bind this thread to a spec";

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <ComposerControl
                    size={size}
                    className="shrink-0 whitespace-nowrap"
                    aria-pressed={bound !== null}
                    aria-label={label}
                  />
                }
              />
            }
          >
            <ComposerControlIcon icon={FileTextIcon} size={size} />
            <span data-composer-control-label className="sr-only sm:not-sr-only">
              Spec
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
        <PopoverPopup side="top" align="start" width="md" {...floatingLayerProps}>
          <div className="flex flex-col gap-3">
            {bound ? (
              <>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {bound.title}
                    </span>
                    <SpecStatusBadge status={bound.status} />
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {state.boundRole ? formatSpecRoleLabel(state.boundRole) : ""} ·{" "}
                    {nextSpecStepHint(bound.status)}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setOpen(false);
                      void navigate({
                        to: "/specs",
                        search: {
                          environment: environmentId,
                          project: projectId,
                          slug: bound.slug,
                        },
                      });
                    }}
                  >
                    Open spec
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !state.canMutate}
                    onClick={() => void leave()}
                  >
                    Leave Spec mode
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Role for this thread</span>
                  <Select
                    value={role}
                    onValueChange={(value) => value && setRole(value as SpecRole)}
                  >
                    <SelectTrigger aria-label="Spec role">
                      <SelectValue>{formatSpecRoleLabel(role)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup {...floatingLayerProps}>
                      {ALL_SPEC_ROLES.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                          {formatSpecRoleLabel(entry)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Spec</span>
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
                      <SelectPopup {...floatingLayerProps}>
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
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy || !state.canMutate || refusal !== null || selectedSlug === null}
                    onClick={() => {
                      const target = state.specs.find((entry) => entry.slug === selectedSlug);
                      if (target) void bind(target);
                    }}
                  >
                    Use spec
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!state.canMutate || refusal !== null}
                    onClick={() => {
                      setOpen(false);
                      setCreating(true);
                    }}
                  >
                    New spec
                  </Button>
                </div>
              </>
            )}
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
      {creating ? (
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
      ) : null}
    </>
  );
}
