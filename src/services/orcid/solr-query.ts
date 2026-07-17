/**
 * @fileoverview Shared Solr/Lucene query-value escaping for ORCID search clauses.
 * Both query builders (search-researchers, resolve-researcher) interpolate structured
 * values (names, affiliations, DOIs, PMIDs) into Solr field clauses. Unescaped reserved
 * characters break phrase scoping or produce a malformed upstream request (ORCID 500).
 * This is the single place that neutralizes those characters, mirroring the one-small-
 * file-per-shared-concern pattern of `orcid-id.ts`.
 * @module services/orcid/solr-query
 */

/**
 * Reserved characters in the Lucene classic query parser that ORCID's Solr backend uses.
 * Matches Lucene's own `QueryParser.escape()` set: escaping any of these makes it a
 * literal, and — verified against the live ORCID API — escaping one that is already
 * literal inside a phrase quote is a no-op (identical result count and status).
 */
const SOLR_RESERVED_CHARS = '\\+-!(){}[]^"~*?:|&/';

/**
 * Backslash-escape every Lucene/Solr reserved character in `value` so it is treated as a
 * literal inside a field clause — quoted or not. Applied uniformly to every structured
 * value before interpolation; raw `query` passthrough input is deliberately NOT escaped.
 *
 * @param value - The raw structured value to interpolate into a Solr clause.
 * @returns The value with each reserved character prefixed by a backslash.
 */
export function escapeSolrValue(value: string): string {
  let escaped = '';
  for (const char of value) {
    if (SOLR_RESERVED_CHARS.includes(char)) escaped += '\\';
    escaped += char;
  }
  return escaped;
}
