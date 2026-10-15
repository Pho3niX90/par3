import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each(["par3://", "par3:///", "par3-dev://", "par3-preview://", "t3code://", "t3code-dev://"])(
    "ignores scheme-only URL %s",
    (url) => {
      expect(shouldHandleAppLink(url)).toBe(false);
    },
  );

  it.each([
    "par3://threads/env-1/thread-1",
    "par3://pair?pairingUrl=x",
    "par3-dev://settings/usage?tab=limits",
    "t3code://threads/env-1/thread-1",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(true);
  });

  it.each(["par3://expo-development-client/?url=x", "par3://expo-sharing/anything"])(
    "ignores lifecycle URL %s",
    (url) => {
      expect(shouldHandleAppLink(url)).toBe(false);
    },
  );
});
