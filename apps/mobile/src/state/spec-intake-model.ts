/** Composers whose next message should start a spec, by composer draft key. */
export function withSpecIntakeRequest(
  current: Readonly<Record<string, true>>,
  draftKey: string,
  requested: boolean,
): Readonly<Record<string, true>> {
  if ((current[draftKey] === true) === requested) return current;
  if (requested) return { ...current, [draftKey]: true };
  const { [draftKey]: _removed, ...rest } = current;
  return rest;
}
