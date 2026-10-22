import { parseVaultReference } from "@t3tools/contracts";

import { DraftInput, type DraftInputProps } from "../ui/draft-input";
import { Input, type InputProps } from "../ui/input";

type SecretInputProps = Omit<InputProps, "type" | "autoComplete" | "defaultValue" | "value"> & {
  /** Pass only the replacement draft as `value`. */
  readonly configured?: boolean;
  readonly value: string;
  readonly onCommit?: DraftInputProps["onCommit"];
};

export function SecretInput({
  configured = false,
  placeholder,
  onCommit,
  ...props
}: SecretInputProps) {
  const shared = {
    ...props,
    // A `vault:NAME` reference is not itself secret, and hiding it hides which secret is used.
    type: parseVaultReference(props.value) === null ? ("password" as const) : ("text" as const),
    autoComplete: "off",
    spellCheck: false,
    placeholder: configured
      ? "Stored secret, enter a new value to replace"
      : (placeholder ?? "Not set"),
  };
  if (onCommit) {
    return (
      <DraftInput
        {...shared}
        onCommit={(next) => {
          if (configured && next === "") return;
          onCommit(next);
        }}
      />
    );
  }
  return <Input {...shared} />;
}
