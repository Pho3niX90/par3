/**
 * Providers often surface their raw HTTP error body as the failure message.
 * When it is a JSON object with a string `error.message`, return that message;
 * otherwise return the input unchanged. Callers keep the raw text for tooltips.
 */
export function getReadableProviderErrorMessage(error: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(error);
  } catch {
    return error;
  }
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return error;
  }
  const nestedError = payload.error;
  if (typeof nestedError !== "object" || nestedError === null || !("message" in nestedError)) {
    return error;
  }
  return typeof nestedError.message === "string" && nestedError.message.trim().length > 0
    ? nestedError.message
    : error;
}
