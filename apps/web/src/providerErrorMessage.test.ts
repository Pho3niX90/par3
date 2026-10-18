import { describe, expect, it } from "vite-plus/test";

import { getReadableProviderErrorMessage } from "./providerErrorMessage";

describe("getReadableProviderErrorMessage", () => {
  it("shows the message from the reported unsupported-model error", () => {
    const error =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.3-codex\' model is not supported when using Codex with a ChatGPT account."}}';

    expect(getReadableProviderErrorMessage(error)).toBe(
      "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it("shows the message from the reported multiline error", () => {
    const error = `{
  "error": {
    "message": "X-OpenAI-Internal-Codex-Responses-Lite only supports function tools, custom tools, and client-executed tool search.",
    "type": "invalid_request_error",
    "param": "tools",
    "code": "unsupported_value"
  }
}`;

    expect(getReadableProviderErrorMessage(error)).toBe(
      "X-OpenAI-Internal-Codex-Responses-Lite only supports function tools, custom tools, and client-executed tool search.",
    );
  });

  it("preserves whitespace in a recognized message", () => {
    const message = "  First line\n\tSecond line  ";
    const error = ` \n${JSON.stringify({ error: { message } })}\t `;

    expect(getReadableProviderErrorMessage(error)).toBe(message);
  });

  it("does not recursively unwrap a selected message", () => {
    const message = JSON.stringify({ error: { message: "Inner message" } });

    expect(getReadableProviderErrorMessage(JSON.stringify({ error: { message } }))).toBe(message);
  });

  it.each([
    ["plain text and its whitespace", "  Could not start the turn.\nTry again.  "],
    ["empty text", ""],
    ["whitespace-only text", " \n\t "],
    ["invalid JSON", '{"error":{"message":"Cut off"'],
    ["JSON null", "null"],
    ["a JSON string", '"Could not start the turn."'],
    ["a JSON number", "400"],
    ["an array", '[{"error":{"message":"Array entry"}}]'],
    ["a top-level message", '{"message":"Top-level message"}'],
    ["an unknown object", '{"status":400,"code":"unsupported_value"}'],
    ["a null error", '{"error":null}'],
    ["a string-valued error", '{"error":"Could not start the turn."}'],
    ["an array-valued error", '{"error":[{"message":"Array entry"}]}'],
    ["an absent message", '{"error":{"code":"unsupported_value"}}'],
    ["an empty message", '{"error":{"message":""}}'],
    ["a whitespace-only message", JSON.stringify({ error: { message: " \n\t " } })],
    ["a non-string message", '{"error":{"message":400}}'],
    ["a deeper error object", '{"error":{"error":{"message":"Deeper message"}}}'],
    ["double-encoded JSON", JSON.stringify('{"error":{"message":"Encoded message"}}')],
  ])("leaves %s unchanged", (_description, error) => {
    expect(getReadableProviderErrorMessage(error)).toBe(error);
  });
});
