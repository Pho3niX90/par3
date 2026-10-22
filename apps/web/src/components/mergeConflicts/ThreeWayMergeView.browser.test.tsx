import { EnvironmentId, type MergeConflictReadResult } from "@t3tools/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
} from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent, page } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import { ThreeWayMergeView, type MergeApplyOutcome } from "./ThreeWayMergeView";

const BASE = "one\ntwo\nthree\nfour\n";
const OURS = "one\nOURS\nthree\nfour\nOURS-EXTRA\n";
const THEIRS = "one\nTHEIRS\nthree\nfour\n";

const read: MergeConflictReadResult = {
  path: "src/example.txt",
  kind: "both-modified",
  operation: { kind: "merge" },
  labels: { ours: "main", theirs: "feature" },
  expected: {
    stages: { base: "b".repeat(40), ours: "o".repeat(40), theirs: "t".repeat(40) },
    workingCopyHash: "w".repeat(40),
  },
  base: BASE,
  ours: OURS,
  theirs: THEIRS,
  workingCopy: "<<<<<<<",
  workingCopyHasMarkers: true,
  rerereResolved: false,
  lineEnding: "lf",
};

/** The text of the result pane, read from the shadow root pierre renders it into. */
function resultText(container: HTMLElement): string {
  const hosts = container.querySelectorAll("diffs-container");
  const rows = hosts[1]?.shadowRoot?.querySelectorAll("[data-line][data-line-index]") ?? [];
  return [...rows].map((row) => row.textContent ?? "").join("\n");
}

function sizedContainer() {
  const container = document.createElement("div");
  container.style.cssText = "width:1400px;height:600px;display:flex;flex-direction:column;";
  return container;
}

// A draft is kept per file state so it survives closing the view, which would carry one test's
// edits into the next; every test therefore opens its own path.
function uniqueFile(file: MergeConflictReadResult = read): MergeConflictReadResult {
  return { ...file, path: `src/example-${expect.getState().currentTestName}.txt` };
}

function renderView(
  onApply: (content: string) => Promise<MergeApplyOutcome> = vi.fn(async () => ({
    status: "applied" as const,
  })),
  fileOverride: MergeConflictReadResult = uniqueFile(),
  keybindings = DEFAULT_RESOLVED_KEYBINDINGS,
  environmentId = EnvironmentId.make("env-merge-test"),
) {
  return render(
    <ThreeWayMergeView
      environmentId={environmentId}
      cwd="/repo"
      file={fileOverride}
      keybindings={keybindings}
      hasNextFile={false}
      onApply={onApply}
      onCancel={vi.fn()}
      onReload={vi.fn()}
    />,
    // The merge editor has no route dependencies.
    { router: false, container: sizedContainer() },
  );
}

function shadowOf(container: HTMLElement, pane: 0 | 1 | 2) {
  return container.querySelectorAll("diffs-container")[pane]?.shadowRoot ?? null;
}

const numbered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join("");

describe("ThreeWayMergeView", () => {
  it("keeps drafts separate across environments with the same repository and file state", async () => {
    const file = uniqueFile();
    {
      await using screen = await renderView(undefined, file);
      await page.getByRole("button", { name: "Accept ours for change 1" }).click();
      await expect.element(screen.getByTestId("merge-counter")).toHaveTextContent("0 conflicts");
    }
    await using screen = await renderView(
      undefined,
      file,
      undefined,
      EnvironmentId.make("other-environment"),
    );
    await expect.element(screen.getByTestId("merge-counter")).toHaveTextContent("1 conflict");
    await vi.waitFor(() => expect(resultText(screen.container)).toContain("two"));
  });

  it("accepts a side into the result, counts it, and undoes both together", async () => {
    await using screen = await renderView();
    const counter = screen.getByTestId("merge-counter");
    await expect.element(counter).toHaveTextContent("2 changes · 1 conflict");
    // The conflict starts as the base text; the one-sided change is already applied.
    await vi.waitFor(() => expect(resultText(screen.container)).toContain("two"));
    expect(resultText(screen.container)).toContain("OURS-EXTRA");

    await page.getByRole("button", { name: "Accept ours for change 1" }).click();
    await expect.element(counter).toHaveTextContent("2 changes · 0 conflicts");
    await vi.waitFor(() => {
      expect(resultText(screen.container)).toContain("OURS");
      expect(resultText(screen.container)).not.toContain("two");
    });

    // Focus the result editor, then undo with its own key.
    const hosts = screen.container.querySelectorAll("diffs-container");
    const line = hosts[1]?.shadowRoot?.querySelector<HTMLElement>(
      "[data-line][data-line-index='0']",
    );
    await userEvent.click(line!);
    await userEvent.keyboard("{Control>}z{/Control}");
    await expect.element(counter).toHaveTextContent("2 changes · 1 conflict");
    await vi.waitFor(() => {
      expect(resultText(screen.container)).toContain("two");
      expect(resultText(screen.container)).not.toContain("OURS\n");
    });
  });

  it("tints rows, draws connectors and highlights changed words", async () => {
    await using screen = await renderView();
    await vi.waitFor(() => {
      for (const pane of [0, 1, 2] as const) {
        const css = shadowOf(screen.container, pane)?.querySelector("[data-merge-view-style]");
        expect(css?.textContent).toContain("--diffs-line-bg");
      }
    });
    expect(
      shadowOf(screen.container, 0)?.querySelector("[data-merge-view-style]")?.textContent,
    ).toContain("var(--warning)");
    await vi.waitFor(() => {
      expect(screen.container.querySelectorAll("[data-merge-divider] path").length).toBeGreaterThan(
        1,
      );
    });
    // The word diff of the conflict is registered for the side panes only.
    await vi.waitFor(() => {
      const names = [...CSS.highlights.keys()].filter((name) => name.startsWith("merge-word-"));
      expect(names.length).toBeGreaterThan(0);
      expect(names.some((name) => name.endsWith("-ours-conflict"))).toBe(true);
    });
  });

  it("applies the result, asking first while a conflict is left", async () => {
    const onApply = vi.fn(async (_content: string) => ({ status: "applied" as const }));
    await using screen = await renderView(onApply);
    const counter = screen.getByTestId("merge-counter");
    await expect.element(counter).toHaveTextContent("2 changes · 1 conflict");
    await vi.waitFor(() => expect(resultText(screen.container)).toContain("two"));

    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.element(page.getByText("Apply with conflicts left?")).toBeVisible();
    expect(onApply).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Apply anyway" }).click();
    await vi.waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0]![0]).toBe("one\ntwo\nthree\nfour\nOURS-EXTRA\n");
  });

  it("applies without asking once nothing is left to decide", async () => {
    const onApply = vi.fn(async (_content: string) => ({ status: "applied" as const }));
    await using screen = await renderView(onApply);
    await page.getByRole("button", { name: "Accept theirs for change 1" }).click();
    await expect
      .element(screen.getByTestId("merge-counter"))
      .toHaveTextContent("2 changes · 0 conflicts");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await vi.waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0]![0]).toBe("one\nTHEIRS\nthree\nfour\nOURS-EXTRA\n");
  });

  it("shows the stale message with a way to reload", async () => {
    const onReload = vi.fn();
    const onApply = vi.fn(async () => ({
      status: "stale" as const,
      message: "This file changed since you opened it.",
    }));
    await using screen = await render(
      <ThreeWayMergeView
        environmentId={EnvironmentId.make("env-merge-test")}
        cwd="/repo"
        file={uniqueFile()}
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        hasNextFile={false}
        onApply={onApply}
        onCancel={vi.fn()}
        onReload={onReload}
      />,
      // The merge editor has no route dependencies.
      { router: false, container: sizedContainer() },
    );
    await page.getByRole("button", { name: "Accept ours for change 1" }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.element(page.getByText("This file changed since you opened it.")).toBeVisible();
    await page.getByRole("button", { name: "Reload" }).click();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.container.querySelector("[role=alert]")).not.toBeNull();
  });

  it("takes theirs at the caret with a configured keyboard shortcut", async () => {
    await using screen = await renderView(
      undefined,
      uniqueFile(),
      compileResolvedKeybindingsConfig([
        { key: "ctrl+alt+right", command: "merge.acceptTheirs", when: "mergeViewFocus" },
      ]),
    );
    await vi.waitFor(() => expect(resultText(screen.container)).toContain("two"));
    const row = shadowOf(screen.container, 1)?.querySelector<HTMLElement>(
      "[data-line][data-line-index='1']",
    );
    await userEvent.click(row!);
    await userEvent.keyboard("{Control>}{Alt>}{ArrowRight}{/Alt}{/Control}");
    await expect
      .element(screen.getByTestId("merge-counter"))
      .toHaveTextContent("2 changes · 0 conflicts");
    await vi.waitFor(() => expect(resultText(screen.container)).toContain("THEIRS"));
  });

  it("keeps the side panes level with the pane being scrolled", async () => {
    const base = numbered("line", 300);
    const long: MergeConflictReadResult = {
      ...uniqueFile(),
      base,
      ours: base.replace("line 150\n", "OURS 150\nOURS 150b\nOURS 150c\n"),
      theirs: base.replace("line 150\n", "THEIRS 150\n"),
    };
    await using screen = await renderView(undefined, long);
    await vi.waitFor(() =>
      expect(shadowOf(screen.container, 0)?.querySelector("[data-line]")).not.toBeNull(),
    );
    const scrollers = [...screen.container.querySelectorAll("diffs-container")].map((host) =>
      host.closest<HTMLElement>(".overflow-auto")!,
    );
    expect(scrollers).toHaveLength(3);
    scrollers[1]!.scrollTop = 1500;
    await vi.waitFor(() => {
      expect(scrollers[0]!.scrollTop).toBeGreaterThan(1000);
      expect(scrollers[2]!.scrollTop).toBeGreaterThan(1000);
    });
  });

  it("accepts both sides in the order chosen from the menu", async () => {
    await using screen = await renderView();
    await page.getByRole("button", { name: "More ways to resolve change 1" }).click();
    await page.getByRole("menuitem", { name: "Accept both, theirs first" }).click();
    await expect
      .element(screen.getByTestId("merge-counter"))
      .toHaveTextContent("2 changes · 0 conflicts");
    await vi.waitFor(() => expect(resultText(screen.container)).toContain("THEIRS\nOURS\nthree"));
  });

  it("keeps an ignored side open as a conflict and restores it on undo", async () => {
    await using screen = await renderView();
    const counter = screen.getByTestId("merge-counter");
    await page.getByRole("button", { name: "Ignore ours for change 1" }).click();
    // Ignoring one side leaves the other still to decide, and the text unchanged.
    await expect.element(counter).toHaveTextContent("2 changes · 1 conflict");
    await expect
      .element(page.getByRole("button", { name: "Ignore ours for change 1" }))
      .not.toBeInTheDocument();
    expect(resultText(screen.container)).toContain("two");
    const line = shadowOf(screen.container, 1)?.querySelector<HTMLElement>(
      "[data-line][data-line-index='0']",
    );
    await userEvent.click(line!);
    await userEvent.keyboard("{Control>}z{/Control}");
    await expect
      .element(page.getByRole("button", { name: "Ignore ours for change 1" }))
      .toBeVisible();
  });
});
