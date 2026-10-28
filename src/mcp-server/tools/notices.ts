/**
 * @fileoverview Helpers the record and search tools share to compose the single `notice`
 * enrichment a call carries.
 * @module mcp-server/tools/notices
 */

/** The non-empty parts joined into one notice, in the order given; an empty string when none. */
export function joinNotices(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Notice naming a page-size input a call reduced to its cap, e.g. `Requested limit 5000;
 * effective cap 1000 works.`; an empty string when `requested` is within `cap`.
 */
export function clampNotice(param: string, requested: number, cap: number, unit: string): string {
  return requested > cap ? `Requested ${param} ${requested}; effective cap ${cap} ${unit}.` : '';
}
