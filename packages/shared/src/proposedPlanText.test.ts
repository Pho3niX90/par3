import { describe, expect, it } from "vite-plus/test";
import {
  proposedPlanOutline,
  proposedPlanTitle,
  splitProposedPlanSections,
  stripDisplayedPlanMarkdown,
} from "./proposedPlanText.ts";

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

it("takes the plan title from headings outside code", () => {
  for (const [open, inner, close] of [
    ["```bash", "~~~", "```"],
    ["~~~bash", "```", "~~~"],
    ["````bash", "```", "````"],
    ["```html", "<!--", "```"],
    ["```md", "```\u00a0", "``` \t"],
    ["```md\u2028", "example", "```"],
  ]) {
    const code = `${open}\n# Back up database\n${inner}\n# Still code\n${close}\n`;
    expect(proposedPlanTitle(`${code}\n## Real Plan Title\n`)).toBe("Real Plan Title");
  }
  expect(proposedPlanTitle("```bash\n# Back up database\n")).toBeNull();
  expect(proposedPlanTitle("\t# Back up database\n\n## Real Plan Title")).toBe("Real Plan Title");
});

it("takes the plan title from headings outside HTML comments", () => {
  for (const comment of ["<!--\n```ts\n-->", "<!--\n# Hidden title\n-->", "   <!-- # Hidden -->"]) {
    expect(proposedPlanTitle(`${comment}\n# Release plan`)).toBe("Release plan");
  }
  expect(proposedPlanTitle("<!--\n# Hidden title\n# Release plan")).toBeNull();
});

it("skips empty plan headings without reading into the next line", () => {
  for (const [heading, title] of [
    ["#   \r\n###\t\r\n## ###\r\n## Real Title", "Real Title"],
    ["## # #", "#"],
    ["## ###\t###", "###"],
  ]) {
    const markdown = `${heading}\r\n\r\n## Summary\r\n\r\nBody text`;
    expect(proposedPlanTitle(markdown)).toBe(title);
    expect(stripDisplayedPlanMarkdown(markdown)).toBe("Body text");
  }
});

it("strips the displayed plan title and summary after leading blank lines", () => {
  const markdown = "\r\n# My Plan\r\n\r\n## Summary\r\n\r\nBody text";
  expect(proposedPlanTitle(markdown)).toBe("My Plan");
  expect(stripDisplayedPlanMarkdown(markdown)).toBe("Body text");
});

it("reads the plan title past a leading byte-order mark", () => {
  for (const markdown of [
    "\uFEFF# Rollout\n\nDeploy",
    "\uFEFF   # Rollout\r\n\r\n## Summary\r\n\r\nDeploy",
  ]) {
    expect(proposedPlanTitle(markdown)).toBe("Rollout");
    expect(stripDisplayedPlanMarkdown(markdown)).toBe("Deploy");
  }
  expect(proposedPlanTitle("\uFEFF    # Indented code")).toBeNull();
});
