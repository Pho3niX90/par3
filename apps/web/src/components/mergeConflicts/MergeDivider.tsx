import { ChevronsLeftIcon, ChevronsRightIcon, EllipsisIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MERGE_DIVIDER_WIDTH } from "./mergeViewController";
import {
  chunkActionAvailability,
  type ChunkAction,
  type MergeChunk,
  type MergeSide,
} from "./mergeModel";
import { toneColor, type Connector } from "./mergePresentation";

/**
 * The strip between two panes: connector shapes for the regions in view, and the buttons that
 * act on them. The left strip acts on "ours", the right on "theirs". The shapes are drawn from
 * positions the controller computes once per animation frame; nothing here animates.
 */
export function MergeDivider(props: {
  readonly side: MergeSide;
  readonly connectors: ReadonlyArray<Connector>;
  readonly viewportHeight: number;
  readonly chunks: ReadonlyArray<MergeChunk>;
  readonly disabled: boolean;
  readonly onAction: (chunkId: number, action: ChunkAction) => void;
}) {
  const { side } = props;
  const label = side === "ours" ? "ours" : "theirs";
  const AcceptIcon = side === "ours" ? ChevronsRightIcon : ChevronsLeftIcon;
  return (
    <div
      className="relative shrink-0 overflow-hidden"
      style={{ width: MERGE_DIVIDER_WIDTH }}
      data-merge-divider={side}
    >
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0"
        width={MERGE_DIVIDER_WIDTH}
        height={props.viewportHeight}
      >
        {props.connectors.map((connector) => (
          <path
            key={connector.chunkId}
            d={connector.path}
            style={{
              fill: `color-mix(in srgb, ${toneColor(connector.tone)} 14%, transparent)`,
              stroke: `color-mix(in srgb, ${toneColor(connector.tone)} 55%, transparent)`,
              strokeWidth: 1,
            }}
          />
        ))}
      </svg>
      {props.connectors.map((connector) => {
        const chunk = props.chunks[connector.chunkId];
        if (chunk === undefined) return null;
        const available = chunkActionAvailability(chunk);
        const canAccept = side === "ours" ? available.acceptOurs : available.acceptTheirs;
        const canIgnore = side === "ours" ? available.ignoreOurs : available.ignoreTheirs;
        const canBoth = side === "ours" && available.acceptBoth;
        if (!canAccept && !canIgnore && !canBoth) return null;
        return (
          <div
            key={connector.chunkId}
            className="absolute inset-x-0 flex items-center justify-center gap-0.5"
            style={{ top: connector.buttonY }}
            data-merge-chunk-actions={connector.chunkId}
          >
            {canAccept ? (
              <Button
                size="icon-micro"
                variant="outline"
                aria-label={`Accept ${label} for change ${connector.chunkId + 1}`}
                disabled={props.disabled}
                onClick={() => props.onAction(connector.chunkId, { type: "accept", side })}
              >
                <AcceptIcon />
              </Button>
            ) : null}
            {canIgnore ? (
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={`Ignore ${label} for change ${connector.chunkId + 1}`}
                disabled={props.disabled}
                onClick={() => props.onAction(connector.chunkId, { type: "ignore", side })}
              >
                <XIcon />
              </Button>
            ) : null}
            {canBoth ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-micro"
                      variant="ghost-muted"
                      aria-label={`More ways to resolve change ${connector.chunkId + 1}`}
                      disabled={props.disabled}
                    />
                  }
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="start">
                  <MenuItem
                    onClick={() =>
                      props.onAction(connector.chunkId, { type: "acceptBoth", order: "ours-first" })
                    }
                  >
                    Accept both, ours first
                  </MenuItem>
                  <MenuItem
                    onClick={() =>
                      props.onAction(connector.chunkId, {
                        type: "acceptBoth",
                        order: "theirs-first",
                      })
                    }
                  >
                    Accept both, theirs first
                  </MenuItem>
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
