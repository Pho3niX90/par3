import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
vi.mock("./lib/attachmentUploadQueue", () => ({ releaseDraftAttachments: vi.fn() }));
import { releaseDraftAttachments } from "./lib/attachmentUploadQueue";
import {
  hydratePlanDrafts,
  isPlanPreparationCurrent,
  planDraftKey,
  usePlanDraftStore,
} from "./planDraftStore";
const draft = (markdown: string) => ({
  baseMarkdown: "# Original",
  markdown,
  comments: [],
  images: [],
});
beforeEach(() => usePlanDraftStore.setState({ drafts: {}, preparing: {} }));
describe("plan drafts", () => {
  it("keeps plans separate across threads and environments", () => {
    const store = usePlanDraftStore.getState();
    store.save(planDraftKey("env-a:thread", "plan"), draft("A"));
    store.save(planDraftKey("env-b:thread", "plan"), draft("B"));
    expect(
      Object.values(usePlanDraftStore.getState().drafts).map((entry) => entry.markdown),
    ).toEqual(["A", "B"]);
  });
  it("evicts the least recently edited draft at twenty entries", () => {
    const store = usePlanDraftStore.getState();
    for (let index = 0; index < 20; index++) store.save(`plan:${index}`, draft(String(index)));
    store.save("plan:0", draft("updated"));
    store.save("plan:20", draft("new"));
    expect(Object.keys(usePlanDraftStore.getState().drafts)).toHaveLength(20);
    expect(usePlanDraftStore.getState().drafts["plan:0"]?.markdown).toBe("updated");
    expect(usePlanDraftStore.getState().drafts["plan:1"]).toBeUndefined();
    expect(releaseDraftAttachments).toHaveBeenCalled();
  });
  it("discards a draft and releases its attachments", () => {
    const store = usePlanDraftStore.getState();
    store.save("plan", draft("edited"));
    store.discard("plan");
    expect(usePlanDraftStore.getState().drafts.plan).toBeUndefined();
    expect(releaseDraftAttachments).toHaveBeenCalledWith([]);
  });
  it("persists markdown and comments without image files or preview URLs", () => {
    const image = {
      type: "image" as const,
      id: "image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 1,
      file: new File(["a"], "screen.png"),
      previewUrl: "blob:screen",
    };
    usePlanDraftStore.getState().save("plan", { ...draft("edited"), images: [image] });
    const persisted = usePlanDraftStore.persist.getOptions().partialize!(
      usePlanDraftStore.getState(),
    );
    expect(JSON.stringify(persisted)).not.toContain("blob:screen");
    expect(persisted.drafts.plan).toEqual({
      baseMarkdown: "# Original",
      markdown: "edited",
      comments: [],
    });
  });
});

it("hydrates empty storage without throwing and rejects malformed entries", async () => {
  await expect(usePlanDraftStore.persist.rehydrate()).resolves.toBeUndefined();
  const state = usePlanDraftStore.getState();
  expect(usePlanDraftStore.persist.getOptions().merge!(undefined, state).drafts).toEqual({});
  for (const value of [
    undefined,
    null,
    {},
    { drafts: null },
    { drafts: [] },
    { drafts: { invalid: { markdown: "x" } } },
    { drafts: { invalid: { baseMarkdown: "x", markdown: "x", comments: [null] } } },
  ])
    expect(hydratePlanDrafts(value)).toEqual({});
  expect(
    hydratePlanDrafts({
      drafts: { plan: { baseMarkdown: "a", markdown: "b", comments: [], images: ["blob"] } },
    }).plan,
  ).toEqual({ baseMarkdown: "a", markdown: "b", comments: [], images: [] });
});
it("discards only the exact submitted draft snapshot", () => {
  const store = usePlanDraftStore.getState();
  const snapshot = draft("submitted");
  store.save("plan", snapshot);
  store.save("plan", draft("new edit"));
  store.discardIfUnchanged("plan", snapshot);
  expect(usePlanDraftStore.getState().drafts.plan?.markdown).toBe("new edit");
  store.discardIfUnchanged("plan", usePlanDraftStore.getState().drafts.plan);
  expect(usePlanDraftStore.getState().drafts.plan).toBeUndefined();
});
it("invalidates pending image preparations on discard and unmount cancellation", () => {
  const store = usePlanDraftStore.getState();
  store.save("plan", draft("base"));
  const generation = store.beginPreparation("plan");
  expect(usePlanDraftStore.getState().preparing.plan).toBe(1);
  store.discard("plan");
  expect(isPlanPreparationCurrent("plan", generation)).toBe(false);
  const next = store.beginPreparation("plan");
  store.finishPreparation("plan", generation);
  expect(usePlanDraftStore.getState().preparing.plan).toBe(1);
  store.cancelPreparations("plan");
  expect(isPlanPreparationCurrent("plan", next)).toBe(false);
  expect(usePlanDraftStore.getState().drafts.plan).toBeUndefined();
});

it("keeps unsent section comments on implementation, but clears a submitted feedback snapshot", () => {
  const store = usePlanDraftStore.getState();
  const snapshot = {
    ...draft("edited"),
    comments: [
      { id: "c", sectionId: "s", sectionTitle: "Work", text: "Keep this feedback", imageIds: [] },
    ],
  };
  store.save("plan", snapshot);
  store.discardIfUnchanged("plan", snapshot, true);
  expect(usePlanDraftStore.getState().drafts.plan).toBe(snapshot);
  store.discardIfUnchanged("plan", snapshot, false);
  expect(usePlanDraftStore.getState().drafts.plan).toBeUndefined();
});
