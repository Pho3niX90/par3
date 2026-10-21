import { create } from "zustand";
import { persist, type StorageValue } from "zustand/middleware";
import type { ComposerImageAttachment } from "./composerDraftStore";
import { releaseDraftAttachments } from "./lib/attachmentUploadQueue";
import { createDeferredStorage } from "./lib/storage";
import type { PlanComment } from "./proposedPlan";

export interface PlanDraft {
  baseMarkdown: string;
  markdown: string;
  comments: PlanComment[];
  images: ComposerImageAttachment[];
}
interface PlanDraftState {
  drafts: Record<string, PlanDraft>;
  preparing: Record<string, number>;
  beginPreparation: (key: string) => number;
  finishPreparation: (key: string, generation: number) => void;
  cancelPreparations: (key: string) => void;
  discardIfUnchanged: (
    key: string,
    snapshot: PlanDraft | undefined,
    keepComments?: boolean,
  ) => void;
  save: (key: string, draft: PlanDraft) => void;
  discard: (key: string) => void;
}
type PersistedDrafts = { drafts: Record<string, Omit<PlanDraft, "images">> };
const storage = createDeferredStorage<StorageValue<PersistedDrafts>>(
  typeof localStorage === "undefined" ? undefined : localStorage,
  JSON.stringify,
);

if (typeof window !== "undefined") window.addEventListener("pagehide", storage.flush);

export function planDraftKey(threadKey: string, planId: string) {
  return `${threadKey}:${planId}`;
}
function release(draft: PlanDraft | undefined) {
  if (!draft) return;
  for (const image of draft.images) URL.revokeObjectURL(image.previewUrl);
  releaseDraftAttachments(draft.images);
}
const preparationGenerations = new Map<string, number>();
export function isPlanPreparationCurrent(key: string, generation: number) {
  return (preparationGenerations.get(key) ?? 0) === generation;
}
export function hydratePlanDrafts(persisted: unknown): Record<string, PlanDraft> {
  if (
    !persisted ||
    typeof persisted !== "object" ||
    !("drafts" in persisted) ||
    !persisted.drafts ||
    typeof persisted.drafts !== "object" ||
    Array.isArray(persisted.drafts)
  )
    return {};
  return Object.fromEntries(
    Object.entries(persisted.drafts)
      .flatMap(([key, value]: [string, unknown]) => {
        if (
          !value ||
          typeof value !== "object" ||
          !("baseMarkdown" in value) ||
          typeof value.baseMarkdown !== "string" ||
          !("markdown" in value) ||
          typeof value.markdown !== "string" ||
          !("comments" in value) ||
          !Array.isArray(value.comments)
        )
          return [];
        const comments: PlanComment[] = [];
        for (const comment of value.comments as unknown[]) {
          if (
            !comment ||
            typeof comment !== "object" ||
            !("id" in comment) ||
            typeof comment.id !== "string" ||
            !("sectionId" in comment) ||
            typeof comment.sectionId !== "string" ||
            !("sectionTitle" in comment) ||
            typeof comment.sectionTitle !== "string" ||
            !("text" in comment) ||
            typeof comment.text !== "string" ||
            !("imageIds" in comment) ||
            !Array.isArray(comment.imageIds) ||
            !comment.imageIds.every((id: unknown) => typeof id === "string") ||
            ("quote" in comment && typeof comment.quote !== "string")
          )
            return [];
          comments.push({
            id: comment.id,
            sectionId: comment.sectionId,
            sectionTitle: comment.sectionTitle,
            text: comment.text,
            imageIds: comment.imageIds,
            ...("quote" in comment ? { quote: comment.quote as string } : {}),
          });
        }
        return [
          [
            key,
            { baseMarkdown: value.baseMarkdown, markdown: value.markdown, comments, images: [] },
          ],
        ];
      })
      .slice(-20),
  );
}

export const usePlanDraftStore = create<PlanDraftState>()(
  persist(
    (set, get) => ({
      drafts: {},
      preparing: {},
      beginPreparation: (key) => {
        const generation = preparationGenerations.get(key) ?? 0;
        set((state) => ({
          preparing: { ...state.preparing, [key]: (state.preparing[key] ?? 0) + 1 },
        }));
        return generation;
      },
      finishPreparation: (key, generation) => {
        if (!isPlanPreparationCurrent(key, generation)) return;
        set((state) => ({
          preparing: { ...state.preparing, [key]: Math.max(0, (state.preparing[key] ?? 0) - 1) },
        }));
      },
      cancelPreparations: (key) => {
        preparationGenerations.set(key, (preparationGenerations.get(key) ?? 0) + 1);
        set((state) => {
          const { [key]: _removed, ...preparing } = state.preparing;
          return { preparing };
        });
      },
      discardIfUnchanged: (key, snapshot, keepComments = false) => {
        if (
          keepComments &&
          snapshot?.comments.some((comment) => comment.text.trim() || comment.imageIds.length)
        )
          return;
        if (snapshot && get().drafts[key] === snapshot) get().discard(key);
      },
      save: (key, draft) =>
        set((state) => {
          const drafts = { ...state.drafts };
          delete drafts[key];
          drafts[key] = draft;
          while (Object.keys(drafts).length > 20) {
            const oldest = Object.keys(drafts)[0]!;
            preparationGenerations.set(oldest, (preparationGenerations.get(oldest) ?? 0) + 1);
            release(drafts[oldest]);
            delete drafts[oldest];
          }
          return {
            drafts,
            preparing: Object.fromEntries(
              Object.entries(state.preparing).filter(([key]) => key in drafts),
            ),
          };
        }),
      discard: (key) => {
        get().cancelPreparations(key);
        set((state) => {
          release(state.drafts[key]);
          const { [key]: _removed, ...drafts } = state.drafts;
          return { drafts };
        });
      },
    }),
    {
      name: "t3code:plan-drafts:v1",
      storage: {
        getItem: async (name) => {
          const raw = await storage.getItem(name);
          return raw ? (JSON.parse(raw) as StorageValue<PersistedDrafts>) : null;
        },
        setItem: storage.setItem,
        removeItem: storage.removeItem,
      },
      partialize: (state) => ({
        drafts: Object.fromEntries(
          Object.entries(state.drafts).map(([key, { images: _images, ...draft }]) => [key, draft]),
        ),
      }),
      merge: (persisted, current) => ({
        ...current,
        drafts: Object.fromEntries(
          Object.entries({ ...hydratePlanDrafts(persisted), ...current.drafts }).slice(-20),
        ),
      }),
    },
  ),
);
