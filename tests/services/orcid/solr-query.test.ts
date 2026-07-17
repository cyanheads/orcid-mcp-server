/**
 * @fileoverview Tests for the shared Solr/Lucene query-value escaper (#18).
 * @module tests/services/orcid/solr-query.test
 */

import { describe, expect, it } from 'vitest';
import { escapeSolrValue } from '@/services/orcid/solr-query.js';

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
