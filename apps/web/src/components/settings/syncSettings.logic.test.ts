import type { SyncEnvironmentView } from "@t3tools/client-runtime/sync/plan";
import { EnvironmentId, type SyncSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { peerSyncCategories, summarizeSyncJoin } from "./syncSettings.logic";

const PEER = EnvironmentId.make("peer");
const NEW = EnvironmentId.make("new");

function snapshot(
  items: Record<string, string>,
  options: { readonly categories?: ReadonlyArray<string> | null; readonly agreed?: boolean } = {},
): SyncSnapshot {
  return {
    participation:
      options.categories === null
        ? null
        : {
            enabled: true,
            categories: [...(options.categories ?? ["claude.agents", "codex.prompts"])],
            excluded: [],
            decidedAt: "2026-10-21T00:00:00.000Z",
          },
    categories: [
      { id: "claude.agents", label: "Claude agents", available: true },
      { id: "codex.prompts", label: "Codex prompts", available: true },
      { id: "vault", label: "Vault secrets", available: false },
    ],
    items: Object.entries(items).map(([key, hash]) => ({
      key,
      categoryId: key.slice(0, key.indexOf(":")),
      name: key.slice(key.indexOf(":") + 1),
      hash,
      byteLength: 1,
    })),
    baselines: options.agreed
      ? Object.fromEntries(Object.entries(items).map(([key, hash]) => [key, { hash, rev: 1 }]))
      : {},
    seq: 1,
  };
}

const view = (environmentId: EnvironmentId, value: SyncSnapshot): SyncEnvironmentView => ({
  environmentId,
  snapshot: value,
});

describe("summarizeSyncJoin", () => {
  it("counts what a joining machine receives, shares, and disagrees on per category", () => {
    const peers = [
      view(
        PEER,
        snapshot(
          { "claude.agents:a.md": "h1", "claude.agents:b.md": "h2", "codex.prompts:p.md": "p1" },
          { agreed: true },
        ),
      ),
    ];
    const candidate = view(
      NEW,
      snapshot(
        { "claude.agents:a.md": "h1", "claude.agents:b.md": "other", "claude.agents:c.md": "h3" },
        { categories: null },
      ),
    );

    expect(summarizeSyncJoin(peers, candidate, ["claude.agents", "codex.prompts"])).toEqual([
      { categoryId: "claude.agents", incoming: 0, outgoing: 1, conflicts: 1 },
      { categoryId: "codex.prompts", incoming: 1, outgoing: 0, conflicts: 0 },
    ]);
  });

  it("leaves out categories the machine would not sync", () => {
    const peers = [view(PEER, snapshot({ "codex.prompts:p.md": "p1" }, { agreed: true }))];
    const candidate = view(NEW, snapshot({}, { categories: null }));

    expect(summarizeSyncJoin(peers, candidate, ["claude.agents"])).toEqual([
      { categoryId: "claude.agents", incoming: 0, outgoing: 0, conflicts: 0 },
    ]);
  });
});

describe("peerSyncCategories", () => {
  it("keeps the peers' categories that the joining machine can sync", () => {
    const peers = [view(PEER, snapshot({}, { categories: ["codex.prompts", "vault"] }))];

    expect(peerSyncCategories(peers, snapshot({}, { categories: null }))).toEqual([
      "codex.prompts",
    ]);
  });
});
