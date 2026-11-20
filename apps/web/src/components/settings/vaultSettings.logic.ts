import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

const VAULT_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why a secret name can't be used, or null; mirrors the contract so the form explains it. */
export function vaultSecretNameError(
  raw: string,
  existingNames: ReadonlyArray<string>,
  resolve: MessageResolver = m,
): string | null {
  const name = raw.trim();
  if (name === "") return resolve(msg("Enter a name."));
  if (name.length > 128) return resolve(msg("Use at most 128 characters."));
  if (!VAULT_SECRET_NAME_PATTERN.test(name)) {
    return resolve(msg("Use letters, digits, and underscores, not starting with a digit."));
  }
  if (existingNames.includes(name))
    return resolve(msg("{name} is already in the vault.", { name }));
  return null;
}
