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
