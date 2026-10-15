import type { ProviderDriverKind } from "@t3tools/contracts";
import { modelVendorIcon } from "@t3tools/provider-core/client";

import { cn } from "~/lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { ProviderPackageIcon } from "./ProviderPackageIcon";

/**
 * The model's vendor glyph for drivers that route to several vendors, such as
 * Copilot. Renders nothing for other drivers and for slugs without a vendor.
 */
export function ModelVendorIcon(props: {
  driverKind: ProviderDriverKind | null | undefined;
  model: string;
  className?: string;
}) {
  const icon = modelVendorIcon(providerClients.get(props.driverKind ?? undefined), props.model);
  if (!icon) return null;
  return (
    <ProviderPackageIcon
      icon={icon}
      className={cn("size-3 shrink-0", props.className)}
      aria-hidden
    />
  );
}
