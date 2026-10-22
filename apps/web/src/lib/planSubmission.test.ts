import { describe, expect, it, vi } from "vite-plus/test";
import { runPlanSubmission } from "./planSubmission";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("plan submissions", () => {
  it("guards the entire upload, rejects a duplicate, and rechecks the active plan", async () => {
    const upload = deferred<string>();
    const guard = { current: false };
    let current = true;
    const send = vi.fn().mockResolvedValue(true);
    const onSuccess = vi.fn();
    const input = {
      guard,
      onBusy: vi.fn(),
      isCurrent: () => current,
      prepare: () => upload.promise,
      send,
      onSuccess,
    };
    const first = runPlanSubmission(input);
    expect(guard.current).toBe(true);
    expect(await runPlanSubmission(input)).toBe(false);
    current = false;
    upload.resolve("images");
    expect(await first).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(guard.current).toBe(false);
    expect(input.onBusy.mock.calls).toEqual([[true], [false]]);
  });
  it("always releases the guard after validation failure, upload failure or send failure", async () => {
    for (const failure of ["validation", "upload", "send"]) {
      const guard = { current: false };
      const result = runPlanSubmission({
        guard,
        onBusy: vi.fn(),
        isCurrent: () => true,
        prepare: async () => {
          if (failure === "upload") throw new Error("upload");
          return failure === "validation" ? null : "image";
        },
        send: async () => {
          throw new Error("send");
        },
        onSuccess: vi.fn(),
      });
      if (failure === "validation") expect(await result).toBe(false);
      else await expect(result).rejects.toThrow(failure);
      expect(guard.current).toBe(false);
    }
  });
});

it("keeps the guard while sending and completes only after success", async () => {
  const guard = { current: false };
  const sent = deferred<boolean>();
  const onSuccess = vi.fn();
  const prepared = { snapshot: "submitted revision" };
  const result = runPlanSubmission({
    guard,
    onBusy: vi.fn(),
    isCurrent: () => true,
    prepare: async () => prepared,
    send: () => {
      expect(guard.current).toBe(true);
      return sent.promise;
    },
    onSuccess,
  });
  expect(onSuccess).not.toHaveBeenCalled();
  sent.resolve(true);
  expect(await result).toBe(true);
  expect(onSuccess).toHaveBeenCalledWith(prepared);
  expect(guard.current).toBe(false);
});
