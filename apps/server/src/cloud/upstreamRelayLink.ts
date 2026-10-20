import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINK_SECRETS, RELAY_URL_SECRET } from "./config.ts";
import { relayUrlConfig } from "./publicConfig.ts";

function isUpstreamRelayUrl(value: string): boolean {
  try {
    const { hostname } = new URL(value.trim());
    return hostname === "t3.codes" || hostname.endsWith(".t3.codes");
  } catch {
    return false;
  }
}

/**
 * Par3 installs that once used T3 Connect still hold a link to upstream's
 * relay. It belongs to an upstream account, so linking to the Par3 relay fails
 * the linked-account check, and while it stays it keeps publishing agent
 * activity to upstream. Drop it unless this build is itself pointed at
 * upstream's relay. No relay call: the upstream record is not ours to revoke.
 */
export const dropUpstreamRelayLink = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const stored = yield* secrets.get(RELAY_URL_SECRET);
  if (Option.isNone(stored)) return false;
  const storedRelayUrl = new TextDecoder().decode(stored.value);
  if (!isUpstreamRelayUrl(storedRelayUrl)) return false;
  const configuredRelayUrl = yield* relayUrlConfig.pipe(Effect.orElseSucceed(() => null));
  if (configuredRelayUrl !== null && isUpstreamRelayUrl(configuredRelayUrl)) return false;
  yield* Effect.forEach(CLOUD_LINK_SECRETS, (name) => secrets.remove(name), {
    concurrency: "unbounded",
    discard: true,
  });
  yield* Effect.logInfo("Dropped a Parity Connect link left over from T3 Connect", {
    relayHost: new URL(storedRelayUrl.trim()).hostname,
  });
  return true;
}).pipe(
  Effect.catchIf(ServerSecretStore.isSecretStoreError, (cause) =>
    Effect.logWarning("Could not drop the leftover T3 Connect link", { cause }).pipe(
      Effect.as(false),
    ),
  ),
);
