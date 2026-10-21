export async function runPlanSubmission<T>(input: {
  guard: { current: boolean };
  onBusy: (busy: boolean) => void;
  isCurrent: () => boolean;
  prepare: () => Promise<T | null>;
  send: (prepared: T) => Promise<boolean>;
  onSuccess: (prepared: T) => void;
}) {
  if (input.guard.current) return false;
  input.guard.current = true;
  input.onBusy(true);
  try {
    if (!input.isCurrent()) return false;
    const prepared = await input.prepare();
    if (prepared === null || !input.isCurrent()) return false;
    const sent = await input.send(prepared);
    if (sent) input.onSuccess(prepared);
    return sent;
  } finally {
    input.guard.current = false;
    input.onBusy(false);
  }
}
