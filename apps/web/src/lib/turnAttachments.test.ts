import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import type { ComposerImageAttachment } from "../composerDraftStore";
vi.mock("./attachmentUploadQueue", () => ({
  startAttachmentUpload: vi.fn(),
  awaitAttachmentUploads: vi.fn().mockResolvedValue(undefined),
  getUploadedAttachments: vi.fn(),
}));
vi.mock("./imageCompression", () => ({
  readFileAsDataUrl: vi.fn().mockResolvedValue("data:image/png;base64,YQ=="),
}));
import { getUploadedAttachments, startAttachmentUpload } from "./attachmentUploadQueue";
import { resolvePlanTurnAttachments } from "./turnAttachments";

const environmentId = EnvironmentId.make("env");
const image: ComposerImageAttachment = {
  type: "image",
  id: "draft-image",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 1,
  file: new File(["a"], "screen.png", { type: "image/png" }),
  previewUrl: "blob:screen",
};
beforeEach(() => vi.clearAllMocks());
describe("plan turn attachments", () => {
  it("binds image references to uploaded attachment ids without a thread target", async () => {
    vi.mocked(getUploadedAttachments).mockReturnValue([
      { type: "image", id: "uploaded", name: image.name, mimeType: image.mimeType, sizeBytes: 1 },
    ]);
    const resolved = await resolvePlanTurnAttachments(environmentId, [image]);
    expect(startAttachmentUpload).toHaveBeenCalledWith({ environmentId, image });
    expect(resolved.attachments[0]?.id).toBe("uploaded");
    expect(resolved.context?.records[0]).toMatchObject({
      kind: "image",
      contextId: "image_draft-image",
      attachmentId: "uploaded",
    });
  });
  it("falls back to data URLs and preserves context binding for a new thread", async () => {
    vi.mocked(getUploadedAttachments).mockReturnValue(null);
    const resolved = await resolvePlanTurnAttachments(environmentId, [image]);
    expect(resolved.attachments[0]).toMatchObject({
      id: image.id,
      dataUrl: "data:image/png;base64,YQ==",
    });
    expect(resolved.context?.records[0]).toMatchObject({
      contextId: "image_draft-image",
      attachmentId: image.id,
    });
  });
});
