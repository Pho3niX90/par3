import { afterEach, describe, expect, it, vi } from "vite-plus/test";

interface ObserveMocks {
  readonly configure: ReturnType<typeof vi.fn>;
  readonly dispatchEvents: ReturnType<typeof vi.fn>;
  readonly loadStarted: Promise<void>;
  readonly resolvePreferences: (value: { readonly crashReportsEnabled?: boolean }) => void;
  readonly rejectPreferences: (error: unknown) => void;
}

async function loadObserveModule(options: {
  readonly relayUrl?: string;
  readonly appVariant?: string;
}) {
  vi.resetModules();
  vi.stubGlobal("__DEV__", true);
  const configure = vi.fn();
  const dispatchEvents = vi.fn(async () => undefined);
  let resolveLoadStarted!: () => void;
  const loadStarted = new Promise<void>((resolve) => {
    resolveLoadStarted = resolve;
  });
  let resolvePreferences!: (value: { readonly crashReportsEnabled?: boolean }) => void;
  let rejectPreferences!: (error: unknown) => void;
  const pending = new Promise<{ readonly crashReportsEnabled?: boolean }>((resolve, reject) => {
    resolvePreferences = resolve;
    rejectPreferences = reject;
  });

  vi.doMock("expo-constants", () => ({
    default: {
      expoConfig: {
        extra: {
          ...(options.relayUrl === undefined ? {} : { relay: { url: options.relayUrl } }),
          ...(options.appVariant === undefined ? {} : { appVariant: options.appVariant }),
        },
      },
    },
  }));
  vi.doMock("expo-observe", () => ({
    Observe: {
      configure,
      dispatchEvents,
      reportError: vi.fn(),
    },
  }));
  vi.doMock("../../persistence/imperative", () => ({
    loadPreferences: () => {
      resolveLoadStarted();
      return pending;
    },
  }));

  const mod = await import("./observe");
  return {
    mod,
    mocks: {
      configure,
      dispatchEvents,
      loadStarted,
      resolvePreferences,
      rejectPreferences,
    } satisfies ObserveMocks,
  };
}

const flushMicrotasks = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await Promise.resolve();
  }
};

afterEach(() => {
  vi.doUnmock("expo-constants");
  vi.doUnmock("expo-observe");
  vi.doUnmock("../../persistence/imperative");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("observe crash reporting startup", () => {
  it("configures Observe off synchronously at module load and enables without purging when saved opt-in loads", async () => {
    const { mod, mocks } = await loadObserveModule({
      relayUrl: "https://relay.example.test",
      appVariant: "production",
    });

    expect(mocks.configure).toHaveBeenCalledTimes(1);
    expect(mocks.configure).toHaveBeenLastCalledWith({
      dispatchingEnabled: false,
      environment: "production",
    });
    expect(mocks.dispatchEvents).not.toHaveBeenCalled();

    await mocks.loadStarted;
    mocks.resolvePreferences({ crashReportsEnabled: true });
    await flushMicrotasks();

    expect(mocks.dispatchEvents).not.toHaveBeenCalled();
    expect(mocks.configure).toHaveBeenCalledTimes(2);
    expect(mocks.configure).toHaveBeenLastCalledWith({
      dispatchingEnabled: true,
      environment: "production",
    });

    // User toggling on from Settings still purges queued events first.
    await mod.setCrashReportsEnabled(true);
    expect(mocks.dispatchEvents).toHaveBeenCalledTimes(1);
    expect(mocks.configure).toHaveBeenCalledTimes(3);
  });

  it("stays off when saved choice is unset or fails to load, and does not override an earlier user toggle", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const unset = await loadObserveModule({ relayUrl: "https://relay.example.test" });
    await unset.mocks.loadStarted;
    unset.mocks.resolvePreferences({});
    await flushMicrotasks();
    expect(unset.mocks.configure).toHaveBeenCalledTimes(1);
    expect(unset.mocks.configure).toHaveBeenLastCalledWith({ dispatchingEnabled: false });

    const failed = await loadObserveModule({ relayUrl: "https://relay.example.test" });
    await failed.mocks.loadStarted;
    failed.mocks.rejectPreferences(new Error("storage unavailable"));
    await flushMicrotasks();
    expect(failed.mocks.configure).toHaveBeenCalledTimes(1);
    expect(failed.mocks.configure).toHaveBeenLastCalledWith({ dispatchingEnabled: false });
    expect(warn).toHaveBeenCalledTimes(1);

    const toggledEarly = await loadObserveModule({ relayUrl: "https://relay.example.test" });
    await toggledEarly.mocks.loadStarted;
    await toggledEarly.mod.setCrashReportsEnabled(false);
    toggledEarly.mocks.resolvePreferences({ crashReportsEnabled: true });
    await flushMicrotasks();
    expect(toggledEarly.mocks.configure).toHaveBeenLastCalledWith({ dispatchingEnabled: false });
  });
});
