/**
 * @fileoverview CPU bounds for caller-sized DOI and PMID input patterns.
 * @module tests/services/orcid/identifier-cost.test
 */
import { describe, expect, it } from 'vitest';
import { DOI_INPUT_PATTERN, PMID_INPUT_PATTERN } from '@/services/orcid/solr-query.js';

describe('identifier grammar CPU bounds', { timeout: 30_000 }, () => {
  /** Thread CPU microseconds for repeated validation, excluding fixture allocation. */
  function measure(pattern: RegExp, value: string): number {
    pattern.test(value);
    const before = process.threadCpuUsage();
    for (let i = 0; i < 100; i++) pattern.test(value);
    const used = process.threadCpuUsage(before);
    return used.user + used.system;
  }

  it.each([
    ['DOI digit run', DOI_INPUT_PATTERN, (n: number) => `10.${'1'.repeat(n)}x`],
    ['PMID digit run', PMID_INPUT_PATTERN, (n: number) => `${'1'.repeat(n)}x`],
    ['DOI whitespace', DOI_INPUT_PATTERN, (n: number) => `${' '.repeat(n)}x`],
    ['PMID whitespace', PMID_INPUT_PATTERN, (n: number) => `${' '.repeat(n)}x`],
    ['DOI line ending', DOI_INPUT_PATTERN, (n: number) => `10.1/${'x'.repeat(n)}\ny`],
    ['DOI repeated breaks', DOI_INPUT_PATTERN, (n: number) => `10.1/${'x\n'.repeat(n / 2)}y`],
    ['PMID line ending', PMID_INPUT_PATTERN, (n: number) => `${'1'.repeat(n)}\ny`],
    ['PMID repeated breaks', PMID_INPUT_PATTERN, (n: number) => `${'1\n'.repeat(n / 2)}y`],
  ])('%s remains bounded across 5k to 320k', (_label, pattern, build) => {
    const times = new Map<number, number>();
    for (const size of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000]) {
      const time = measure(pattern, build(size));
      expect(time).toBeLessThan(500_000);
      times.set(size, time);
    }
    // Whole-span digit-run comparisons avoid Bun's whitespace engine tier transition.
    if (_label.includes('digit run')) {
      expect(times.get(320_000)! / Math.max(times.get(5_000)!, 1)).toBeLessThan(256);
    }
  });
});
