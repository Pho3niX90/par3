import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import {
  splitProposedPlanSections,
  proposedPlanReferenceDefinitions,
} from "@t3tools/shared/proposedPlanText";
import { stripDisplayedPlanMarkdown, proposedPlanTitle } from "@t3tools/shared/proposedPlanText";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";

export interface PlanComment {
  id: string;
  sectionId: string;
  sectionTitle: string;
  text: string;
  imageIds: string[];
  quote?: string;
}

export function buildPlanFeedbackPrompt(input: {
  comments: ReadonlyArray<PlanComment>;
  editedMarkdown?: string;
}) {
  const comments = input.comments.map(
    (comment) =>
      `## ${comment.sectionTitle}\n${comment.quote ? `> ${planCommentQuote(comment.quote).replace(/\n/g, "\n> ")}\n\n` : ""}${comment.text.trim()}`,
  );
  return [
    "Please revise the plan using this feedback:",
    ...comments,
    ...(input.editedMarkdown === undefined ? [] : [`## Edited plan\n\n${input.editedMarkdown}`]),
  ].join("\n\n");
}

export function collectReferencedPlanImages(markdown: string) {
  return [
    ...new Set(
      collectComposerContextReferences(markdown)
        .filter((reference) => reference.kind === "image")
        .map((reference) => reference.contextId),
    ),
  ];
}

export function pruneMissingImageReferences(markdown: string, availableIds: ReadonlySet<string>) {
  return replaceComposerContextReferences(markdown, (reference) =>
    reference.kind === "image" && !availableIds.has(reference.contextId) ? "" : reference.source,
  );
}

export function buildCollapsedProposedPlanPreviewMarkdown(
  planMarkdown: string,
  options?: {
    maxLines?: number;
  },
): string {
  const maxLines = options?.maxLines ?? 8;
  const lines = stripDisplayedPlanMarkdown(planMarkdown)
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const previewLines: string[] = [];
  let visibleLineCount = 0;
  let hasMoreContent = false;

  for (const line of lines) {
    const isVisibleLine = line.trim().length > 0;
    if (isVisibleLine && visibleLineCount >= maxLines) {
      hasMoreContent = true;
      break;
    }
    previewLines.push(line);
    if (isVisibleLine) {
      visibleLineCount += 1;
    }
  }

  while (previewLines.length > 0 && previewLines.at(-1)?.trim().length === 0) {
    previewLines.pop();
  }

  if (previewLines.length === 0) {
    return proposedPlanTitle(planMarkdown) ?? "Plan preview unavailable.";
  }

  if (hasMoreContent) {
    previewLines.push("", "...");
  }

  return previewLines.join("\n");
}

function sanitizePlanFileSegment(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "plan";
}

export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}${planMarkdown.trim()}`;
}

/** An empty draft implements the plan in build mode; typed text refines it, in plan mode when available. */
export function resolvePlanFollowUpSubmission(input: {
  draftText: string;
  planMarkdown: string;
  planModeAvailable: boolean;
}): {
  text: string;
  interactionMode: "default" | "plan";
  implementsPlan: boolean;
} {
  const trimmedDraftText = input.draftText.trim();
  if (trimmedDraftText.length > 0) {
    return {
      text: trimmedDraftText,
      interactionMode: input.planModeAvailable ? "plan" : "default",
      implementsPlan: false,
    };
  }

  return {
    text: buildPlanImplementationPrompt(input.planMarkdown),
    interactionMode: "default",
    implementsPlan: true,
  };
}

export function buildPlanImplementationThreadTitle(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  if (!title) {
    return "Implement plan";
  }
  return `Implement ${title}`;
}

export function buildProposedPlanMarkdownFilename(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  return `${sanitizePlanFileSegment(title ?? "plan")}.md`;
}

export function normalizePlanMarkdownForExport(planMarkdown: string): string {
  return `${replaceComposerContextReferences(planMarkdown, (reference) => (reference.kind === "image" ? `[image: ${reference.label}]` : reference.source)).trimEnd()}\n`;
}

export function downloadPlanAsTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export function insertPlanImageReferences(
  text: string,
  references: string,
  selection?: { start: number; end: number },
) {
  const start = Math.max(0, Math.min(text.length, selection?.start ?? text.length));
  const end = Math.max(start, Math.min(text.length, selection?.end ?? start));
  return `${text.slice(0, start)}\n\n${references}\n\n${text.slice(end)}`;
}

export function planCommentQuote(markdown: string) {
  // A placeholder rather than nothing, so an image inside a code span doesn't leave an empty `` behind.
  return replaceComposerContextReferences(markdown, () => "[image]")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]")
    .slice(0, 240);
}

export function planSectionsWithDefinitions(markdown: string) {
  const definitions = proposedPlanReferenceDefinitions(markdown);
  return splitProposedPlanSections(markdown).map((section) => ({
    ...section,
    markdown: definitions ? `${section.markdown}\n\n${definitions}` : section.markdown,
  }));
}

export function proposedPlanItemId(projection: ThreadStructure | null, planId: string) {
  return projection?.turnItems.find(
    (item) => item.type === "proposed_plan" && item.planId === planId,
  )?.id;
}
