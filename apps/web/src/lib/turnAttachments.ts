import type { ChatAttachment, EnvironmentId, UploadChatAttachment } from "@t3tools/contracts";
import type { ComposerImageAttachment } from "../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  startAttachmentUpload,
} from "./attachmentUploadQueue";
import { readFileAsDataUrl } from "./imageCompression";
import { buildMessageContext } from "./composerContextRecords";

export async function resolvePlanTurnAttachments(
  environmentId: EnvironmentId,
  images: ReadonlyArray<ComposerImageAttachment>,
) {
  for (const image of images) startAttachmentUpload({ environmentId, image });
  await awaitAttachmentUploads(images.map((image) => image.id));
  const uploaded = getUploadedAttachments({ environmentId, images });
  const attachments: (ChatAttachment | UploadChatAttachment)[] =
    uploaded ??
    (await Promise.all(
      images.map(async (image) => ({
        type: "image" as const,
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    ));
  const context = buildMessageContext({
    terminalContexts: [],
    reviewComments: [],
    previewAnnotations: [],
    attachments: images.map((attachment, index) => ({
      attachment,
      attachmentId: attachments[index]!.id!,
    })),
  });
  return { attachments, context };
}
