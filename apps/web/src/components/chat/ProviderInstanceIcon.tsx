import { type CSSProperties, memo } from "react";

import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";

import { ProviderDriverKind } from "@t3tools/contracts";
import { modelVendorIcon } from "@t3tools/provider-core/client";
import { AntigravityIcon, ClaudeAI, Icon, OpenAI } from "../Icons";

import { cn } from "~/lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { ProviderPackageIcon } from "./ProviderPackageIcon";
import {
  AcpRegistryAgentIcon,
  officialAcpRegistryIconUrlForAgentId,
  resolveOfficialAcpRegistryIconUrl,
} from "../settings/AcpRegistryIcon";

const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
};

const PROVIDER_TEXT_COLOR_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "text-black dark:text-white",
  [ProviderDriverKind.make("claudeAgent")]: "text-[#d97757]",
  [ProviderDriverKind.make("antigravity")]: "text-[#5b87bf]",
};

export function providerTextColor(driverKind: ProviderDriverKind): {
  readonly className?: string;
  readonly style?: CSSProperties;
} {
  const icon = providerClients.get(driverKind)?.icon;
  if (icon) {
    return {
      className: "text-(--icon-light) dark:text-(--icon-dark)",
      style: { "--icon-light": icon.fill.light, "--icon-dark": icon.fill.dark } as CSSProperties,
    };
  }
  const className = PROVIDER_TEXT_COLOR_BY_PROVIDER[driverKind];
  return className ? { className } : {};
}

export function resolveProviderInstanceAcpRegistryIconUrl(input: {
  readonly driverKind: ProviderDriverKind;
  readonly agentId?: string | undefined;
  readonly iconUrl?: string | undefined;
}): string | null {
  if (input.driverKind !== "acpRegistry") return null;
  return (
    resolveOfficialAcpRegistryIconUrl(input.iconUrl ?? null) ??
    officialAcpRegistryIconUrlForAgentId(input.agentId?.trim() || null)
  );
}

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  /**
   * Selected model slug. Drivers that route to several vendors draw that
   * vendor's glyph and move their own glyph into the corner badge, unless
   * `showBadge` claims the corner to tell instances apart.
   */
  model?: string | undefined;
  /** Set false where a corner badge would crowd the glyph, such as stacked selections. */
  showDriverBadge?: boolean;
  accentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  showBadge?: boolean;
  badgeContent?: "initials" | "none";
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  statusDotClassName?: string;
  indicatorBackground?: string;
}) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const definition = providerClients.get(props.driverKind);
  const packageIcon = definition?.icon;
  const vendorIcon = modelVendorIcon(definition, props.model);
  const showDriverBadge =
    props.showDriverBadge !== false && vendorIcon !== undefined && packageIcon !== undefined;
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";
  const accentStyle = props.accentColor
    ? ({ "--provider-accent": props.accentColor } as CSSProperties)
    : undefined;
  const badgeContent = props.badgeContent ?? "initials";
  const isAcpRegistry = props.driverKind === "acpRegistry";
  const acpRegistryIconUrl = resolveProviderInstanceAcpRegistryIconUrl({
    driverKind: props.driverKind,
    agentId: props.acpRegistryAgentId,
    iconUrl: props.acpRegistryIconUrl,
  });

  return (
    <span
      className={cn(
        "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={accentStyle}
      data-provider-accent-color={props.accentColor}
    >
      {isAcpRegistry ? (
        <AcpRegistryAgentIcon
          className={cn("size-5 rounded-none bg-transparent", props.iconClassName)}
          fallbackClassName="size-full"
          icon={acpRegistryIconUrl}
        />
      ) : vendorIcon ? (
        <ProviderPackageIcon
          icon={vendorIcon}
          className={cn("size-5 shrink-0", props.iconClassName)}
          aria-hidden
        />
      ) : packageIcon ? (
        <ProviderPackageIcon
          icon={packageIcon}
          className={cn("size-5 shrink-0", props.iconClassName)}
          aria-hidden
        />
      ) : Icon ? (
        <Icon className={cn("size-5 shrink-0", props.iconClassName)} aria-hidden />
      ) : (
        <span className={cn("text-3xs font-semibold leading-none", props.iconClassName)}>
          {providerInstanceInitials(props.displayName)}
        </span>
      )}
      {props.statusDotClassName ? (
        <span
          className={cn(
            "pointer-events-none absolute -left-0.5 -top-0.5 z-10 size-2 rounded-full",
            props.statusDotClassName,
          )}
          style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
          aria-hidden
        />
      ) : null}
      {props.showBadge ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border px-0.5 text-4xs font-semibold leading-none shadow-sm",
            props.accentColor
              ? "bg-(--provider-accent) text-white"
              : "bg-card text-muted-foreground",
            props.badgeClassName,
          )}
          style={{ borderColor: indicatorBackground }}
          aria-hidden
        >
          {badgeContent === "initials" ? providerInstanceInitials(props.displayName) : null}
        </span>
      ) : showDriverBadge ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border bg-card px-0.5 shadow-sm",
            props.badgeClassName,
          )}
          style={{ borderColor: indicatorBackground }}
          aria-hidden
        >
          <ProviderPackageIcon icon={packageIcon} className="size-2" />
        </span>
      ) : null}
    </span>
  );
});
