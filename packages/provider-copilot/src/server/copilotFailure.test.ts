import { describe, expect, it } from "@effect/vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import { copilotPromptFailure } from "./copilotFailure.ts";

describe("copilotPromptFailure", () => {
  const requestError = (errorMessage: string, code = -32603) =>
    new EffectAcpErrors.AcpRequestError({ code, errorMessage });

  it("classifies rate limit and quota phrases on a request error as usage_limit", () => {
    for (const message of [
      "Rate limit exceeded for model",
      "Too many requests, slow down",
      "Copilot plan quota exceeded",
      "You have no quota remaining",
    ]) {
      const failure = copilotPromptFailure(requestError(message));
      expect(failure.class).toBe("usage_limit");
    }
  });

  it("does not guess at retrying: usage limits are not marked retryable", () => {
    expect(copilotPromptFailure(requestError("Rate limit exceeded")).retryable).toBeNull();
  });

  it("is not fooled by status-like numbers in ids or ports", () => {
    const failure = copilotPromptFailure(
      requestError("Request 1a402b429c failed while talking to localhost:4029"),
    );
    expect(failure.class).toBe("provider_error");
  });

  it("keeps the protocol error code and message", () => {
    const failure = copilotPromptFailure(requestError("Failed to connect to agent", -32000));
    expect(failure.class).toBe("provider_error");
    expect(failure.code).toBe("-32000");
    expect(failure.message).toBe("Failed to connect to agent");
  });

  it("never treats a non-request failure as a usage limit", () => {
    const failure = copilotPromptFailure(new Error("Rate limit exceeded"));
    expect(failure.class).toBe("provider_error");
  });
});
