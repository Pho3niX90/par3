import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { CircleAlertIcon, UsersIcon } from "lucide-react";
import { memo } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  SIDEKICK_PER_REQUEST_HINT,
  sidekickOptionGroups,
  sidekickOptionKey,
  type SidekickPairing,
} from "../../sidekick";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  ComposerControlSeparator,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { useComposerMenuState } from "./useComposerMenuState";
import { TraitsMenuContent, shouldRenderTraitsControls } from "./TraitsPicker";

const NONE_VALUE = "none";

export interface SidekickMenuInput {
  readonly pairing: SidekickPairing | null;
  readonly lead: Pick<ModelSelection, "instanceId" | "model">;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<
    ProviderInstanceId,
    ReadonlyArray<{ slug: string; name: string; isUnavailable?: boolean | undefined }>
  >;
  readonly onChange: (selection: ModelSelection | null) => void;
}

function sidekickTriggerTooltip(pairing: SidekickPairing | null): string {
  if (pairing === null) return "Sidekick off. Delegated tasks use the lead's model.";
  if (pairing.problem !== null) return `Sidekick inactive: ${pairing.problem}`;
  return pairing.perRequest
    ? `Sidekick on: ${pairing.label}. ${SIDEKICK_PER_REQUEST_HINT}`
    : `Sidekick on: ${pairing.label}`;
}

function sidekickStatusLabel(pairing: SidekickPairing | null): string {
  if (pairing === null) return "Off";
  return pairing.problem === null ? "On" : "Inactive";
}

/**
 * Menu body shared by the composer control and the overflow menu. It mounts
 * only while its menu is open, so the eligible models are derived then rather
 * than on every composer render.
 */
export function SidekickMenuContent(props: SidekickMenuInput) {
  const groups = sidekickOptionGroups({
    entries: props.entries,
    modelOptionsByInstance: props.modelOptionsByInstance,
    lead: props.lead,
  });
  const selectedKey = props.pairing ? sidekickOptionKey(props.pairing.selection) : NONE_VALUE;
  const selection = props.pairing?.selection;
  const selectedProvider = props.entries.find(
    (entry) => entry.instanceId === selection?.instanceId,
  );
  return (
    <>
      <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-xs">
        <span className="font-medium text-muted-foreground">Sidekick</span>
        <span className={props.pairing?.problem ? "text-warning" : "text-muted-foreground"}>
          {sidekickStatusLabel(props.pairing)}
        </span>
      </div>
      {props.pairing?.problem ? (
        <div className="flex max-w-72 items-start gap-1.5 px-2 pb-1.5 text-warning text-xs">
          <CircleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>
            {props.pairing.label} is inactive. {props.pairing.problem}
          </span>
        </div>
      ) : null}
      <MenuRadioGroup
        value={selectedKey}
        onValueChange={(value) => {
          if (value === NONE_VALUE && selectedKey !== NONE_VALUE) props.onChange(null);
        }}
      >
        <MenuRadioItem value={NONE_VALUE}>Off</MenuRadioItem>
      </MenuRadioGroup>
      {groups.length > 0 ? <MenuSeparator /> : null}
      {groups.map((group) => {
        const selectedOption = group.options.find(
          (option) => sidekickOptionKey(option) === selectedKey,
        );
        return (
          <MenuSub key={group.entry.instanceId}>
            <MenuSubTrigger>
              <ProviderInstanceIcon
                driverKind={group.entry.driverKind}
                displayName={group.entry.displayName}
                accentColor={group.entry.accentColor}
                acpRegistryAgentId={group.entry.acpRegistryAgentId}
                acpRegistryIconUrl={group.entry.acpRegistryIconUrl}
                size="compact"
              />
              {group.entry.displayName}
              {selectedOption ? (
                <span className="ms-auto max-w-32 truncate text-muted-foreground text-xs">
                  {selectedOption.name}
                </span>
              ) : null}
            </MenuSubTrigger>
            <MenuSubPopup>
              {group.perRequest ? (
                <div className="max-w-64 px-2 py-1.5 text-muted-foreground text-xs">
                  {SIDEKICK_PER_REQUEST_HINT}
                </div>
              ) : null}
              <MenuRadioGroup
                value={selectedKey}
                onValueChange={(value) => {
                  const option = group.options.find(
                    (candidate) => sidekickOptionKey(candidate) === value,
                  );
                  if (option && value !== selectedKey) {
                    props.onChange({ instanceId: option.instanceId, model: option.model });
                  }
                }}
              >
                {group.options.map((option) => (
                  <MenuRadioItem key={option.model} value={sidekickOptionKey(option)}>
                    {option.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
        );
      })}
      {selection &&
      selectedProvider &&
      shouldRenderTraitsControls({
        provider: selectedProvider.driverKind,
        models: selectedProvider.models,
        model: selection.model,
        modelOptions: selection.options,
        prompt: "",
        allowPromptInjectedEffort: false,
        planModeEnabled: false,
      }) ? (
        <>
          <MenuSeparator />
          <MenuSub>
            <MenuSubTrigger>Sidekick options</MenuSubTrigger>
            <MenuSubPopup>
              <TraitsMenuContent
                provider={selectedProvider.driverKind}
                instanceId={selection.instanceId}
                models={selectedProvider.models}
                model={selection.model}
                modelOptions={selection.options}
                prompt=""
                onPromptChange={() => {}}
                allowPromptInjectedEffort={false}
                planModeEnabled={false}
                onModelOptionsChange={(options) =>
                  props.onChange({ ...selection, options: options ?? [] })
                }
              />
            </MenuSubPopup>
          </MenuSub>
        </>
      ) : null}
    </>
  );
}

export const ComposerSidekickControl = memo(function ComposerSidekickControl(
  props: SidekickMenuInput & {
    size?: "sm" | "xs";
    hidden?: boolean;
  },
) {
  const size = props.size ?? "sm";
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const inactive = props.pairing?.problem != null;
  const active = props.pairing !== null && !inactive;
  const tooltip = sidekickTriggerTooltip(props.pairing);
  return (
    <>
      <ComposerControlSeparator size={size} />
      <Menu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <ComposerControl
                    size={size}
                    className="shrink-0 whitespace-nowrap"
                    aria-pressed={active}
                    aria-label="Sidekick"
                    aria-description={tooltip}
                    data-composer-shortcut="composer.sidekick"
                  />
                }
              />
            }
          >
            <ComposerControlIcon
              icon={inactive ? CircleAlertIcon : UsersIcon}
              size={size}
              {...(inactive ? { className: "text-warning" } : {})}
            />
            <span data-composer-control-label className="max-w-40 truncate">
              {props.pairing ? props.pairing.label : "Sidekick"}
            </span>
            <ComposerControlChevron size={size} />
          </TooltipTrigger>
          <TooltipPopup side="top">{tooltip}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="start" {...composerFloatingLayerProps}>
          <SidekickMenuContent {...props} />
        </MenuPopup>
      </Menu>
    </>
  );
});
