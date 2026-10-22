import type { ComposerMode, SpecChoice } from "@t3tools/shared/specComposer";
import { BotIcon, FileTextIcon, PencilRulerIcon } from "lucide-react";
import { type ComponentType, memo, type SVGProps } from "react";

import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

/** What the Build / Plan / Spec choice shows and does, shared by the strip and the compact menu. */
export interface ComposerModeControlModel {
  readonly mode: ComposerMode;
  readonly showPlan: boolean;
  readonly spec: SpecChoice;
  readonly planShortcutLabel: string | null;
  readonly specShortcutLabel: string | null;
  readonly onSelectMode: (mode: ComposerMode) => void;
  /** Binds the thread to a spec that exists, or opens the project's specs for a draft. */
  readonly onUseExistingSpec: (() => void) | null;
  readonly useExistingSpecLabel: string;
}

export function composerModeControlVisible(model: ComposerModeControlModel): boolean {
  return model.showPlan || model.spec.kind !== "hidden";
}

export const COMPOSER_MODE_LABELS: Record<ComposerMode, string> = {
  build: "Build",
  plan: "Plan",
  spec: "Spec",
};

const MODE_ICONS: Record<ComposerMode, ComponentType<SVGProps<SVGSVGElement>>> = {
  build: BotIcon,
  plan: PencilRulerIcon,
  spec: FileTextIcon,
};

const USE_EXISTING_SPEC = "use-existing-spec";

const MODE_DESCRIPTIONS: Record<ComposerMode, string> = {
  build: "The agent makes the change.",
  plan: "The agent proposes a plan first.",
  spec: "The agent drafts a spec for review first.",
};

export const ComposerModeControl = memo(function ComposerModeControl(props: {
  model: ComposerModeControlModel;
  size?: "sm" | "xs";
  hidden?: boolean;
}) {
  const { model } = props;
  const size = props.size ?? "sm";
  const floatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const modes: ComposerMode[] = [
    "build",
    ...(model.showPlan ? (["plan"] as const) : []),
    ...(model.spec.kind === "hidden" ? [] : (["spec"] as const)),
  ];
  const Icon = MODE_ICONS[model.mode];
  const shortcuts = [
    model.planShortcutLabel && model.showPlan ? `${model.planShortcutLabel} toggles Plan` : null,
    model.specShortcutLabel && model.spec.kind === "available"
      ? `${model.specShortcutLabel} toggles Spec`
      : null,
  ].filter((entry) => entry !== null);

  return (
    <Tooltip>
      <Select
        open={open}
        onOpenChange={setOpen}
        value={model.mode}
        onValueChange={(value: string | null) => {
          if (value === USE_EXISTING_SPEC) model.onUseExistingSpec?.();
          else if (value && value !== model.mode) model.onSelectMode(value as ComposerMode);
        }}
      >
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size={size}
              aria-label="Build, Plan or Spec"
              data-mode-active={model.mode === "build" ? undefined : ""}
              className="data-mode-active:bg-accent data-mode-active:text-accent-foreground"
            />
          }
        >
          <ComposerControlIcon icon={Icon} size={size} />
          <SelectValue data-composer-control-label>{COMPOSER_MODE_LABELS[model.mode]}</SelectValue>
        </TooltipTrigger>
        <SelectPopup alignItemWithTrigger={false} {...floatingLayerProps}>
          {modes.map((mode) => {
            const OptionIcon = MODE_ICONS[mode];
            const refusal = mode === "spec" && model.spec.kind === "disabled" ? model.spec : null;
            return (
              <SelectItem
                key={mode}
                value={mode}
                hideIndicator
                disabled={refusal !== null}
                className="min-w-64"
              >
                <div className="grid min-w-0 gap-0.5">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    {COMPOSER_MODE_LABELS[mode]}
                  </span>
                  <span className="text-muted-foreground text-xs leading-4">
                    {refusal?.reason ?? MODE_DESCRIPTIONS[mode]}
                  </span>
                </div>
              </SelectItem>
            );
          })}
          {model.spec.kind !== "hidden" && model.onUseExistingSpec ? (
            <SelectItem value={USE_EXISTING_SPEC} hideIndicator className="min-w-64">
              <span className="text-foreground">{model.useExistingSpecLabel}</span>
            </SelectItem>
          ) : null}
        </SelectPopup>
      </Select>
      <TooltipPopup side="top">
        {[`${COMPOSER_MODE_LABELS[model.mode]} mode`, ...shortcuts].join(" · ")}
      </TooltipPopup>
    </Tooltip>
  );
});
