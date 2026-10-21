import { splitProposedPlanSections, proposedPlanOutline } from "./proposedPlanText.ts";
import { describe, expect, it } from "vite-plus/test";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "./proposedPlanText.ts";

describe("proposedPlanTitle", () => {
  it("reads the first markdown heading as the plan title", () => {
    expect(proposedPlanTitle("# Integrate RPC\n\nBody")).toBe("Integrate RPC");
  });

  it("returns null when the plan has no heading", () => {
    expect(proposedPlanTitle("- step 1")).toBeNull();
  });
});

describe("stripDisplayedPlanMarkdown", () => {
  it("drops the leading title heading from displayed plan markdown", () => {
    expect(stripDisplayedPlanMarkdown("# Integrate RPC\n\n## Summary\n\n- step 1\n")).toBe(
      "- step 1",
    );
  });

  it("preserves non-summary headings after dropping the title heading", () => {
    expect(stripDisplayedPlanMarkdown("# Integrate RPC\n\n## Scope\n\n- step 1\n")).toBe(
      "## Scope\n\n- step 1",
    );
  });
});

describe("splitProposedPlanSections", () => {
  it("ignores fenced headings and headings deeper than level three", () => {
    const markdown =
      "# Plan\n```md\n## Example\n````\n~~~~\n# Another example\n~~~~\n#### Detail\n## Work\nDo it";
    const sections = splitProposedPlanSections(markdown);
    expect(sections.map((section) => section.title)).toEqual(["Plan", "Work"]);
    expect(sections.map((section) => section.markdown).join("\n")).toBe(markdown);
  });
  it("gives duplicate headings stable distinct ids", () => {
    expect(proposedPlanOutline("## Work\nA\n## Work\nB")).toEqual([
      { id: "work-1", level: 2, title: "Work" },
      { id: "work-2", level: 2, title: "Work" },
    ]);
  });
  it("keeps a heading-free plan in one section", () => {
    expect(splitProposedPlanSections("Do this\nthen that")).toEqual([
      { id: "plan-1", title: "Plan", level: 0, markdown: "Do this\nthen that" },
    ]);
  });
});

it("keeps list and blockquote fences out of top-level plan sections", () => {
  const markdown =
    "# Plan\n\n- ```md\n  # Sample\n  ```\n\n> ```md\n> ## Quoted\n> ```\n\n## Work\nDo it";
  const sections = splitProposedPlanSections(markdown);
  expect(sections.map((section) => section.title)).toEqual(["Plan", "Work"]);
  expect(sections.map((section) => section.markdown).join("\n")).toBe(markdown);
});
it("does not split on headings in an unfenced list or blockquote", () => {
  expect(
    splitProposedPlanSections("# Plan\n- item\n  ## Nested\n\n> ## Quoted\n\n## Work").map(
      (section) => section.title,
    ),
  ).toEqual(["Plan", "Work"]);
});

it("ends a list fence before the immediately following top-level Work heading", () => {
  expect(
    splitProposedPlanSections("- ```md\n  # Sample\n  ```\n## Work").map(
      (section) => section.title,
    ),
  ).toEqual(["Plan", "Work"]);
});
