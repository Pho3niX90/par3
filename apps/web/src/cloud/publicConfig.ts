import {
  clerkFrontendApiHostnameFromPublishableKey,
  relayClerkTokenOptions,
} from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";

import { isHostedStaticApp } from "../hostedPairing";

export class CloudPublicConfigMissingError extends Schema.TaggedError<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("T3CODE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    clerkPublishableKey: trimNonEmpty(
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined,
    ),
    clerkJwtTemplate: trimNonEmpty(import.meta.env.VITE_CLERK_JWT_TEMPLATE as string | undefined),
    relayUrl: normalizeSecureRelayUrl(
      (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ?? "",
    ),
    relayTracing: {
      tracesUrl: normalizeSecureUrl(
        (import.meta.env.VITE_RELAY_OTLP_TRACES_URL as string | undefined) ?? "",
      ),
      tracesDataset: trimNonEmpty(
        import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET as string | undefined,
      ),
      tracesToken: trimNonEmpty(import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN as string | undefined),
    },
  };
}

let desktopRelayTelemetry: boolean | null = null;
let serverRelayTelemetry: boolean | null = null;
let hostedRelayDiagnosticsEnabled = false;

export function setServerRelayTelemetry(allowed: boolean | null): void {
  serverRelayTelemetry = allowed;
}

export function setHostedRelayDiagnosticsEnabled(enabled: boolean): void {
  hostedRelayDiagnosticsEnabled = enabled;
}

export function relayTelemetryEnabled(): boolean | null {
  if (typeof window === "undefined") return true;
  if (window.desktopBridge) {
    desktopRelayTelemetry ??= window.desktopBridge.getRelayTelemetryEnabled();
    if (desktopRelayTelemetry === false || serverRelayTelemetry === false) return false;
    return desktopRelayTelemetry === true && serverRelayTelemetry === true ? true : null;
  }
  if (isHostedStaticApp()) {
    return hostedRelayDiagnosticsEnabled;
  }
  return serverRelayTelemetry;
}

function configuredRelayTracing() {
  const { relayTracing } = resolveCloudPublicConfig();
  return relayTracing.tracesUrl && relayTracing.tracesDataset && relayTracing.tracesToken
    ? {
        tracesUrl: relayTracing.tracesUrl,
        tracesDataset: relayTracing.tracesDataset,
        tracesToken: relayTracing.tracesToken,
      }
    : null;
}

export function hasRelayTracingConfig(): boolean {
  return configuredRelayTracing() !== null;
}

export function resolveRelayTracingConfig() {
  // Only a permanent desktop main-process veto can skip creating the exporter at startup;
  // server and hosted settings can be turned on live without reloading.
  if (typeof window !== "undefined" && window.desktopBridge) {
    desktopRelayTelemetry ??= window.desktopBridge.getRelayTelemetryEnabled();
    if (desktopRelayTelemetry === false) {
      return null;
    }
  }
  return configuredRelayTracing();
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  if (!config.clerkPublishableKey || !config.clerkJwtTemplate || !config.relayUrl) {
    return false;
  }

  // Electron has its own auth runtime; development keys also support private browser origins.
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !config.clerkPublishableKey.startsWith("pk_live_")
  ) {
    return true;
  }

  try {
    // Custom Frontend API hosts use clerk.<production domain>.
    const domain = clerkFrontendApiHostnameFromPublishableKey(config.clerkPublishableKey).replace(
      /^clerk\./u,
      "",
    );
    const { hostname, protocol, port } = window.location;
    return (
      protocol === "https:" &&
      port === "" &&
      (hostname === domain || hostname.endsWith(`.${domain}`))
    );
  } catch {
    return false;
  }
}

export function resolveRelayClerkTokenOptions() {
  const { clerkJwtTemplate } = resolveCloudPublicConfig();
  if (!clerkJwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(clerkJwtTemplate);
}
