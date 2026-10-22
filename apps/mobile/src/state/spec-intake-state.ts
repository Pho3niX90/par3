import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { withSpecIntakeRequest } from "./spec-intake-model";

/**
 * Composers whose next message should start a spec. Held per composer draft key and not
 * persisted: it is a choice for the message being written, and a queued message carries it
 * from the moment it is sent.
 */
export const specIntakeRequestsAtom = Atom.make<Readonly<Record<string, true>>>({}).pipe(
  Atom.keepAlive,
);

export function setSpecIntakeRequested(draftKey: string, requested: boolean): void {
  appAtomRegistry.set(
    specIntakeRequestsAtom,
    withSpecIntakeRequest(appAtomRegistry.get(specIntakeRequestsAtom), draftKey, requested),
  );
}

export function readSpecIntakeRequested(draftKey: string | null): boolean {
  return draftKey !== null && appAtomRegistry.get(specIntakeRequestsAtom)[draftKey] === true;
}
