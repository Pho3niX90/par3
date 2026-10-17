// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side benchmark browser driver.
/**
 * Arm C: the Par3 web app served by a bench server, driven in Chromium the
 * way a user drives it. The clock starts at Enter in the composer; the turn is
 * done at the first animation frame after the chat column's `data-run-status`
 * turns terminal. Both times come from the page's own clock.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Page } from "playwright-core";

import { repositoryRoot } from "../lib/liveServer.ts";
import type { ArmRunInput, TurnSample } from "./benchTypes.ts";
import { readNativeResults, startBenchServer } from "./serverArm.ts";
import { apiTimesFromTranscript, findTranscriptIn } from "./terminalArm.ts";

const TURN_TIMEOUT_MS = 10 * 60_000;
const TERMINAL = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

/** Builds the web client when `apps/web/dist` is missing; the server serves it as static files. */
export function ensureWebBuild(): void {
  if (NodeFS.existsSync(NodePath.join(repositoryRoot, "apps/web/dist/index.html"))) return;
  console.log("Building the web client (apps/web/dist is missing)...");
  NodeChildProcess.execSync("vp run --filter @t3tools/web build", {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
}

/**
 * Runs in the page before any app code. Records Enter in the composer, every
 * `data-run-status` change and assistant text paint, each at the next frame.
 */
const PAGE_RECORDER = `(() => {
  try {
    localStorage.setItem("t3code:client-settings:v1", JSON.stringify({ onboardingCompletedAt: "2026-01-01T00:00:00.000Z" }));
  } catch {}
  const bench = { sends: [], statuses: [], texts: [] };
  window.__bench = bench;
  const atFrame = (record) => requestAnimationFrame(() => record(performance.now()));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && event.target instanceof Element && event.target.closest('[data-testid="composer-editor"]')) {
      bench.sends.push(performance.now());
    }
  }, true);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.attributeName === "data-run-status") {
        const status = mutation.target.getAttribute("data-run-status");
        atFrame((at) => bench.statuses.push({ status, at }));
        continue;
      }
      const node = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      const message = node?.closest?.('[data-message-role="assistant"]');
      if (message && message.textContent.trim().length > 0) atFrame((at) => bench.texts.push(at));
    }
  });
  const start = () => observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-run-status"] });
  if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start);
})();`;

interface PageRecord {
  readonly sends: number[];
  readonly statuses: Array<{ status: string; at: number }>;
  readonly texts: number[];
}

export async function runAppArm(
  input: ArmRunInput & {
    readonly claudeBinaryPath: string;
    readonly serverEnv: NodeJS.ProcessEnv;
    readonly headless: boolean;
  },
): Promise<TurnSample[]> {
  const { chromium } = await import("playwright-core");
  const bench = await startBenchServer(input);
  const prompts = [
    input.workload.prompt,
    ...(input.workload.warmPrompt ? [input.workload.warmPrompt] : []),
  ];
  const turns: Array<{ wallMs: number; firstTextMs?: number; lastTextMs?: number }> = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const pairing = await fetch(`${bench.origin}/api/auth/pairing-token`, {
      method: "POST",
      headers: bench.headers,
      body: JSON.stringify({ label: "Provider benchmark" }),
    });
    if (!pairing.ok) throw new Error(`Pairing token failed: ${pairing.status}`);
    const { credential } = (await pairing.json()) as { credential: string };

    // A system Chrome or Edge, so nothing is downloaded.
    for (const channel of ["chrome", "msedge"]) {
      try {
        browser = await chromium.launch({ channel, headless: input.headless });
        break;
      } catch {}
    }
    if (browser === undefined) throw new Error("No system Chrome or Edge found for the app arm");
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(PAGE_RECORDER);
    const page = await context.newPage();
    await page.goto(`${bench.origin}/pair#${new URLSearchParams([["token", credential]])}`);
    await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 60_000 });
    const editor = page.locator('[data-testid="composer-editor"]').first();
    await editor.waitFor({ state: "visible", timeout: 60_000 });

    for (const [index, prompt] of prompts.entries()) {
      await editor.click();
      await page.keyboard.insertText(prompt);
      await page.keyboard.press("Enter");
      const record = await waitForTerminal(page, index);
      const sentAt = record.sends[index];
      if (sentAt === undefined) throw new Error("Enter was not recorded in the composer");
      // Terminal after a non-terminal status seen since this send.
      const afterSend = record.statuses.filter((entry) => entry.at >= sentAt);
      const runningIndex = afterSend.findIndex((entry) => !TERMINAL.has(entry.status));
      const done = afterSend.slice(runningIndex + 1).find((entry) => TERMINAL.has(entry.status))!;
      const texts = record.texts.filter((at) => at >= sentAt && at <= done.at);
      turns.push({
        wallMs: done.at - sentAt,
        ...(texts.length === 0
          ? {}
          : { firstTextMs: texts[0]! - sentAt, lastTextMs: texts.at(-1)! - sentAt }),
      });
    }
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    await page
      ?.screenshot({ path: NodePath.join(input.runDir, "app-failure.png") })
      .catch(() => undefined);
    throw error;
  } finally {
    await browser?.close();
    await bench.stop();
  }

  // API time from the CLI's own transcript, the same source as the terminal arm.
  const sessionId = readNativeResults(bench.home, undefined).find(
    (result) => result.sessionId,
  )?.sessionId;
  const transcript =
    sessionId === undefined ? undefined : findTranscriptIn(input.config.claudeConfigDir, sessionId);
  const apiTimes = transcript === undefined ? [] : apiTimesFromTranscript(transcript);
  return turns.map((turn, index): TurnSample => {
    const apiMs = apiTimes[index];
    return {
      arm: "C",
      workload: input.workload.id,
      variant: input.variant,
      repetition: input.repetition,
      turn: index === 0 ? "cold" : "warm",
      wallMs: turn.wallMs,
      ...(apiMs === undefined ? {} : { apiMs, nonApiMs: turn.wallMs - apiMs }),
      ...(turn.firstTextMs === undefined ? {} : { firstTextMs: turn.firstTextMs }),
      ...(turn.lastTextMs === undefined ? {} : { lastTextMs: turn.lastTextMs }),
    };
  });
}

async function waitForTerminal(page: Page, turnIndex: number): Promise<PageRecord> {
  const deadline = performance.now() + TURN_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const record = await page.evaluate(
      () => (globalThis as unknown as { __bench: PageRecord }).__bench,
    );
    const sentAt = record.sends[turnIndex];
    if (sentAt !== undefined) {
      const afterSend = record.statuses.filter((entry) => entry.at >= sentAt);
      const runningIndex = afterSend.findIndex((entry) => !TERMINAL.has(entry.status));
      if (
        runningIndex >= 0 &&
        afterSend.slice(runningIndex + 1).some((entry) => TERMINAL.has(entry.status))
      ) {
        return record;
      }
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`App turn ${turnIndex} timed out`);
}
