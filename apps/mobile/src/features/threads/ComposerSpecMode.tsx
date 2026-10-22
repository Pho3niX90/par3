import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";

/** Shown while the next message will start a spec; the composer has no other mode indicator. */
export function ComposerSpecModeBanner(props: {
  readonly disabled: boolean;
  readonly onTurnOff: () => void;
}) {
  return (
    <View className="flex-row items-center gap-2 px-4 pb-2" testID="composer-spec-mode">
      <SymbolView name="doc.text" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={2}>
        Spec mode: your message starts a new spec
      </Text>
      <Button
        label="Turn off"
        tone="text"
        accessibilityLabel="Turn off Spec mode"
        disabled={props.disabled}
        onPress={props.onTurnOff}
      />
    </View>
  );
}
