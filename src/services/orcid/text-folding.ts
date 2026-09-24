/**
 * @fileoverview Accent-insensitive text fold shared by the name and institution matching in
 * `orcid_resolve_researcher`. A record may carry the ASCII rendering of an accented name
 * ("Jose" for "José"), so both sides are folded to one comparable form before matching.
 * Mirrors the one-small-file-per-shared-concern pattern of `solr-query.ts`.
 * @module services/orcid/text-folding
 */

/** Combining diacritical marks (U+0300–U+036F) that NFKD splits off accented Latin letters. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Everything that is not a letter, a digit, or whitespace, in any script. */
const NON_WORD_CHARS = /[^\p{L}\p{N}\s]/gu;

/**
 * Fold `value` for accent-insensitive comparison: NFKD-normalize, strip the combining marks
 * that separates out, lowercase, then keep only letters, digits, and whitespace. "José" and
 * "Jose" fold identically, while non-Latin letters (CJK, Hangul, Cyrillic, Greek) survive
 * rather than being deleted. No transliteration between scripts.
 *
 * @param value - A name or institution name.
 * @returns The folded string; whitespace-only when `value` has no letters or digits.
 */
export function foldForMatching(value: string): string {
  return value
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NON_WORD_CHARS, '');
}
