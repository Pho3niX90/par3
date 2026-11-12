import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

import {
  formatHostedThreadLink,
  formatThreadLink,
  guessThreadLinkRef,
  hasThreadLinks,
  hostedThreadLink,
  parseThreadLinkHref,
  relabelThreadLinks,
  threadLinkCandidates,
  threadLinkRefs,
} from "./threadLinks.ts";

const ref = (environmentId: string, threadId = "chat-1") => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});
const v1 = (threadId: string) => ({ environmentId: null, threadId: ThreadId.make(threadId) });
const local = EnvironmentId.make("local");
const titlesIn =
  (titles: Record<string, Record<string, string>>) =>
  ({ environmentId, threadId }: ScopedThreadRef) =>
    titles[environmentId]?.[threadId];

describe("thread link destinations", () => {
  it("names a v1 link's thread in the message's environment, as written and then decoded", () => {
    expect(threadLinkCandidates(v1("provider%3A1"), local)).toEqual([
      ref("local", "provider%3A1"),
      ref("local", "provider:1"),
    ]);
  });

  it("opens the unique matching chat in another environment for a v1 link", () => {
    const destination = ref("remote");
    expect(guessThreadLinkRef(v1("chat-1"), [ref("local", "other-chat"), destination])).toEqual(
      destination,
    );
  });

  it("opens a v2 link only in its own environment", () => {
    const there = ref("there", "a%3A1");
    expect(threadLinkCandidates(there, local)).toEqual([there, ref("there", "a:1")]);
    expect(guessThreadLinkRef(there, [ref("elsewhere", "a%3A1"), ref("elsewhere", "a:1")])).toBe(
      null,
    );
  });

  it("leaves ambiguous or missing destinations unresolved", () => {
    const link = v1("provider%3A1");
    const literal = ref("remote", "provider%3A1");
    const decoded = ref("remote", "provider:1");
    expect(
      guessThreadLinkRef(link, [literal, ref("other-remote", literal.threadId), decoded]),
    ).toBeNull();
    expect(guessThreadLinkRef(link, [decoded, ref("other-remote", decoded.threadId)])).toBeNull();
    expect(guessThreadLinkRef(link, [ref("remote", "other-chat")])).toBeNull();
  });
});

describe("thread links", () => {
  it.each(["par3-thread", "t3-thread"])("takes %s ids verbatim, percent escapes included", (s) => {
    expect(parseThreadLinkHref(`${s}://v1/mcp:1234`)).toEqual(v1("mcp:1234"));
    expect(parseThreadLinkHref(`${s}://v1/thread:delegated-task:mcp%3A1`)).toEqual(
      v1("thread:delegated-task:mcp%3A1"),
    );
    expect(hasThreadLinks(`See <${s}://v2/env-1/t1>`)).toBe(true);
    expect(parseThreadLinkHref(`${s}://v2/env-1/thread:a/b%3A1`)).toEqual(
      ref("env-1", "thread:a/b%3A1"),
    );
  });

  it.each(["par3-thread", "t3-thread"])("rejects other links and an empty %s id", (s) => {
    expect(hasThreadLinks(`${s}:// and https://t3.codes`)).toBe(false);
    expect(parseThreadLinkHref("https://t3.codes")).toBeNull();
    expect(parseThreadLinkHref(`${s}://v1/`)).toBeNull();
    expect(parseThreadLinkHref(`${s}://v1/ `)).toBeNull();
    expect(parseThreadLinkHref(`${s}://v2/env-1`)).toBeNull();
    expect(parseThreadLinkHref(`${s}://v2/env-1/`)).toBeNull();
    expect(parseThreadLinkHref(`${s}://v2//chat-1`)).toBeNull();
  });

  it("resolves a percent-encoded id when the id as written names no thread", () => {
    const title = titlesIn({ local: { "thread:project:1": "Decoded", "provider%3A1": "Literal" } });
    expect(
      relabelThreadLinks(
        "[a](par3-thread://v1/thread%3Aproject%3A1) [b](par3-thread://v1/provider%3A1)",
        local,
        title,
      ),
    ).toBe("[Decoded](par3-thread://v1/thread:project:1) [Literal](par3-thread://v1/provider%3A1)");
    const untitled = titlesIn({ local: { "a%3A1": "", "a:1": "Other" } });
    expect(relabelThreadLinks("[Kept](par3-thread://v1/a%3A1)", local, untitled)).toBe(
      "[Kept](par3-thread://v1/a%3A1)",
    );
  });

  it("titles a v2 link from its own environment and writes it with that title", () => {
    const title = titlesIn({ local: { t1: "Here" }, there: { t1: "There" } });
    expect(
      relabelThreadLinks(
        "<par3-thread://v2/there/t1> and [old](par3-thread://v2/local/t1)",
        local,
        title,
      ),
    ).toBe("[There](par3-thread://v2/there/t1) and [Here](par3-thread://v2/local/t1)");
  });

  it("reads an angle-bracketed destination as the labeled link, not an autolink", () => {
    const title = titlesIn({ local: { t1: "Here" }, there: { t1: "There" } });
    expect(
      relabelThreadLinks(
        "[old](<t3-thread://v2/there/t1>) and [older](<t3-thread://v2/local/t1>)",
        local,
        title,
      ),
    ).toBe("[There](par3-thread://v2/there/t1) and [Here](par3-thread://v2/local/t1)");
    expect(
      relabelThreadLinks("[Kept label](<t3-thread://v2/local/t1>)", local, () => undefined),
    ).toBe("Kept label");
    expect(threadLinkRefs("[a](<t3-thread://v2/there/t2>)", local)).toEqual([ref("there", "t2")]);
    for (const threadId of ["mcp:launch:qa(1)", "mcp:launch:qa)"]) {
      const thread = ref("there", threadId);
      const link = formatThreadLink(thread, "Original");
      expect(link).toBe(`[Original](<par3-thread://v2/there/${threadId}>)`);
      expect(threadLinkRefs(link, local)).toEqual([thread]);
      expect(relabelThreadLinks(link, local, () => "Renamed")).toBe(
        `[Renamed](<par3-thread://v2/there/${threadId}>)`,
      );
      expect(relabelThreadLinks(link, local, () => undefined)).toBe("Original");
    }
  });

  it("turns a v2 link it cannot resolve into plain text, never the raw link", () => {
    expect(
      relabelThreadLinks(
        "<par3-thread://v2/there/t1>, <par3-thread://v2/local/t1>, [Old title](par3-thread://v2/there/t1)",
        local,
        () => undefined,
      ),
    ).toBe("Thread on another machine, Thread no longer available, Old title");
    expect(relabelThreadLinks("[Old](par3-thread://v1/t1)", local, () => undefined)).toBe(
      "[Old](par3-thread://v1/t1)",
    );
  });

  it.each(["par3-thread", "t3-thread"])("leaves %s links inside code as written", (s) => {
    const markdown = [
      `Live [old](${s}://v1/t1), literal \`[old](${s}://v1/t1)\`.`,
      "```md",
      `<${s}://v2/local/t1>`,
      "```",
      `After <${s}://v2/local/t1>`,
    ].join("\n");
    expect(relabelThreadLinks(markdown, local, () => "New")).toBe(
      [
        `Live [New](par3-thread://v1/t1), literal \`[old](${s}://v1/t1)\`.`,
        "```md",
        `<${s}://v2/local/t1>`,
        "```",
        "After [New](par3-thread://v2/local/t1)",
      ].join("\n"),
    );
  });

  it.each(["par3-thread", "t3-thread"])(
    "lists the threads %s links can name, outside code",
    (s) => {
      expect(
        threadLinkRefs(`<${s}://v2/there/t1> [a](${s}://v1/t%3A2) \`<${s}://v2/code/t3>\``, local),
      ).toEqual([ref("there", "t1"), ref("local", "t%3A2"), ref("local", "t:2")]);
    },
  );

  it("lists a message's thread links on runtimes whose matchAll omits named groups, such as Hermes", () => {
    const matchAll = String.prototype.matchAll;
    using _hermes = vi.spyOn(String.prototype, "matchAll").mockImplementation(function (
      this: string,
      regexp: RegExp,
    ) {
      return matchAll.call(this, regexp).map((match) => {
        delete match.groups;
        return match;
      });
    });
    expect(
      threadLinkRefs("<par3-thread://v2/local/t1> [a](par3-thread://v2/there/t2)", local),
    ).toEqual([ref("local", "t1"), ref("there", "t2")]);
  });

  it("writes a titleless autolink that opens that exact thread", () => {
    const link = formatThreadLink(ref("env-1", "thread:delegated-task:mcp%3A1"));
    expect(link).toBe("<par3-thread://v2/env-1/thread:delegated-task:mcp%3A1>");
    expect(formatThreadLink(v1("t1"))).toBe("<par3-thread://v1/t1>");
    expect(parseThreadLinkHref(link.slice(1, -1))).toEqual(
      ref("env-1", "thread:delegated-task:mcp%3A1"),
    );
  });

  it("formats a label that would otherwise break the Markdown link", () => {
    expect(formatThreadLink(ref("e", "t1"), "Fix [ci] \\ build")).toBe(
      "[Fix ci build](par3-thread://v2/e/t1)",
    );
    expect(formatThreadLink(ref("e", "t1"), " ] ")).toBe("<par3-thread://v2/e/t1>");
  });
});

describe("hosted thread links", () => {
  it("escapes every id character a sentence or path could claim, and reads it back", () => {
    const thread = ref("env.1", "thread:delegated/mcp%3A1.");
    const link = hostedThreadLink(thread);
    expect(link).toBe(
      "https://app.paritylabs.co.za/threads/env%2E1/thread%3Adelegated%2Fmcp%253A1%2E",
    );
    expect(parseThreadLinkHref(link)).toEqual(thread);
    expect(hostedThreadLink(thread, "https://preview.t3.codes/")).toMatch(
      /^https:\/\/preview\.t3\.codes\/threads\//,
    );
  });

  it("reads only a bare thread path on the hosted app", () => {
    expect(parseThreadLinkHref("https://app.paritylabs.co.za/threads/env-1/thread-1")).toEqual(
      ref("env-1", "thread-1"),
    );
    expect(
      parseThreadLinkHref("https://app.paritylabs.co.za/threads/env-1/thread-1?prompt=go"),
    ).toBeNull();
    expect(
      parseThreadLinkHref("https://app.paritylabs.co.za/threads/env-1/thread-1/extra"),
    ).toBeNull();
    expect(parseThreadLinkHref("https://app.paritylabs.co.za/threads/env-1")).toBeNull();
    expect(parseThreadLinkHref("https://app.paritylabs.co.za/env-1/thread-1")).toBeNull();
    expect(parseThreadLinkHref("https://evil.test/threads/env-1/thread-1")).toBeNull();
  });

  it("writes a copied link a reader can follow, labeled when it has a title", () => {
    expect(formatHostedThreadLink(ref("e", "t1"), "Fix [ci]")).toBe(
      "[Fix ci](https://app.paritylabs.co.za/threads/e/t1)",
    );
    expect(formatHostedThreadLink(ref("e", "t1"), " ")).toBe(
      "https://app.paritylabs.co.za/threads/e/t1",
    );
  });

  it("titles hosted links in every Markdown form and writes them as v2 links", () => {
    const title = titlesIn({ there: { t1: "There" } });
    expect(
      relabelThreadLinks(
        [
          "See https://app.paritylabs.co.za/threads/there/t1.",
          "[old](https://app.paritylabs.co.za/threads/there/t1)",
          "<https://app.paritylabs.co.za/threads/there/t1>",
          "`https://app.paritylabs.co.za/threads/there/t1`",
          "https://app.paritylabs.co.za/threads/there/t1?prompt=go",
        ].join("\n"),
        local,
        title,
      ),
    ).toBe(
      [
        "See [There](par3-thread://v2/there/t1).",
        "[There](par3-thread://v2/there/t1)",
        "[There](par3-thread://v2/there/t1)",
        "`https://app.paritylabs.co.za/threads/there/t1`",
        "https://app.paritylabs.co.za/threads/there/t1?prompt=go",
      ].join("\n"),
    );
    expect(
      relabelThreadLinks("https://app.paritylabs.co.za/threads/there/t1", local, () => undefined),
    ).toBe("Thread on another machine");
    expect(threadLinkRefs("Open https://app.paritylabs.co.za/threads/there/t%3A1", local)).toEqual([
      ref("there", "t:1"),
    ]);
  });
});
