import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { CopilotSettings } from "../settings.ts";

const CopilotScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
const NonEmpty = Schema.optional(Schema.NonEmptyString);
const Entry = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("session.start"),
    data: Schema.Struct({ sessionId: Schema.NonEmptyString }),
  }),
  Schema.Struct({
    type: Schema.Literal("session.usage_record"),
    id: NonEmpty,
    timestamp: Schema.String,
    data: Schema.Struct({
      usage: Schema.Struct({
        model: Schema.NonEmptyString,
        inputTokens: Schema.optional(Schema.Unknown),
        outputTokens: Schema.optional(Schema.Unknown),
        cacheReadTokens: Schema.optional(Schema.Unknown),
        cacheWriteTokens: Schema.optional(Schema.Unknown),
        reasoningTokens: Schema.optional(Schema.Unknown),
        apiCallId: NonEmpty,
        accounting: Schema.optional(
          Schema.Struct({ sourceSessionId: NonEmpty, usageId: NonEmpty }),
        ),
      }),
    }),
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(parsed: unknown, state: typeof CopilotScanState.Type): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "session.start") {
    state.sessionId = entry.data.sessionId;
    return [];
  }
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const usage = entry.data.usage;
  const cachedInputTokens = tokenCount(usage.cacheReadTokens);
  const cacheCreationTokens = tokenCount(usage.cacheWriteTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const totals = {
    // Copilot's inputTokens includes both cache reads and cache writes.
    uncachedInputTokens: Math.max(
      0,
      tokenCount(usage.inputTokens) - cachedInputTokens - cacheCreationTokens,
    ),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens)),
  };
  if (totalTokens(totals) === 0) return [];
  const usageId = usage.accounting?.usageId ?? usage.apiCallId ?? entry.id;
  return [
    {
      provider: "copilot",
      timestampMs,
      model: usage.model,
      rateModel: usage.model,
      sessionId: usage.accounting?.sourceSessionId ?? state.sessionId,
      totals,
      // `cost` and `copilotUsage.totalNanoAiu` are Copilot billing units, not
      // USD, so leave cost to shared pricing.
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: usageId === undefined ? null : JSON.stringify(["copilot", usageId]),
    },
  ];
}

export const copilotUsageFormat: TranscriptUsageFormat<typeof CopilotScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    data: {
      sessionId: true,
      usage: {
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        reasoningTokens: true,
        apiCallId: true,
        accounting: { sourceSessionId: true, usageId: true },
      },
    },
  },
  usageMarkers: ['"session.usage_record"', '"session.start"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "" }), schema: CopilotScanState },
};

export const copilotUsageReader: ProviderUsageReader<CopilotSettings, Path.Path> = {
  kind: "transcripts",
  provider: "copilot",
  format: copilotUsageFormat,
  directories: Effect.fn("copilotUsageReader.directories")(function* ({ environment }) {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    // The CLI uses COPILOT_HOME in place of ~/.copilot.
    const copilotHome = environment.COPILOT_HOME?.trim();
    const root = copilotHome ? expandHomePath(copilotHome, home) : path.join(home, ".copilot");
    return [{ dir: path.resolve(root, "session-state"), fileName: "events.jsonl" }];
  }),
};
