/**
 * @fileoverview Shared Solr/Lucene query-value preparation for ORCID search clauses.
 * Both query builders (search-researchers, resolve-researcher) interpolate structured
 * values (names, affiliations, DOIs, PMIDs, ROR IDs, grant numbers) into Solr field
 * clauses. Unescaped reserved characters break phrase scoping or produce a malformed
 * upstream request (ORCID 500), and an identifier in a form ORCID does not index matches
 * nothing: DOIs and PMIDs are indexed bare, ROR IDs only as `https://ror.org/<lowercase>`.
 * Both builders also read byline initials out of name values ("J. Doudna"). This is the
 * single place that handles all three, mirroring the one-small-file-per-shared-concern
 * pattern of `orcid-id.ts`.
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

/**
 * The words of a name, split on whitespace and periods so byline initials stand alone
 * ("J.A. Doudna" → J, A, Doudna). Other punctuation stays inside its word.
 *
 * @param name - A name value as the caller supplied it.
 * @returns The non-empty words, in order.
 */
export function splitNameWords(name: string): string[] {
  return name.split(/[\s.]+/).filter(Boolean);
}

/** One Latin-script letter followed only by combining marks. */
const INITIAL = /^\p{Script=Latin}\p{M}*$/u;

/**
 * True when `word` is one Latin-script letter (with any combining marks) — a byline initial.
 * A one-character word in another script is not: a single CJK or Hangul character is a whole
 * given name.
 *
 * @param word - One word from {@link splitNameWords}.
 */
export function isInitial(word: string): boolean {
  return INITIAL.test(word);
}

/** Lucene conjunctions that join clauses without being clauses themselves. */
const CONJUNCTIONS = new Set(['AND', 'OR', '&&', '||']);

/**
 * Split a raw Lucene query on whitespace outside quotes, parentheses, brackets, and braces,
 * honoring backslash escapes. One pass over the input; an unbalanced opener just keeps the
 * rest of the query in one token.
 */
function topLevelTokens(query: string): string[] {
  const tokens: string[] = [];
  let start = 0;
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < query.length; i++) {
    const char = query.charAt(i);
    if (char === '\\') {
      i++;
    } else if (inQuote) {
      if (char === '"') inQuote = false;
    } else if (char === '"') {
      inQuote = true;
    } else if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && char.trim() === '') {
      if (i > start) tokens.push(query.slice(start, i));
      start = i + 1;
    }
  }
  if (query.length > start) tokens.push(query.slice(start));
  return tokens;
}

/**
 * True when every top-level clause of a raw Lucene query is an exclusion — prefixed `-` or
 * `!`, or following a `NOT` operator — and there is at least one. On ORCID's Solr a nested
 * group of only exclusions matches nothing (`a AND (-b)` returns 0 where `a AND -b` returns
 * the expected set), so the caller appending a raw query leaves such a query ungrouped.
 *
 * @param query - The trimmed raw `query` input.
 */
export function isExclusionOnlyQuery(query: string): boolean {
  const tokens = topLevelTokens(query).values();
  let clauses = 0;
  for (const token of tokens) {
    if (CONJUNCTIONS.has(token)) continue;
    if (token === 'NOT' || token === '!') {
      // The operand is consumed with its operator; a trailing NOT excludes nothing.
      if (tokens.next().done) return false;
    } else if (token.length < 2 || (token[0] !== '-' && token[0] !== '!')) {
      return false;
    }
    clauses++;
  }
  return clauses > 0;
}

/**
 * Every caller form of a ROR ID: `0`, six Crockford base32 characters (no `i`, `l`, `o`,
 * `u`), and two check digits, in either letter case, optionally after `ror.org/` (with an
 * optional `http(s)://` scheme and `www.` host) and before a trailing `/`. Scheme and host
 * stay lowercase and the pattern carries no flags, because Zod drops regex flags from the
 * emitted JSON Schema. Check digits are verified separately by {@link isValidRorId}.
 */
export const ROR_ID_PATTERN =
  /^(?:(?:https?:\/\/)?(?:www\.)?ror\.org\/)?0[0-9a-hjkmnp-tv-zA-HJKMNP-TV-Z]{6}[0-9]{2}\/?$/;

/**
 * The `ror_id` input grammar: a {@link ROR_ID_PATTERN} form or nothing, with surrounding
 * whitespace. The input trims before matching, so the server sees the bare form, but the
 * emitted JSON Schema `pattern` is checked against the raw value, and a blank `ror_id` is
 * a valid input that means unset.
 */
export const ROR_ID_INPUT_PATTERN = new RegExp(
  `^\\s*(?:${ROR_ID_PATTERN.source.slice(1, -1)})?\\s*$`,
);

/** The optional URI prefix a caller may wrap a ROR ID in. */
const ROR_URI_PREFIX = /^(?:https?:\/\/)?(?:www\.)?ror\.org\//;

/** The one form ORCID's `ror-org-id` index holds. */
const CANONICAL_ROR_PREFIX = 'https://ror.org/';

/** Crockford base32 digits in value order, lowercase. */
const CROCKFORD_BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Reduce an accepted ROR ID form to the one ORCID indexes: trim, strip the `ror.org/` URI
 * prefix and a trailing `/`, lowercase (Crockford base32 is case-insensitive and every ROR
 * ID is issued lowercase), and prefix `https://ror.org/`.
 *
 * @param value - A `ror_id` that matches {@link ROR_ID_PATTERN} after trimming.
 * @returns The canonical `https://ror.org/<id>` URL.
 */
export function normalizeRorId(value: string): string {
  const bare = value.trim().replace(ROR_URI_PREFIX, '');
  return `${CANONICAL_ROR_PREFIX}${(bare.endsWith('/') ? bare.slice(0, -1) : bare).toLowerCase()}`;
}

/**
 * True when `value` is a well-shaped ROR ID in any accepted caller form whose two check
 * digits match ROR's algorithm: `98 − (n × 100 mod 97)`, zero-padded, where `n` is the six
 * characters after the leading `0` decoded as Crockford base32.
 *
 * @param value - The raw `ror_id` input.
 */
export function isValidRorId(value: string): boolean {
  if (!ROR_ID_PATTERN.test(value.trim())) return false;
  const id = normalizeRorId(value).slice(CANONICAL_ROR_PREFIX.length);
  let n = 0;
  for (const char of id.slice(1, 7)) n = n * 32 + CROCKFORD_BASE32.indexOf(char);
  return String(98 - ((n * 100) % 97)).padStart(2, '0') === id.slice(7);
}
