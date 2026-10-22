import { describe, expect, it } from "vite-plus/test";

import { withSpecIntakeRequest } from "./spec-intake-model";

describe("withSpecIntakeRequest", () => {
  it("requests and withdraws Spec for one composer without touching the others", () => {
    const requested = withSpecIntakeRequest({}, "thread:a", true);
    expect(requested).toEqual({ "thread:a": true });
    const both = withSpecIntakeRequest(requested, "thread:b", true);
    expect(both).toEqual({ "thread:a": true, "thread:b": true });
    expect(withSpecIntakeRequest(both, "thread:a", false)).toEqual({ "thread:b": true });
  });

  it("returns the same object when nothing changes, so subscribers do not re-render", () => {
    const requested = withSpecIntakeRequest({}, "thread:a", true);
    expect(withSpecIntakeRequest(requested, "thread:a", true)).toBe(requested);
    expect(withSpecIntakeRequest(requested, "thread:b", false)).toBe(requested);
  });
});
