import {
  normalizePlanMarkdownForExport,
  planCommentQuote,
  planSectionsWithDefinitions,
} from "./proposedPlan";
import { insertPlanImageReferences } from "./proposedPlan";
import {
  buildPlanFeedbackPrompt,
  collectReferencedPlanImages,
  pruneMissingImageReferences,
} from "./proposedPlan";
import { describe, expect, it } from "vite-plus/test";

import { resolvePlanFollowUpSubmission } from "./proposedPlan";

describe("resolvePlanFollowUpSubmission", () => {
  it.each(["", "Consider this "])(
    "keeps context-bearing feedback in plan mode with prose %j",
    (prose) => {
      const draftText = `${prose}[PR #42](t3-context://v1/review-comment/pr-42)`;
      expect(
        resolvePlanFollowUpSubmission({
          draftText,
          planMarkdown: "# Plan",
          planModeAvailable: true,
        }),
      ).toEqual({
        text: draftText,
        interactionMode: "plan",
        implementsPlan: false,
      });
    },
  );
  it("switches to default mode when implementing the ready plan without extra text", () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "   ",
        planMarkdown: "## Ship it\n\n- step 1\n",
        planModeAvailable: true,
      }),
    ).toEqual({
      text: "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1",
      interactionMode: "default",
      implementsPlan: true,
    });
  });
  it("refines in build mode without completing the plan when plan mode is unavailable", () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "Refine step 2 first",
        planMarkdown: "## Ship it\n\n- step 1\n",
        planModeAvailable: false,
      }),
    ).toEqual({
      text: "Refine step 2 first",
      interactionMode: "default",
      implementsPlan: false,
    });
  });
});

describe("plan feedback", () => {
  it("includes section context, comments, and only an explicitly edited plan", () => {
    const comments = [
      {
        id: "c",
        sectionId: "work-1",
        sectionTitle: "Work",
        quote: "Use the old approach",
        text: "Use the new approach",
        imageIds: [],
      },
    ];
    const prompt = buildPlanFeedbackPrompt({ comments });
    expect(prompt).toContain("## Work\n> Use the old approach\n\nUse the new approach");
    expect(prompt).not.toContain("## Edited plan");
    expect(buildPlanFeedbackPrompt({ comments, editedMarkdown: "# Revised" })).toContain(
      "## Edited plan\n\n# Revised",
    );
  });
  it("collects image ids once and prunes unavailable images without touching paths or other context", () => {
    const markdown =
      "![one](t3-context://v1/image/image_a) ![two](t3-context://v1/image/image_b) ![again](t3-context://v1/image/image_a) ![local](/tmp/screen.png) [file](t3-context://v1/file/file_a)";
    expect(collectReferencedPlanImages(markdown)).toEqual(["image_a", "image_b"]);
    const pruned = pruneMissingImageReferences(markdown, new Set(["image_a"]));
    expect(pruned).not.toContain("image_b");
    expect(pruned).toContain("![local](/tmp/screen.png)");
    expect(pruned).toContain("[file](t3-context://v1/file/file_a)");
  });
});

it("inserts images at a captured cursor or replaces its selection", () => {
  expect(insertPlanImageReferences("before after", "![screen](image)", { start: 7, end: 7 })).toBe(
    "before \n\n![screen](image)\n\nafter",
  );
  expect(insertPlanImageReferences("before replace after", "image", { start: 7, end: 14 })).toBe(
    "before \n\nimage\n\n after",
  );
  expect(insertPlanImageReferences("comment", "image")).toBe("comment\n\nimage\n\n");
});

it("exports internal image references as portable text placeholders", () => {
  expect(
    normalizePlanMarkdownForExport(
      "# Plan\n![screen.png](t3-context://v1/image/image_a)\n![local](/tmp/image.png)\n",
    ),
  ).toBe("# Plan\n[image: screen.png]\n![local](/tmp/image.png)\n");
});
it("removes image references before shortening comment quotes", () => {
  const quote =
    "a".repeat(220) + " ![screenshot](t3-context://v1/image/image_" + "b".repeat(100) + ") end";
  expect(planCommentQuote(quote)).not.toContain("t3-context");
  expect(
    buildPlanFeedbackPrompt({
      comments: [
        {
          id: "c",
          sectionId: "s",
          sectionTitle: "Section",
          text: "Change this",
          imageIds: [],
          quote,
        },
      ],
    }),
  ).not.toContain("![");
});
it("keeps each section and its reference definitions together", () => {
  const sections = planSectionsWithDefinitions(
    '# Plan\nSee [design][ref].\n## Work\nSee [design][ref].\n\n[ref]: https://example.com "Design"',
  );
  expect(sections.map((section) => section.title)).toEqual(["Plan", "Work"]);
  for (const section of sections)
    expect(section.markdown).toContain('[ref]: https://example.com "Design"');
});
