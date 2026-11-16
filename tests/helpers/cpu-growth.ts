/**
 * @fileoverview Linear-growth assertion for code that scans caller-sized text: per-call thread
 * CPU time at doubling input sizes, so a super-linear scan fails in seconds instead of hanging
 * the suite on its largest input.
 * @module tests/helpers/cpu-growth
 */

import { expect } from 'vitest';

/** The smallest input size, and the baseline every larger size is compared with. */
const BASE_SIZE = 5_000;

/**
 * Least per-call thread CPU microseconds over five timings of `calls` calls. Thread CPU leaves
 * out the time a loaded machine deschedules the worker, and the least of several timings drops
 * garbage-collection pauses, which only ever add time.
 */
function perCallMicros(run: (input: string) => unknown, input: string, calls: number): number {
  let least = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 5; sample++) {
    const before = process.threadCpuUsage();
    for (let i = 0; i < calls; i++) run(input);
    const used = process.threadCpuUsage(before);
    least = Math.min(least, (used.user + used.system) / calls);
  }
  return least;
}

/**
 * Assert that `run(build(size))` costs linear CPU time from 5k characters to `maxSize`,
 * doubling. Each size must stay under `microsPerChar × size` per call before the next size
 * runs. The largest size, timed beside a fresh 5k baseline three times, must cost under
 * `4 × (maxSize / 5k)` times that baseline in the least of those pairs: 256 for the default 64×
 * span, where a quadratic reaches 4,096. Re-timing the baseline beside it keeps a baseline that
 * ran on a faster core from inflating the ratio, and the small input is timed per call over a
 * batch, since one 5k call is below the timer's resolution.
 */
export function expectLinearCpu(
  run: (input: string) => unknown,
  build: (size: number) => string,
  { maxSize = 320_000, microsPerChar }: { maxSize?: number; microsPerChar: number },
): void {
  const callsFor = (size: number) => Math.max(1, Math.round((64 * BASE_SIZE) / size));
  const base = build(BASE_SIZE);
  for (let size = BASE_SIZE; size <= maxSize; size *= 2) {
    const micros = perCallMicros(run, build(size), callsFor(size));
    expect(micros, `${size} characters`).toBeLessThan(microsPerChar * size);
  }
  const largest = build(maxSize);
  let leastGrowth = Number.POSITIVE_INFINITY;
  for (let pair = 0; pair < 3; pair++) {
    const baseline = perCallMicros(run, base, callsFor(BASE_SIZE));
    const top = perCallMicros(run, largest, callsFor(maxSize));
    leastGrowth = Math.min(leastGrowth, top / Math.max(baseline, 1));
  }
  expect(leastGrowth).toBeLessThan(4 * (maxSize / BASE_SIZE));
}
