/**
 * @fileoverview Tests for the accent-insensitive text fold behind name and institution
 * matching (#35).
 * @module tests/services/orcid/text-folding.test
 */

import { describe, expect, it } from 'vitest';
import { foldForMatching } from '@/services/orcid/text-folding.js';

describe('foldForMatching', () => {
  it.each([
    ['José Baselga', 'jose baselga'],
    ['Jose\u0301 Baselga', 'jose baselga'],
    ['Université de Montréal', 'universite de montreal'],
    ['Universität Zürich', 'universitat zurich'],
    ['ÅNGSTRÖM', 'angstrom'],
    ['ﬁnance', 'finance'],
  ])('folds %j to %j', (input, expected) => {
    expect(foldForMatching(input)).toBe(expected);
  });

  it('folds accented and unaccented forms to the same string, in both directions', () => {
    expect(foldForMatching('José Baselga')).toBe(foldForMatching('Jose Baselga'));
    expect(foldForMatching('Jose Baselga')).toBe(foldForMatching('JOSÉ BASELGA'));
  });

  it('drops ASCII punctuation the way the ASCII-only fold did', () => {
    expect(foldForMatching("O'Brien")).toBe('obrien');
    expect(foldForMatching('J. A. Doudna')).toBe('j a doudna');
    expect(foldForMatching('Jean-Luc')).toBe('jeanluc');
  });

  it.each([['山中 伸弥'], ['김철수'], ['Иванов Пётр'], ['Αλέξανδρος'], ['محمد'], ['राम']])(
    'keeps the letters of non-Latin %j instead of folding them away',
    (input) => {
      const folded = foldForMatching(input);
      expect(folded.trim()).not.toBe('');
      expect(folded).toBe(foldForMatching(folded));
    },
  );

  it('folds a string with no letters or digits to nothing but whitespace', () => {
    expect(foldForMatching('— … !?').trim()).toBe('');
  });

  describe('cost stays linear in input length', () => {
    /** Best-of-three wall-clock for folding `value`. */
    function timeFor(value: string): number {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        foldForMatching(value);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    }

    /** Worst-case shapes: dense combining marks, punctuation runs, whitespace runs, CJK. */
    const shapes: [string, (size: number) => string][] = [
      ['dense combining marks', (n) => `e${'\u0301\u0308'.repeat(n / 2)}`],
      ['precomposed accents', (n) => 'éüñøå'.repeat(n / 5)],
      ['punctuation runs', (n) => `a${'-.,;!'.repeat(n / 5)}b`],
      ['whitespace runs', (n) => `a${' \t'.repeat(n / 2)}b`],
      ['non-Latin text', (n) => '山中伸弥김철수'.repeat(n / 7)],
    ];

    it.each(shapes)('%s: 5k and 80k characters', (_, build) => {
      const [t5, t80] = [5_000, 80_000].map((size) => timeFor(build(size)));

      // 16x the input may cost ~16x the time; quadratic growth would be ~256x, so a 64x bound
      // leaves room for load noise while still failing a quadratic fold. The 1 ms floor keeps
      // timer noise on the small case from inflating the ratio.
      expect(t80! / Math.max(t5!, 1)).toBeLessThan(64);
      expect(t80!).toBeLessThan(500);
    });
  });
});
