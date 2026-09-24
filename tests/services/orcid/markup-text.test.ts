/**
 * @fileoverview Tests for the plain-text boundary applied to ORCID free text (#37): generic
 * tag stripping (inline formatting tags join their neighbours, every other tag keeps a word
 * boundary), single-pass entity decoding, pass-through of unmarked text, and linear cost on
 * adversarial input.
 * @module tests/services/orcid/markup-text.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toPlainText } from '@/services/orcid/markup-text.js';

describe('toPlainText', () => {
  it.each([
    ['by  <i>in vivo</i>  editor', 'by in vivo editor'],
    ['in  <i>Arabidopsis</i>', 'in Arabidopsis'],
    ['a <sup>32</sup>P-phosphate', 'a 32P-phosphate'],
    [
      'Report on <i>Heritable Human Genome Editing</i>.',
      'Report on Heritable Human Genome Editing.',
    ],
    ['H<sub>2</sub>O and CO<SUB>2</SUB>', 'H2O and CO2'],
    ['<a href="https://x.org">link</a>s', 'links'],
    ['un<jats:italic>bound</jats:italic>ed', 'unbounded'],
    ['<h4>Background</h4>Group I<h4>Results</h4>Heavy', 'Background Group I Results Heavy'],
    ['word<x-unknown>word', 'word word'],
    ['<i>italic</i><br>next', 'italic next'],
    [
      '<jats:p>Namespaced <jats:italic>JATS</jats:italic> markup.</jats:p>',
      'Namespaced JATS markup.',
    ],
    ['<span class="x" data-y=\'1\'>attrs</span>', 'attrs'],
    ['line<br>break<br/>and<br />more', 'line break and more'],
    ['<p>\n  Para one.\n</p>\n<p>Para two.</p>', 'Para one. Para two.'],
    ['<b><i>nested</i></b> tags', 'nested tags'],
  ])('strips %j to %j', (input, expected) => {
    expect(toPlainText(input)).toBe(expected);
  });

  it.each([
    ['p < 0.05 and x<3', 'a lone < before a space or digit is text'],
    ['5′ ends & 3′ ends', 'a bare ampersand is text'],
    ['a<b, c', 'a < with no closing > is text'],
    ['  doubled  spaces  and\nnewlines  ', 'whitespace away from a tag is kept'],
    ['Ünïcödé — 山中伸弥', 'non-ASCII text'],
  ])('passes %j through byte-identical (%s)', (input) => {
    expect(toPlainText(input)).toBe(input);
  });

  it('decodes character references exactly once', () => {
    expect(toPlainText('&amp;lt;i&amp;gt;')).toBe('&lt;i&gt;');
    expect(toPlainText('Protein &amp; RNA')).toBe('Protein & RNA');
    expect(toPlainText('&#946;-sheet &#x3B1;-helix &#X3B3;')).toBe('β-sheet α-helix γ');
    expect(toPlainText('&quot;q&quot; &apos;a&apos; a&nbsp;b')).toBe('"q" \'a\' a b');
  });

  it('leaves unknown or invalid references literal instead of inventing characters', () => {
    expect(toPlainText('&notanentity; &#0; &#xD800; &#x110000;')).toBe(
      '&notanentity; &#0; &#xD800; &#x110000;',
    );
  });

  it('keeps an encoded tag as literal text rather than stripping it', () => {
    expect(toPlainText('&lt;i&gt;literal&lt;/i&gt;')).toBe('<i>literal</i>');
  });

  it('returns undefined for absent, empty, and markup-only input', () => {
    expect(toPlainText(undefined)).toBeUndefined();
    expect(toPlainText(null)).toBeUndefined();
    expect(toPlainText('')).toBeUndefined();
    expect(toPlainText('<i> </i>')).toBeUndefined();
    expect(toPlainText('<br/>')).toBeUndefined();
  });

  it('leaves no tag behind, joins at inline tags, spaces at the rest, and is idempotent', () => {
    const word = fc.stringMatching(/^[A-Za-z0-9.,;-]{1,12}$/);
    const inline = ['<i>', '</i>', '<sup>', '</sup>', '<span class="x">'];
    const tag = fc.constantFrom(...inline, '<h4>', '</h4>', '<br/>', '<p>');
    const space = fc.constantFrom('', ' ', '  ', '\n');
    fc.assert(
      fc.property(
        fc.array(fc.tuple(word, space, tag, space), { maxLength: 20 }),
        word,
        (runs, tail) => {
          const input = runs.map((parts) => parts.join('')).join('') + tail;
          const output = toPlainText(input);
          // Every tag sits between two words. An inline tag with no whitespace beside it joins
          // them; any other tag, or whitespace on either side, leaves exactly one space.
          const expected = runs
            .map(([w, before, t, after]) => {
              const joined = inline.includes(t) && before === '' && after === '';
              return w + (joined ? '' : ' ');
            })
            .join('');
          expect(output).toBe(expected + tail);
          expect(toPlainText(output)).toBe(output);
        },
      ),
      { numRuns: 500, seed: 20_260_923 },
    );
  });

  it('is the identity on text with no < and no &', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 200 }), (raw) => {
        const input = raw.replace(/[<&]/g, '');
        expect(toPlainText(input)).toBe(input || undefined);
      }),
      { numRuns: 500, seed: 20_260_923 },
    );
  });

  describe('cost stays linear in input length', () => {
    /** Best-of-three wall-clock for cleaning `value`. */
    function timeFor(value: string): number {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        toPlainText(value);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    }

    /** Worst-case shapes for the tag scan, the boundary trims, and the entity pass. */
    const shapes: [string, (size: number) => string][] = [
      ['repeated < with no >', (n) => '<'.repeat(n)],
      ['repeated <a with no >', (n) => '<a'.repeat(n / 2)],
      ['one unclosed tag with a long attribute run', (n) => `<a ${'x'.repeat(n - 3)}`],
      ['unclosed tags with attribute runs', (n) => '<a b '.repeat(n / 5)],
      ['nested tags', (n) => `${'<b>'.repeat(n / 8)}x${'</b>'.repeat(n / 8)}`],
      ['overlapping tags', (n) => '<a<b>>'.repeat(n / 6)],
      ['whitespace runs between tags', (n) => `<i>${' '.repeat(n / 2)}</i>${' '.repeat(n / 2)}x`],
      ['dense entities', (n) => '&amp;&#946;&x;'.repeat(n / 14)],
    ];

    it.each(shapes)('%s: 5k, 20k, and 80k characters', (_, build) => {
      const [t5, , t80] = [5_000, 20_000, 80_000].map((size) => timeFor(build(size)));

      // 16x the input may cost ~16x the time; quadratic growth would be ~256x, so a 64x bound
      // leaves room for load noise while still failing a quadratic scan. The 1 ms floor keeps
      // timer noise on the small case from inflating the ratio.
      expect(t80! / Math.max(t5!, 1)).toBeLessThan(64);
      expect(t80!).toBeLessThan(500);
    });
  });
});
