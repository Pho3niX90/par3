import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getOnboardingProviderState,
  resolveOnboardingProviderLoginCommand,
  selectOnboardingProvidersByDriver,
} from "./providerReadiness.logic";
import { onboardingProviderOffersOptionalSignIn } from "./providerReadiness.logic";
import { resolveOnboardingProviderInstallCommand } from "./providerReadiness.logic";

const readyCodex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getOnboardingProviderState", () => {
  it("treats an enabled Codex provider with ready status and unknown authentication as ready", () => {
    expect(getOnboardingProviderState(readyCodex)).toBe("ready");
  });

  it("treats authenticated providers as ready only when their provider status is ready", () => {
    expect(getOnboardingProviderState({ ...readyCodex, auth: { status: "authenticated" } })).toBe(
      "ready",
    );
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        auth: { status: "authenticated" },
        status: "error",
      }),
    ).toBe("attention");
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        auth: { status: "authenticated" },
        status: "warning",
      }),
    ).toBe("attention");
  });

  it("offers sign-in only when the server reports an authentication failure", () => {
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        status: "error",
        auth: { status: "unauthenticated" },
      }),
    ).toBe("signIn");
    expect(getOnboardingProviderState({ ...readyCodex, status: "error" })).toBe("attention");
    expect(getOnboardingProviderState({ ...readyCodex, status: "warning" })).toBe("attention");
  });

  it("does not offer installation or sign-in for disabled providers", () => {
    expect(getOnboardingProviderState({ ...readyCodex, enabled: false, installed: false })).toBe(
      "disabled",
    );
    expect(getOnboardingProviderState({ ...readyCodex, status: "disabled" })).toBe("disabled");
  });

  it("offers installation only when an enabled provider is missing", () => {
    expect(getOnboardingProviderState({ ...readyCodex, installed: false, status: "error" })).toBe(
      "install",
    );
  });
});

describe("selectOnboardingProvidersByDriver", () => {
  it("prefers a ready instance with unknown authentication to an unauthenticated instance", () => {
    const signedOutCodex: ServerProvider = {
      ...readyCodex,
      instanceId: ProviderInstanceId.make("codex_work"),
      status: "error",
      auth: { status: "unauthenticated" },
    };

    expect(selectOnboardingProvidersByDriver([signedOutCodex, readyCodex]).get("codex")).toBe(
      readyCodex,
    );
  });

  it("prefers a provider with an actionable sign-in over a failed provider", () => {
    const failedCodex: ServerProvider = { ...readyCodex, status: "error" };
    const signedOutCodex: ServerProvider = {
      ...readyCodex,
      instanceId: ProviderInstanceId.make("codex_work"),
      status: "error",
      auth: { status: "unauthenticated" },
    };

    expect(selectOnboardingProvidersByDriver([failedCodex, signedOutCodex]).get("codex")).toBe(
      signedOutCodex,
    );
  });

  it("prefers installed providers over missing or disabled instances", () => {
    const disabledCodex: ServerProvider = { ...readyCodex, enabled: false };
    const missingCodex: ServerProvider = {
      ...readyCodex,
      instanceId: ProviderInstanceId.make("codex_work"),
      installed: false,
      status: "error",
    };

    expect(
      selectOnboardingProvidersByDriver([disabledCodex, missingCodex, readyCodex]).get("codex"),
    ).toBe(readyCodex);
  });
});

describe("resolveOnboardingProviderLoginCommand", () => {
  it("uses the selected Codex account binary", () => {
    const provider = { ...readyCodex, instanceId: ProviderInstanceId.make("codex_work") };

    expect(
      resolveOnboardingProviderLoginCommand(
        provider,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [provider.instanceId]: {
              driver: provider.driver,
              config: { binaryPath: "/opt/codex-work/bin/codex" },
            },
          },
        },
        "linux",
      ),
    ).toBe("/opt/codex-work/bin/codex login");
  });

  it("uses the selected Claude account binary", () => {
    const provider: ServerProvider = {
      ...readyCodex,
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claude_work"),
    };

    expect(
      resolveOnboardingProviderLoginCommand(
        provider,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [provider.instanceId]: {
              driver: provider.driver,
              config: { binaryPath: "/opt/claude-work/bin/claude" },
            },
          },
        },
        "linux",
      ),
    ).toBe("/opt/claude-work/bin/claude auth login");
  });

  it("quotes a Codex path with spaces for PowerShell", () => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                binaryPath: "C:\\Program Files\\Codex & Tools\\codex.exe",
              },
            },
          },
        },
        "windows",
      ),
    ).toBe("& 'C:\\Program Files\\Codex & Tools\\codex.exe' login");
  });

  it("quotes a Claude path with shell metacharacters on POSIX", () => {
    const provider: ServerProvider = {
      ...readyCodex,
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claude"),
    };

    expect(
      resolveOnboardingProviderLoginCommand(
        provider,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("claude")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: {
                binaryPath: "/opt/Claude Tools/$current/claude",
              },
            },
          },
        },
        "linux",
      ),
    ).toBe("'/opt/Claude Tools/$current/claude' auth login");
  });

  it.each([
    ["~/my tools/codex", "~/'my tools/codex' login"],
    ["~\\my tools/codex", "~/'my tools/codex' login"],
    ["~/tools/codex's build", `~/'tools/codex'"'"'s build' login`],
    ["~\\tools\\codex's build", `~/'tools\\codex'"'"'s build' login`],
    ["~/tools/codex; echo unsafe", "~/'tools/codex; echo unsafe' login"],
  ])("keeps the home prefix expandable while quoting %s", (binaryPath, expectedCommand) => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                binaryPath,
              },
            },
          },
        },
        "linux",
      ),
    ).toBe(expectedCommand);
  });

  it.each(["darwin", "linux"] as const)("quotes backslashes in a Codex path on %s", (platform) => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                binaryPath: "/opt/codex\\work/codex",
              },
            },
          },
        },
        platform,
      ),
    ).toBe("'/opt/codex\\work/codex' login");
  });

  it("uses the default command when an old server reports an unknown shell", () => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                binaryPath: "/opt/Codex Tools/codex",
              },
            },
          },
        },
        "unknown",
      ),
    ).toBe("codex login");
  });
});
describe("GitHub Copilot onboarding", () => {
  const copilot: ServerProvider = {
    ...readyCodex,
    instanceId: ProviderInstanceId.make("copilot"),
    driver: ProviderDriverKind.make("copilot"),
  };
  const settingsFor = (config: Record<string, unknown>) => ({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [copilot.instanceId]: { driver: copilot.driver, config },
    },
  });

  it("installs the CLI through npm on every platform", () => {
    for (const platform of ["windows", "darwin", "linux", "unknown"] as const) {
      expect(resolveOnboardingProviderInstallCommand("copilot", platform)).toBe(
        "npm install -g @github/copilot",
      );
    }
  });

  it("logs in to GitHub.com with the default binary", () => {
    expect(resolveOnboardingProviderLoginCommand(copilot, settingsFor({}), "linux")).toBe(
      "copilot login",
    );
  });

  it("logs in to the configured enterprise host with the configured binary", () => {
    expect(
      resolveOnboardingProviderLoginCommand(
        copilot,
        settingsFor({
          binaryPath: "/opt/copilot/bin/copilot",
          enterpriseUrl: " https://company.ghe.com ",
        }),
        "linux",
      ),
    ).toBe("/opt/copilot/bin/copilot login --host https://company.ghe.com");
  });

  it("drops an enterprise host that would need shell quoting", () => {
    expect(
      resolveOnboardingProviderLoginCommand(
        copilot,
        settingsFor({ enterpriseUrl: "company.ghe.com; rm -rf ~" }),
        "linux",
      ),
    ).toBe("copilot login");
  });

  it("offers sign-in beside a working CLI because its login cannot be read", () => {
    expect(onboardingProviderOffersOptionalSignIn(copilot)).toBe(true);
    expect(onboardingProviderOffersOptionalSignIn({ ...copilot, installed: false })).toBe(false);
    expect(
      onboardingProviderOffersOptionalSignIn({ ...copilot, auth: { status: "authenticated" } }),
    ).toBe(false);
    expect(onboardingProviderOffersOptionalSignIn(readyCodex)).toBe(false);
    expect(onboardingProviderOffersOptionalSignIn(undefined)).toBe(false);
  });
});
