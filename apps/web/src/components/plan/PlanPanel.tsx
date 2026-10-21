import { MessageSquarePlus } from "lucide-react";
import { cn } from "../../lib/utils";
import { randomUUID } from "../../lib/utils";
import { memo, useDeferredValue, useEffect, useRef, useState } from "react";
import {
  AuthOrchestrationOperateScope,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
  TurnItemId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { proposedPlanTitle } from "@t3tools/shared/proposedPlanText";
import { toKindScopedComposerContextId } from "@t3tools/shared/composerContextReferences";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import {
  planDraftKey,
  isPlanPreparationCurrent,
  usePlanDraftStore,
  type PlanDraft,
} from "../../planDraftStore";
import {
  buildPlanFeedbackPrompt,
  planCommentQuote,
  planSectionsWithDefinitions,
  insertPlanImageReferences,
  collectReferencedPlanImages,
  pruneMissingImageReferences,
} from "../../proposedPlan";
import { imageContextReference } from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import { useTurnItemDetail } from "../../state/queries";
import { useEnvironmentScope } from "../../state/session";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { PlanExportActions } from "./PlanExportActions";

export interface PlanAction {
  kind: "implement" | "implement-new-thread" | "feedback";
  planId: string;
  markdown: string;
  text: string;
  images: ComposerImageAttachment[];
}
export interface PlanPanelActions {
  projection: OrchestrationV2ThreadProjection | null;
  workspaceRoot: string | undefined;
  currentPlanId: string | null;
  busy: boolean;
  onSubmit: (action: PlanAction) => Promise<boolean>;
}

const PlanSection = memo(function PlanSection({
  markdown,
  threadRef,
  cwd,
  images,
}: {
  markdown: string;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
  images: ComposerImageAttachment[];
}) {
  return (
    <ChatMarkdown
      text={markdown}
      threadRef={threadRef}
      environmentId={threadRef.environmentId}
      cwd={cwd}
      renderContextReference={(reference) => {
        const image = images.find(
          (entry) => toKindScopedComposerContextId("image", entry.id) === reference.contextId,
        );
        return image ? (
          <img
            src={image.previewUrl}
            alt={image.name}
            className="max-h-96 max-w-full rounded-lg object-contain"
          />
        ) : (
          <span>Image unavailable on this device</span>
        );
      }}
    />
  );
});

export default function PlanPanel({
  threadRef,
  planId,
  itemId,
  projection,
  workspaceRoot,
  currentPlanId,
  busy,
  onSubmit,
}: PlanPanelActions & { threadRef: ScopedThreadRef; planId: string; itemId?: string }) {
  const artifact = projection?.plans.find(
    (entry) => entry.id === planId && entry.kind === "proposed_plan",
  );
  const row = projection?.turnItems.find(
    (entry) => entry.type === "proposed_plan" && entry.planId === planId,
  );
  const loaded = row?.type === "proposed_plan" ? row : null;
  const sourceMarkdown =
    loaded?.markdown || (artifact?.kind === "proposed_plan" ? artifact.markdown : "");
  const detail = useTurnItemDetail(
    !sourceMarkdown && (row || itemId)
      ? {
          ...threadRef,
          itemId: row?.id ?? TurnItemId.make(itemId!),
          revision: row ? String(row.updatedAt) : planId,
        }
      : null,
  );
  const queried = detail.data?.item;
  const markdown = sourceMarkdown || (queried?.type === "proposed_plan" ? queried.markdown : "");
  if (!markdown)
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {detail.error ?? (detail.isPending ? "Loading plan…" : "This plan is unavailable.")}
      </div>
    );
  return (
    <PlanDocument
      key={`${scopedThreadKey(threadRef)}:${planId}`}
      threadRef={threadRef}
      planId={planId}
      markdown={markdown}
      status={
        artifact?.status === "active" && currentPlanId !== null && currentPlanId !== planId
          ? "superseded"
          : (artifact?.status ?? null)
      }
      workspaceRoot={workspaceRoot}
      busy={busy}
      onSubmit={onSubmit}
    />
  );
}

function PlanDocument({
  threadRef,
  planId,
  markdown: original,
  status,
  workspaceRoot,
  busy,
  onSubmit,
}: Omit<PlanPanelActions, "projection" | "currentPlanId"> & {
  threadRef: ScopedThreadRef;
  planId: string;
  markdown: string;
  status: string | null;
}) {
  const key = planDraftKey(scopedThreadKey(threadRef), planId);
  const stored = usePlanDraftStore((state) => state.drafts[key]);
  const draft: PlanDraft = stored ?? {
    baseMarkdown: original,
    markdown: original,
    comments: [],
    images: [],
  };
  const imageInputs = useRef(new Map<string, HTMLInputElement>());
  const editors = useRef(new Map<string, HTMLTextAreaElement>());
  const [editing, setEditing] = useState(false);
  const [commentSection, setCommentSection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const active = status === "active";
  const editable = active && canOperate && !busy && !sending;
  const deferredMarkdown = useDeferredValue(draft.markdown);
  const sections = planSectionsWithDefinitions(deferredMarkdown);
  const preparing = usePlanDraftStore((state) => (state.preparing[key] ?? 0) > 0);
  useEffect(() => () => usePlanDraftStore.getState().cancelPreparations(key), [key]);
  const edited = draft.markdown !== draft.baseMarkdown;
  const missingImages = collectReferencedPlanImages(
    draft.markdown + draft.comments.map((comment) => comment.text).join("\n"),
  ).some(
    (id) => !draft.images.some((image) => toKindScopedComposerContextId("image", image.id) === id),
  );
  const save = (change: Partial<PlanDraft>) =>
    usePlanDraftStore.getState().save(key, { ...draft, ...change });
  function updateComment(sectionId: string, text: string) {
    const section = sections.find((entry) => entry.id === sectionId)!;
    const existing = draft.comments.find((comment) => comment.sectionId === sectionId);
    save({
      comments: [
        ...draft.comments.filter((comment) => comment.sectionId !== sectionId),
        {
          id: existing?.id ?? randomUUID(),
          sectionId,
          sectionTitle: section.title,
          quote: planCommentQuote(section.markdown),
          text,
          imageIds: existing?.imageIds ?? [],
        },
      ],
    });
  }
  async function addImages(files: File[], sectionId?: string) {
    const editor = editors.current.get(sectionId ?? "plan");
    const selection = editor
      ? { start: editor.selectionStart, end: editor.selectionEnd }
      : undefined;
    const generation = usePlanDraftStore.getState().beginPreparation(key);
    if (!usePlanDraftStore.getState().drafts[key]) usePlanDraftStore.getState().save(key, draft);
    const images: ComposerImageAttachment[] = [];
    for (const file of files.filter((entry) => entry.type.startsWith("image/"))) {
      const prepared = await prepareImageForAttachment(
        file,
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      ).catch(() => ({ ok: false as const, reason: "unreadable" }));
      if (!isPlanPreparationCurrent(key, generation)) break;
      if (!prepared.ok) {
        setError(`Could not attach ${file.name}: ${prepared.reason}.`);
        continue;
      }
      images.push({
        type: "image",
        id: randomUUID(),
        name: prepared.file.name,
        mimeType: prepared.file.type,
        sizeBytes: prepared.file.size,
        file: prepared.file,
        previewUrl: URL.createObjectURL(prepared.file),
      });
    }
    const current = usePlanDraftStore.getState().drafts[key];
    usePlanDraftStore.getState().finishPreparation(key, generation);
    if (!isPlanPreparationCurrent(key, generation) || !current) {
      for (const image of images) URL.revokeObjectURL(image.previewUrl);
      return;
    }
    const references = images
      .map((image) => formatInlineContextReference(imageContextReference(image)))
      .join("\n");
    if (!references) return;
    if (sectionId) {
      const section = sections.find((entry) => entry.id === sectionId)!;
      const existing = current.comments.find((comment) => comment.sectionId === sectionId);
      usePlanDraftStore.getState().save(key, {
        ...current,
        images: [...current.images, ...images],
        comments: [
          ...current.comments.filter((comment) => comment.sectionId !== sectionId),
          {
            id: existing?.id ?? randomUUID(),
            sectionId,
            sectionTitle: section.title,
            quote: planCommentQuote(section.markdown),
            text: insertPlanImageReferences(existing?.text ?? "", references, selection),
            imageIds: [...(existing?.imageIds ?? []), ...images.map((image) => image.id)],
          },
        ],
      });
    } else
      usePlanDraftStore.getState().save(key, {
        ...current,
        markdown: insertPlanImageReferences(current.markdown, references, selection),
        images: [...current.images, ...images],
      });
  }
  async function submit(kind: PlanAction["kind"]) {
    if (!editable || preparing || usePlanDraftStore.getState().preparing[key]) return;
    setSending(true);
    setError(null);
    const available = new Set(
      draft.images.map((image) => toKindScopedComposerContextId("image", image.id)),
    );
    const markdown = pruneMissingImageReferences(draft.markdown, available);
    const comments = draft.comments
      .filter((comment) => comment.text.trim())
      .map((comment) => ({
        ...comment,
        text: pruneMissingImageReferences(comment.text, available),
      }));
    const text =
      kind === "feedback"
        ? buildPlanFeedbackPrompt({ comments, ...(edited ? { editedMarkdown: markdown } : {}) })
        : "";
    const referenced = new Set(collectReferencedPlanImages(kind === "feedback" ? text : markdown));
    const images = draft.images.filter((image) =>
      referenced.has(toKindScopedComposerContextId("image", image.id)),
    );
    const sent = await onSubmit({ kind, planId, markdown, text, images }).catch(
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not send plan. Try again.");
        return false;
      },
    );
    if (!sent) setError((message) => message ?? "Plan action was not sent.");
    setSending(false);
  }
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">
            {proposedPlanTitle(draft.markdown) ?? "Proposed plan"}
          </h2>
          {status !== null ? (
            <p className="text-xs text-muted-foreground">
              {status === "completed"
                ? "Implemented"
                : status === "superseded"
                  ? "Replaced by a newer plan"
                  : status === "draft"
                    ? "Plan in progress"
                    : edited
                      ? "Edited"
                      : "Ready for review"}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {active && canOperate ? (
            <>
              <Button
                size="sm"
                disabled={!editable || preparing}
                onClick={() => void submit("implement")}
              >
                Implement
              </Button>
              <Menu>
                <MenuTrigger
                  render={<Button size="sm" variant="outline" disabled={!editable || preparing} />}
                >
                  More
                </MenuTrigger>
                <MenuPopup>
                  <MenuItem onClick={() => void submit("implement-new-thread")}>
                    Implement in new thread
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </>
          ) : null}
          <PlanExportActions
            planMarkdown={draft.markdown}
            environmentId={threadRef.environmentId}
            workspaceRoot={workspaceRoot}
          />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-gutter-both p-4">
        <div className="mb-4 flex items-center gap-2">
          {active && canOperate ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || sending}
              onClick={() => setEditing(!editing)}
            >
              {editing ? "Preview" : "Edit"}
            </Button>
          ) : null}
          {stored ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={sending}
              onClick={() => usePlanDraftStore.getState().discard(key)}
            >
              Discard draft
            </Button>
          ) : null}
        </div>
        {status !== null && !active && stored ? (
          <p className="mb-4 text-sm text-muted-foreground">
            Your draft is kept on this device. This plan can no longer be changed.
          </p>
        ) : null}
        {missingImages ? (
          <p className="mb-4 text-sm text-muted-foreground">
            Some images are no longer on this device. Attach them again before sending; unavailable
            references will be removed.
          </p>
        ) : null}
        <div className="grid items-start gap-6 @3xl:grid-cols-[12rem_minmax(0,1fr)]">
          <nav
            aria-label="Plan outline"
            className="hidden @3xl:sticky @3xl:top-0 @3xl:grid @3xl:gap-2"
          >
            {sections.map((section) => (
              <Button
                key={section.id}
                size="sm"
                variant="ghost"
                onClick={() =>
                  document.getElementById(`plan-${section.id}`)?.scrollIntoView({ block: "start" })
                }
              >
                {section.title}
              </Button>
            ))}
          </nav>
          <div className="min-w-0">
            <div className="mb-4 @3xl:hidden">
              <Menu>
                <MenuTrigger render={<Button size="sm" variant="outline" />}>Outline</MenuTrigger>
                <MenuPopup>
                  {sections.map((section) => (
                    <MenuItem
                      key={section.id}
                      onClick={() =>
                        document
                          .getElementById(`plan-${section.id}`)
                          ?.scrollIntoView({ block: "start" })
                      }
                    >
                      {section.title}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            </div>
            <div className="mx-auto max-w-[72ch] space-y-6">
              {editing && editable ? (
                <div
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    void addImages(Array.from(event.dataTransfer.files));
                  }}
                >
                  <Textarea
                    size="document"
                    ref={(element) => {
                      if (element) editors.current.set("plan", element);
                      else editors.current.delete("plan");
                    }}
                    aria-label="Plan markdown"
                    value={draft.markdown}
                    onChange={(event) => save({ markdown: event.target.value })}
                    onPaste={(event) => {
                      const files = Array.from(event.clipboardData.files);
                      if (files.length) {
                        event.preventDefault();
                        void addImages(files);
                      }
                    }}
                  />
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!editable || preparing}
                      onClick={() => imageInputs.current.get("plan")?.click()}
                    >
                      Attach screenshots
                    </Button>
                    <input
                      hidden
                      ref={(element) => {
                        if (element) imageInputs.current.set("plan", element);
                        else imageInputs.current.delete("plan");
                      }}
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(event) => {
                        void addImages(Array.from(event.target.files ?? []));
                        event.target.value = "";
                      }}
                    />
                  </div>
                </div>
              ) : (
                <>
                  {sections.map((section) => (
                    <section
                      id={`plan-${section.id}`}
                      key={section.id}
                      className="group/plan-section relative scroll-mt-4 pr-9"
                    >
                      <PlanSection
                        markdown={section.markdown}
                        threadRef={threadRef}
                        cwd={workspaceRoot}
                        images={draft.images}
                      />
                      {editable ? (
                        <div
                          className={cn(
                            "absolute right-0 top-0 opacity-0 group-hover/plan-section:opacity-100 group-focus-within/plan-section:opacity-100",
                            draft.comments.some(
                              (comment) =>
                                comment.sectionId === section.id &&
                                (comment.text.trim() || comment.imageIds.length),
                            ) && "opacity-100",
                          )}
                        >
                          <Button
                            size="icon-xs"
                            aria-label={`Comment on ${section.title}`}
                            aria-expanded={commentSection === section.id}
                            variant="ghost"
                            onClick={() =>
                              setCommentSection(commentSection === section.id ? null : section.id)
                            }
                          >
                            <MessageSquarePlus aria-hidden="true" className="size-4" />
                          </Button>
                          {draft.comments.some(
                            (comment) =>
                              comment.sectionId === section.id &&
                              (comment.text.trim() || comment.imageIds.length),
                          ) ? (
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary"
                            />
                          ) : null}
                        </div>
                      ) : null}
                      {commentSection === section.id && editable ? (
                        <div className="mt-2 space-y-2">
                          <Textarea
                            ref={(element) => {
                              if (element) editors.current.set(section.id, element);
                              else editors.current.delete(section.id);
                            }}
                            aria-label={`Comment on ${section.title}`}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => {
                              event.preventDefault();
                              void addImages(Array.from(event.dataTransfer.files), section.id);
                            }}
                            value={
                              draft.comments.find((comment) => comment.sectionId === section.id)
                                ?.text ?? ""
                            }
                            onChange={(event) => updateComment(section.id, event.target.value)}
                            onPaste={(event) => {
                              const files = Array.from(event.clipboardData.files);
                              if (files.length) {
                                event.preventDefault();
                                void addImages(files, section.id);
                              }
                            }}
                          />
                          <div>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!editable || preparing}
                              onClick={() => imageInputs.current.get(section.id)?.click()}
                            >
                              Attach screenshots
                            </Button>
                            <input
                              hidden
                              ref={(element) => {
                                if (element) imageInputs.current.set(section.id, element);
                                else imageInputs.current.delete(section.id);
                              }}
                              type="file"
                              accept="image/*"
                              multiple
                              onChange={(event) => {
                                void addImages(Array.from(event.target.files ?? []), section.id);
                                event.target.value = "";
                              }}
                            />
                          </div>
                        </div>
                      ) : null}
                    </section>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      {error ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {draft.comments.some((comment) => comment.text.trim()) || (active && canOperate && edited) ? (
        <footer className="space-y-2 border-t p-4">
          <div className="max-h-32 space-y-2 overflow-auto">
            {draft.comments
              .filter((comment) => comment.text.trim())
              .map((comment) => (
                <div key={comment.id} className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium">{comment.sectionTitle}</p>
                    <PlanSection
                      markdown={comment.text}
                      threadRef={threadRef}
                      cwd={workspaceRoot}
                      images={draft.images}
                    />
                  </div>
                  {active && canOperate ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={sending}
                      onClick={() =>
                        save({
                          comments: draft.comments.filter((entry) => entry.id !== comment.id),
                        })
                      }
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              ))}
          </div>
          {active && canOperate ? (
            <Button
              size="sm"
              disabled={!editable || preparing}
              onClick={() => void submit("feedback")}
            >
              Send feedback ({draft.comments.filter((comment) => comment.text.trim()).length})
            </Button>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}
