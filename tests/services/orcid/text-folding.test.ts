/**
 * @fileoverview Tests for the accent-insensitive text folds behind name and institution
 * matching (#35), including the name fold that reads a dash as a space.
 * @module tests/services/orcid/text-folding.test
 */

import { describe, expect, it } from 'vitest';
import { foldForMatching, foldNameForMatching } from '@/services/orcid/text-folding.js';
import { expectLinearCpu } from '../../helpers/cpu-growth.js';

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
});

describe('foldNameForMatching', () => {
  it.each([
    ['Jean-Pierre', 'jean pierre'],
    ['Jean‐Pierre', 'jean pierre'],
    ['Jean–Pierre', 'jean pierre'],
    ['Jean—Pierre', 'jean pierre'],
    ['José-María Baselga', 'jose maria baselga'],
    ["O'Brien-Walsh", 'obrien walsh'],
    ['Qian-Wei Wang', 'qian wei wang'],
  ])('reads every dash in %j as a space: %j', (input, expected) => {
    expect(foldNameForMatching(input)).toBe(expected);
  });

  it('drops the other punctuation the way foldForMatching does', () => {
    expect(foldNameForMatching('J. A. Doudna')).toBe('j a doudna');
    expect(foldNameForMatching('Smith, Jr.')).toBe('smith jr');
    // U+2212 is a math sign, not a dash.
    expect(foldNameForMatching('a−b')).toBe('ab');
  });

  it.each([['José Baselga'], ['山中 伸弥'], ['J. A. Doudna']])(
    'folds the dash-free %j exactly as foldForMatching does',
    (input) => {
      expect(foldNameForMatching(input)).toBe(foldForMatching(input));
    },
  );
});

describe('folding cost stays linear in input length', () => {
  /**
   * Worst-case shapes: a long line ending in a break, breaks throughout, dash runs, dense
   * combining marks, precomposed accents, punctuation runs, CJK.
   */
  const shapes: [string, (size: number) => string][] = [
    ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
    ['dash runs', (n) => `a${'-‐–—'.repeat(n / 4)}b`],
    ['dense combining marks', (n) => `e${'\u0301\u0308'.repeat(n / 2)}`],
    ['precomposed accents', (n) => 'éüñøå'.repeat(n / 5)],
    ['punctuation runs', (n) => `a${'-.,;!'.repeat(n / 5)}b`],
    ['whitespace runs', (n) => `a${' \t'.repeat(n / 2)}b`],
    ['non-Latin text', (n) => '山中伸弥김철수'.repeat(n / 7)],
  ];

  it.each(shapes)('foldForMatching grows linearly on %s', { timeout: 0 }, (_, build) => {
    expectLinearCpu(foldForMatching, build, { microsPerChar: 1 });
  });

  it.each(shapes)('foldNameForMatching grows linearly on %s', { timeout: 0 }, (_, build) => {
    expectLinearCpu(foldNameForMatching, build, { microsPerChar: 1 });
  });
});
