/**
 * @fileoverview Tests for the shared Solr/Lucene query-value escaper (#18) and the DOI/PMID
 * URL-prefix stripper (#44).
 * @module tests/services/orcid/solr-query.test
 */

import { describe, expect, it } from 'vitest';
import { escapeSolrValue, stripIdentifierPrefix } from '@/services/orcid/solr-query.js';

describe('escapeSolrValue', () => {
  it('escapes an embedded double quote', () => {
    expect(escapeSolrValue('O"Connor')).toBe('O\\"Connor');
  });

  it('escapes a backslash', () => {
    // Input is the 3-char string a\b; output backslash-escapes the backslash.
    expect(escapeSolrValue('a\\b')).toBe('a\\\\b');
  });

  it('escapes every Lucene reserved character individually', () => {
    // Reserved set: \ + - ! ( ) { } [ ] ^ " ~ * ? : | & /
    expect(escapeSolrValue('+')).toBe('\\+');
    expect(escapeSolrValue('-')).toBe('\\-');
    expect(escapeSolrValue('!')).toBe('\\!');
    expect(escapeSolrValue('(')).toBe('\\(');
    expect(escapeSolrValue(')')).toBe('\\)');
    expect(escapeSolrValue('{')).toBe('\\{');
    expect(escapeSolrValue('}')).toBe('\\}');
    expect(escapeSolrValue('[')).toBe('\\[');
    expect(escapeSolrValue(']')).toBe('\\]');
    expect(escapeSolrValue('^')).toBe('\\^');
    expect(escapeSolrValue('"')).toBe('\\"');
    expect(escapeSolrValue('~')).toBe('\\~');
    expect(escapeSolrValue('*')).toBe('\\*');
    expect(escapeSolrValue('?')).toBe('\\?');
    expect(escapeSolrValue(':')).toBe('\\:');
    expect(escapeSolrValue('|')).toBe('\\|');
    expect(escapeSolrValue('&')).toBe('\\&');
    expect(escapeSolrValue('/')).toBe('\\/');
  });

  it('escapes reserved chars in a punctuation-heavy DOI, leaving < > ; literal', () => {
    expect(escapeSolrValue('10.1002/(SICI)1099-0844(199912)17:4<290::AID-CBF849>3.0.CO;2-P')).toBe(
      '10.1002\\/\\(SICI\\)1099\\-0844\\(199912\\)17\\:4<290\\:\\:AID\\-CBF849>3.0.CO;2\\-P',
    );
  });

  it('is a no-op for plain values with no reserved characters', () => {
    expect(escapeSolrValue('Jennifer Doudna')).toBe('Jennifer Doudna');
    expect(escapeSolrValue('University of California')).toBe('University of California');
    expect(escapeSolrValue('22745249')).toBe('22745249');
  });

  it('leaves an apostrophe untouched (not a Lucene reserved char)', () => {
    expect(escapeSolrValue("O'Brien")).toBe("O'Brien");
  });

  it('returns an empty string unchanged', () => {
    expect(escapeSolrValue('')).toBe('');
  });
});

describe('stripIdentifierPrefix', () => {
  it.each([
    ['https://doi.org/10.5555/12345680'],
    ['http://doi.org/10.5555/12345680'],
    ['https://dx.doi.org/10.5555/12345680'],
    ['http://dx.doi.org/10.5555/12345680'],
    ['doi:10.5555/12345680'],
    ['DOI:10.5555/12345680'],
    ['HTTPS://DOI.ORG/10.5555/12345680'],
    ['doi.org/10.5555/12345680'],
    ['dx.doi.org/10.5555/12345680'],
    ['doi: 10.5555/12345680'],
    ['  https://doi.org/10.5555/12345680\t'],
    ['10.5555/12345680'],
  ])('reduces DOI %j to the bare identifier', (value) => {
    expect(stripIdentifierPrefix('doi', value)).toBe('10.5555/12345680');
  });

  it('never changes the case of the DOI body', () => {
    expect(stripIdentifierPrefix('doi', 'HTTPS://DX.DOI.ORG/10.1371/journal.PMED.0020124')).toBe(
      '10.1371/journal.PMED.0020124',
    );
  });

  it('strips one prefix only, leaving a repeated one in place', () => {
    expect(stripIdentifierPrefix('doi', 'doi:doi:10.1/x')).toBe('doi:10.1/x');
  });

  it('does not strip a prefix that appears after the start', () => {
    expect(stripIdentifierPrefix('doi', 'see https://doi.org/10.1/x')).toBe(
      'see https://doi.org/10.1/x',
    );
  });

  it.each([
    ['https://pubmed.ncbi.nlm.nih.gov/22745249/'],
    ['https://pubmed.ncbi.nlm.nih.gov/22745249'],
    ['http://pubmed.ncbi.nlm.nih.gov/22745249/'],
    ['https://www.ncbi.nlm.nih.gov/pubmed/22745249'],
    ['https://ncbi.nlm.nih.gov/pubmed/22745249/'],
    ['HTTPS://WWW.NCBI.NLM.NIH.GOV/PUBMED/22745249'],
    ['pubmed.ncbi.nlm.nih.gov/22745249/'],
    ['https://pubmed.ncbi.nlm.nih.gov/22745249/?from_single_result=22745249'],
    ['https://pubmed.ncbi.nlm.nih.gov/22745249#affiliation-1'],
    ['PMID: 22745249'],
    ['pmid:22745249'],
    [' 22745249 '],
  ])('reduces PMID %j to the bare identifier', (value) => {
    expect(stripIdentifierPrefix('pmid', value)).toBe('22745249');
  });

  it("applies each kind's prefixes only to that kind", () => {
    expect(stripIdentifierPrefix('pmid', 'doi:123')).toBe('doi:123');
    expect(stripIdentifierPrefix('doi', 'PMID:10.1/x')).toBe('PMID:10.1/x');
    expect(stripIdentifierPrefix('doi', 'https://pubmed.ncbi.nlm.nih.gov/123/')).toBe(
      'https://pubmed.ncbi.nlm.nih.gov/123/',
    );
  });

  it.each([
    ['doi', 'https://doi.org/'],
    ['doi', 'doi:'],
    ['doi', '  DOI:  '],
    ['pmid', 'https://pubmed.ncbi.nlm.nih.gov/'],
    ['pmid', 'https://www.ncbi.nlm.nih.gov/pubmed/'],
    ['pmid', 'PMID:'],
    ['pmid', 'https://pubmed.ncbi.nlm.nih.gov/?term=crispr'],
    ['doi', ''],
    ['pmid', '   '],
  ] as const)('normalizes a %s that is only a prefix (%j) to empty', (kind, value) => {
    expect(stripIdentifierPrefix(kind, value)).toBe('');
  });

  describe('cost stays linear in input length', () => {
    /** Best-of-three wall-clock for stripping `value`. */
    function timeFor(kind: 'doi' | 'pmid', value: string): number {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        for (let j = 0; j < 20; j++) stripIdentifierPrefix(kind, value);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    }

    /** Worst-case shapes: repeated prefix openers, near-miss openers, and long slash runs. */
    const shapes: [string, 'doi' | 'pmid', (size: number) => string][] = [
      ['repeated DOI prefixes', 'doi', (n) => 'https://doi.org/'.repeat(n / 16)],
      ['near-miss DOI openers', 'doi', (n) => 'https://dx.doi.or'.repeat(n / 17)],
      ['repeated doi: openers', 'doi', (n) => 'doi:'.repeat(n / 4)],
      ['repeated PMID prefixes', 'pmid', (n) => 'https://pubmed.ncbi.nlm.nih.gov/'.repeat(n / 32)],
      ['a long slash run', 'pmid', (n) => `https://pubmed.ncbi.nlm.nih.gov/${'/'.repeat(n)}x`],
      ['long whitespace padding', 'doi', (n) => `${' '.repeat(n)}doi:10.1/x${' '.repeat(n)}`],
      ['a long PMID query string', 'pmid', (n) => `PMID:1${'/?#'.repeat(n / 3)}`],
    ];

    it.each(shapes)('%s: 5k and 80k characters', (_, kind, build) => {
      const [t5, t80] = [5_000, 80_000].map((size) => timeFor(kind, build(size)));

      // 16x the input may cost ~16x the time; quadratic growth would be ~256x, so a 64x bound
      // leaves room for load noise while still failing a quadratic scan. The 1 ms floor keeps
      // timer noise on the small case from inflating the ratio.
      expect(t80! / Math.max(t5!, 1)).toBeLessThan(64);
      expect(t80!).toBeLessThan(500);
    });
  });
});
