/**
 * @fileoverview Shared Solr/Lucene query-value preparation for ORCID search clauses.
 * Both query builders (search-researchers, resolve-researcher) interpolate structured
 * values (names, affiliations, DOIs, PMIDs, grant numbers) into Solr field clauses.
 * Unescaped reserved characters break phrase scoping or produce a malformed upstream
 * request (ORCID 500), and a DOI or PMID given as a URL matches nothing, because ORCID
 * indexes the bare identifier. This is the single place that handles both, mirroring the
 * one-small-file-per-shared-concern pattern of `orcid-id.ts`.
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
 * literal inside a field clause. Whitespace is not reserved, so callers also phrase-quote
 * the escaped value to keep it one clause. Applied uniformly to every structured value
 * before interpolation; raw `query` passthrough input is deliberately NOT escaped.
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

/**
 * Leading URL or label prefixes a caller may wrap a work identifier in; the URL scheme is
 * optional. Anchored and made of fixed alternatives, so a match attempt costs one pass
 * over the prefix. A bare DOI starts with `10.` and a bare PMID is digits, so no prefix
 * can eat part of a real identifier.
 */
const IDENTIFIER_PREFIXES = {
  doi: /^(?:(?:https?:\/\/)?(?:dx\.)?doi\.org\/|doi:)/i,
  pmid: /^(?:(?:https?:\/\/)?(?:(?:www\.)?ncbi\.nlm\.nih\.gov\/pubmed\/|pubmed\.ncbi\.nlm\.nih\.gov\/)|pmid:)/i,
} as const;

/**
 * Reduce a DOI or PMID to the bare identifier ORCID indexes: trim, strip one leading URL,
 * `doi:`, or `PMID:` prefix (matched case-insensitively), and for a PMID drop a URL query
 * string or fragment and one trailing slash. The identifier body keeps its case —
 * `doi-self` matching can be case-sensitive. A value that is only a prefix comes back empty,
 * which callers treat as a blank field.
 *
 * @param kind - Which identifier's prefixes to strip.
 * @param value - The raw `doi` or `pmid` input.
 * @returns The bare identifier, trimmed; `''` when nothing remains.
 */
export function stripIdentifierPrefix(kind: 'doi' | 'pmid', value: string): string {
  const bare = value.trim().replace(IDENTIFIER_PREFIXES[kind], '');
  if (kind === 'doi') return bare.trim();
  // A PMID is digits only, so a `?` or `#` starts a PubMed URL's query string or fragment.
  const tail = bare.search(/[?#]/);
  const path = tail === -1 ? bare : bare.slice(0, tail);
  return (path.endsWith('/') ? path.slice(0, -1) : path).trim();
}
