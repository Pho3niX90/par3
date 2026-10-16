/**
 * Pure statistics for `bench-provider-overhead.ts`. Everything here is
 * deterministic for a given seed so the summary is reproducible from
 * `results.json`.
 */

/** Small seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sorted(values: ReadonlyArray<number>): number[] {
  return values.toSorted((left, right) => left - right);
}

/** Linear-interpolated percentile, `p` in [0, 100]. NaN for no samples. */
export function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return Number.NaN;
  const ordered = sorted(values);
  const rank = (p / 100) * (ordered.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lowerValue = ordered[lower]!;
  const upperValue = ordered[upper]!;
  return lowerValue + (upperValue - lowerValue) * (rank - lower);
}

export function median(values: ReadonlyArray<number>): number {
  return percentile(values, 50);
}

export interface Interval {
  readonly low: number;
  readonly high: number;
}

/**
 * Percentile bootstrap 95% CI for the difference of medians (`a − b`). Each
 * resample draws both groups with replacement, independently.
 */
export function bootstrapMedianDifferenceCi(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
  options: { readonly resamples?: number; readonly seed?: number } = {},
): Interval {
  if (a.length === 0 || b.length === 0) return { low: Number.NaN, high: Number.NaN };
  const random = seededRandom(options.seed ?? 31);
  const resamples = options.resamples ?? 2000;
  const draw = (values: ReadonlyArray<number>) =>
    median(Array.from(values, () => values[Math.floor(random() * values.length)]!));
  const differences = Array.from({ length: resamples }, () => draw(a) - draw(b));
  return { low: percentile(differences, 2.5), high: percentile(differences, 97.5) };
}

export interface OverheadVerdict {
  readonly pass: boolean;
  /** Median non-API time of the candidate minus the reference, in ms. */
  readonly gapMs: number;
  /** The largest gap that still passes, in ms. */
  readonly allowanceMs: number;
}

/**
 * Pass when the candidate's median non-API time is within
 * `max(floorMs, 5% of the reference's median wall time)` of the reference.
 * Non-API time keeps model variance out of the verdict; wall time sets the
 * scale users notice.
 */
export function overheadVerdict(input: {
  readonly candidateNonApiMs: ReadonlyArray<number>;
  readonly referenceNonApiMs: ReadonlyArray<number>;
  readonly referenceWallMs: ReadonlyArray<number>;
  readonly floorMs: number;
}): OverheadVerdict {
  const gapMs = median(input.candidateNonApiMs) - median(input.referenceNonApiMs);
  const allowanceMs = Math.max(input.floorMs, 0.05 * median(input.referenceWallMs));
  return { pass: gapMs <= allowanceMs, gapMs, allowanceMs };
}

export function formatSeconds(ms: number): string {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "–";
}

export function formatMs(ms: number): string {
  return Number.isFinite(ms) ? `${Math.round(ms)} ms` : "–";
}

/** `+1.4 s (+3.4%)`, signed, relative to `reference`. */
export function formatDelta(deltaMs: number, referenceMs: number): string {
  if (!Number.isFinite(deltaMs) || !Number.isFinite(referenceMs) || referenceMs === 0) return "–";
  const sign = deltaMs >= 0 ? "+" : "−";
  const percent = (Math.abs(deltaMs) / referenceMs) * 100;
  return `${sign}${(Math.abs(deltaMs) / 1000).toFixed(1)} s (${sign}${percent.toFixed(1)}%)`;
}
