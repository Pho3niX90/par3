import type { RuntimeMode } from "@t3tools/contracts";
import type { ComposerMode } from "@t3tools/shared/specComposer";
import { memo, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import {
  COMPOSER_MODE_LABELS,
  type ComposerModeControlModel,
  composerModeControlVisible,
} from "./ComposerModeControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  modeControl: ComposerModeControlModel;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<{
    readonly mode: RuntimeMode;
    readonly label: string;
  }>;
  /** The mode choice has no room in the strip, so it moves into this menu. */
  showModeChoice: boolean;
  traitsMenuContent?: ReactNode;
  sidekickMenuContent?: ReactNode;
  size?: "sm" | "xs";
  /**
   * The resting strip keeps this menu mounted out of flow while every block
   * fits inline. Its portaled popup would outlive that transition, so an
   * open menu closes when its trigger hides.
   */
  hidden?: boolean;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            className="shrink-0"
            aria-label="More composer controls"
            data-composer-shortcut={[
              "composer.mode",
              ...(props.traitsMenuContent ? ["composer.effort"] : []),
              ...(props.sidekickMenuContent ? ["composer.sidekick"] : []),
            ].join(" ")}
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showModeChoice && composerModeControlVisible(props.modeControl) ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.modeControl.mode}
              onValueChange={(value) => {
                if (!value || value === props.modeControl.mode) return;
                props.modeControl.onSelectMode(value as ComposerMode);
              }}
            >
              <MenuRadioItem value="build">{COMPOSER_MODE_LABELS.build}</MenuRadioItem>
              {props.modeControl.showPlan ? (
                <MenuRadioItem value="plan">{COMPOSER_MODE_LABELS.plan}</MenuRadioItem>
              ) : null}
              {props.modeControl.spec.kind === "hidden" ? null : (
                <MenuRadioItem value="spec" disabled={props.modeControl.spec.kind === "disabled"}>
                  <span className="grid gap-0.5">
                    {COMPOSER_MODE_LABELS.spec}
                    {props.modeControl.spec.kind === "disabled" ? (
                      <span className="text-muted-foreground text-xs">
                        {props.modeControl.spec.reason}
                      </span>
                    ) : null}
                  </span>
                </MenuRadioItem>
              )}
            </MenuRadioGroup>
            {props.modeControl.spec.kind !== "hidden" && props.modeControl.onUseExistingSpec ? (
              <MenuItem onClick={props.modeControl.onUseExistingSpec}>
                {props.modeControl.useExistingSpecLabel}
              </MenuItem>
            ) : null}
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          {props.runtimeModeOptions.map((option) => (
            <MenuRadioItem key={option.mode} value={option.mode}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {props.sidekickMenuContent ? (
          <>
            <MenuDivider />
            {props.sidekickMenuContent}
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
