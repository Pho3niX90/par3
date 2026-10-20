import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_LINK_SECRETS,
  CLOUD_LINKED_USER_ID,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import { dropUpstreamRelayLink } from "./upstreamRelayLink.ts";

const ENVIRONMENT_KEY_PAIR = "cloud-link-ed25519-key-pair";

function runDrop(input: { readonly storedRelayUrl: string; readonly configuredRelayUrl?: string }) {
  const initial: ReadonlyArray<readonly [string, string]> = [
    [RELAY_URL_SECRET, input.storedRelayUrl],
    [CLOUD_LINKED_USER_ID, "user_upstream"],
    [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    [PUBLISH_AGENT_ACTIVITY_SECRET, "true"],
    [ENVIRONMENT_KEY_PAIR, "key-pair"],
  ];
  const values = new Map(
    initial.map(([name, value]) => [name, new TextEncoder().encode(value)] as const),
  );
  const store: ServerSecretStore.ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: () => Effect.die("unused"),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  };
  const env = input.configuredRelayUrl ? { T3CODE_RELAY_URL: input.configuredRelayUrl } : {};
  return dropUpstreamRelayLink.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, store),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Effect.map((dropped) => ({ dropped, remaining: [...values.keys()].toSorted() })),
  );
}

describe("dropUpstreamRelayLink", () => {
  it.effect("unlinks an environment still linked to T3 Connect, keeping its key pair", () =>
    Effect.gen(function* () {
      const result = yield* runDrop({
        storedRelayUrl: "https://relay.t3.codes",
        configuredRelayUrl: "https://relay.paritylabs.co.za",
      });
      expect(result).toEqual({ dropped: true, remaining: [ENVIRONMENT_KEY_PAIR] });
      expect(CLOUD_LINK_SECRETS).not.toContain(ENVIRONMENT_KEY_PAIR);
    }),
  );

  it.effect("unlinks it when no relay is configured", () =>
    Effect.gen(function* () {
      expect((yield* runDrop({ storedRelayUrl: "https://relay.t3.codes" })).dropped).toBe(true);
    }),
  );

  it.effect("keeps a link to any other relay, even one this build is not configured for", () =>
    Effect.gen(function* () {
      const result = yield* runDrop({
        storedRelayUrl: "https://relay.example.test",
        configuredRelayUrl: "https://relay.paritylabs.co.za",
      });
      expect(result.dropped).toBe(false);
      expect(result.remaining).toContain(CLOUD_LINKED_USER_ID);
    }),
  );

  it.effect("keeps the link when this build is pointed at T3 Connect itself", () =>
    Effect.gen(function* () {
      const result = yield* runDrop({
        storedRelayUrl: "https://relay.t3.codes",
        configuredRelayUrl: "https://relay.t3.codes",
      });
      expect(result.dropped).toBe(false);
    }),
  );
});
