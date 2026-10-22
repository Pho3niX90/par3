import { describe, expect, it } from "@effect/vitest";

import type { UsageRecord } from "@t3tools/provider-core/server/usage";

import { copilotUsageFormat } from "./usage.ts";

const SESSION_ID = "4f1d2c6e-8a0b-4c7e-9f3a-2b5d6e7f8a90";
const SOURCE_SESSION_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

function usageRecord(overrides?: {
  id?: string;
  timestamp?: string;
  usage?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    type: "session.usage_record",
    id: overrides?.id ?? "evt-usage-1",
    timestamp: overrides?.timestamp ?? "2026-10-20T09:15:02.418Z",
    parentId: "evt-turn-1",
    data: {
      usage: {
        model: "claude-opus-5.5",
        inputTokens: 44_673,
        outputTokens: 107,
        cacheReadTokens: 43_748,
        cacheWriteTokens: 923,
        reasoningTokens: 125,
        isByok: false,
        apiCallId: "msg_01AbCdEf",
        accounting: { sourceSessionId: SOURCE_SESSION_ID, sequence: 2, usageId: "msg_01AbCdEf" },
        copilotUsage: { tokenDetails: [], totalNanoAiu: 15_000_000_000 },
        cost: 15,
        ...overrides?.usage,
      },
    },
  });
}

// Copilot CLI 1.0.102 events.jsonl layout. The non-usage lines only need to be ignored.
const TRANSCRIPT = [
  JSON.stringify({
    type: "session.start",
    id: "evt-start",
    timestamp: "2026-10-20T09:14:51.002Z",
    data: { sessionId: SESSION_ID, copilotVersion: "1.0.102", cwd: "/work/project" },
  }),
  JSON.stringify({
    type: "user.message",
    id: "evt-user-1",
    timestamp: "2026-10-20T09:14:58.110Z",
    data: { content: "<redacted>" },
  }),
  usageRecord(),
  JSON.stringify({
    type: "assistant.message",
    id: "evt-assistant-1",
    timestamp: "2026-10-20T09:15:03.001Z",
    data: { content: "<redacted>" },
  }),
].join("\n");

function scan(lines: string): UsageRecord[] {
  const state = copilotUsageFormat.state!.initial();
  return lines.split("\n").flatMap((line) => copilotUsageFormat.parseLine(line, state));
}

describe("copilotUsageFormat", () => {
  it("reads a stripped transcript captured from Copilot CLI 1.0.102", () => {
    // Only usage fields remain; session and request identifiers are replaced.
    const transcript = [
      { type: "session.start", data: { sessionId: "session-live-fixture" } },
      {
        type: "session.usage_record",
        id: "event-live-fixture",
        timestamp: "2026-10-22T15:19:58.201Z",
        data: {
          usage: {
            model: "mai-code-1.1-flash",
            inputTokens: 12_222,
            outputTokens: 5,
            cacheReadTokens: 1_152,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            isByok: false,
            cost: 1,
            apiCallId: "api-live-fixture",
            accounting: {
              sourceSessionId: "session-live-fixture",
              sequence: 1,
              usageId: "usage-live-fixture",
            },
          },
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");

    expect(scan(transcript)).toEqual([
      {
        provider: "copilot",
        timestampMs: Date.parse("2026-10-22T15:19:58.201Z"),
        model: "mai-code-1.1-flash",
        rateModel: "mai-code-1.1-flash",
        sessionId: "session-live-fixture",
        totals: {
          uncachedInputTokens: 11_070,
          cachedInputTokens: 1_152,
          cacheCreationTokens: 0,
          outputTokens: 5,
          reasoningTokens: 0,
        },
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: JSON.stringify(["copilot", "usage-live-fixture"]),
      },
    ]);
  });

  it("separates cache reads and writes out of Copilot's input count", () => {
    const records = scan(TRANSCRIPT);

    expect(records).toEqual([
      {
        provider: "copilot",
        timestampMs: Date.parse("2026-10-20T09:15:02.418Z"),
        model: "claude-opus-5.5",
        rateModel: "claude-opus-5.5",
        sessionId: SOURCE_SESSION_ID,
        totals: {
          uncachedInputTokens: 2,
          cachedInputTokens: 43_748,
          cacheCreationTokens: 923,
          outputTokens: 107,
          reasoningTokens: 107,
        },
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: JSON.stringify(["copilot", "msg_01AbCdEf"]),
      },
    ]);
  });

  it("falls back to the session.start id when accounting has no source session", () => {
    const records = scan(
      [TRANSCRIPT.split("\n")[0], usageRecord({ usage: { accounting: undefined } })].join("\n"),
    );

    expect(records.map((record) => record.sessionId)).toEqual([SESSION_ID]);
  });

  it("keeps BYOK records and prices non-Claude models under their own id", () => {
    const [record] = scan(usageRecord({ usage: { model: "gpt-5.4", isByok: true } }));

    expect(record?.model).toBe("gpt-5.4");
    expect(record?.rateModel).toBe("gpt-5.4");
  });

  it("gives a re-logged record the same dedupe key", () => {
    const records = scan(
      [
        usageRecord(),
        usageRecord({ id: "evt-usage-copy", timestamp: "2026-10-21T00:00:00Z" }),
      ].join("\n"),
    );

    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record.dedupeKey)).size).toBe(1);
  });

  it("falls back from usageId to apiCallId to the event id for the dedupe key", () => {
    const [byApiCall] = scan(usageRecord({ usage: { accounting: undefined } }));
    const [byEvent] = scan(usageRecord({ usage: { accounting: undefined, apiCallId: undefined } }));

    expect(byApiCall?.dedupeKey).toBe(JSON.stringify(["copilot", "msg_01AbCdEf"]));
    expect(byEvent?.dedupeKey).toBe(JSON.stringify(["copilot", "evt-usage-1"]));
  });

  it("treats missing token fields as zero and never reports negative input", () => {
    const [record] = scan(
      usageRecord({
        usage: { inputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: undefined },
      }),
    );

    expect(record?.totals).toEqual({
      uncachedInputTokens: 0,
      cachedInputTokens: 50,
      cacheCreationTokens: 0,
      outputTokens: 107,
      reasoningTokens: 107,
    });
  });

  it("skips zero-token, malformed, and model-less lines without throwing", () => {
    const records = scan(
      [
        "{not json",
        usageRecord({
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
        usageRecord({ usage: { model: undefined } }),
        usageRecord({ timestamp: "not a date" }),
        JSON.stringify({ type: "session.usage_record", data: null }),
      ].join("\n"),
    );

    expect(records).toEqual([]);
  });

  it("returns nothing for a session without usage records", () => {
    const transcript = TRANSCRIPT.split("\n")
      .filter((line) => !line.includes("session.usage_record"))
      .join("\n");

    expect(scan(transcript)).toEqual([]);
  });

  it("parses the streamed projection the same as a whole line", () => {
    const state = copilotUsageFormat.state!.initial();

    expect(copilotUsageFormat.parseProjected(JSON.parse(usageRecord()), state)).toEqual(
      scan(usageRecord()),
    );
  });
});
