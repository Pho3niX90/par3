import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, vaultReference } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";

/** Inserts `vault:NAME` for a secret in the vault of the environment being edited. */
export function VaultSecretPicker(props: {
  readonly environmentId: EnvironmentId | null | undefined;
  readonly disabled?: boolean;
  readonly onPick: (reference: string) => void;
}) {
  const environmentId = props.environmentId ?? null;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canRead = useAtomValue(serverEnvironment.vaultMutate.permissionAtom(environmentId));
  if (environmentId === null || config?.environment.capabilities.vault !== true || !canRead) {
    return null;
  }
  return <VaultSecretMenu {...props} environmentId={environmentId} />;
}

function VaultSecretMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled?: boolean;
  readonly onPick: (reference: string) => void;
}) {
  // The list loads when the menu opens, so a form with many rows costs no requests.
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const openVaultSettings = () => void navigate({ to: "/settings/sync" });
  const list = useEnvironmentQuery(
    open ? serverEnvironment.vaultList({ environmentId: props.environmentId, input: {} }) : null,
  );
  const entries = list.data?.entries ?? [];
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost-muted"
            disabled={props.disabled}
            aria-label="Use vault secret"
          />
        }
      >
        <KeyRoundIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Use vault secret</MenuGroupLabel>
          {list.data === null ? (
            list.error ? (
              <MenuItem disabled>{list.error}</MenuItem>
            ) : (
              <MenuItem disabled>
                <Spinner size="xs" /> Loading…
              </MenuItem>
            )
          ) : !list.data.status.member ? (
            <MenuItem onClick={openVaultSettings}>Set up the vault…</MenuItem>
          ) : entries.length === 0 ? (
            <MenuItem onClick={openVaultSettings}>Add a secret to the vault…</MenuItem>
          ) : (
            entries.map((entry) => (
              <MenuItem key={entry.name} onClick={() => props.onPick(vaultReference(entry.name))}>
                <span className="font-mono">{entry.name}</span>
              </MenuItem>
            ))
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
