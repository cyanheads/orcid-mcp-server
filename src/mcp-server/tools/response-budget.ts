/**
 * @fileoverview Byte budget for the record lists `orcid_get_works` and
 * `orcid_get_work_detail` return. Records are admitted in order while both result surfaces
 * stay within the budget — the serialized `structuredContent` and the `content[]` text — so a
 * single call cannot exceed a safe share of a model's context window however large the
 * requested page is.
 * @module mcp-server/tools/response-budget
 */

/** Ceiling on each result surface of a response, in UTF-8 bytes. */
export const RESPONSE_BYTE_BUDGET = 64_000;

/** UTF-8 byte length of `value` serialized as JSON. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Budget cost of one record: the larger of its serialized JSON and the text `format()`
 * renders for it. Charging the larger keeps both surfaces within the budget, including a
 * record whose text outweighs its JSON (an `(untitled)` heading, an `(unnamed)` contributor).
 */
export function recordCost(record: unknown, text: string): number {
  return Math.max(jsonBytes(record), Buffer.byteLength(text));
}

/**
 * Count how many leading records fit in the budget beside an envelope that already costs
 * `envelopeBytes` (the response serialized with its record arrays empty). Each record adds
 * its cost, plus one byte for the separator before every record after the first. When not
 * every record fits, the response grows by `cutReserveBytes` (fields that only a cut response
 * carries), and the prefix is sized to leave room for them. The first record is always
 * admitted, even when it alone exceeds the budget. Costs are read lazily, so records past the
 * cut are never measured.
 *
 * @param costs - Per-record costs in response order.
 * @param envelopeBytes - Bytes of everything in an uncut response except the records.
 * @param cutReserveBytes - Extra bytes a cut response carries; 0 when a cut adds nothing.
 * @returns The number of leading records to return — all of them when all fit.
 */
export function countWithinBudget(
  costs: Iterable<number>,
  envelopeBytes: number,
  cutReserveBytes = 0,
): number {
  let used = envelopeBytes;
  let fitsWhenCut = 0;
  let count = 0;
  for (const cost of costs) {
    used += cost + (count > 0 ? 1 : 0);
    if (used > RESPONSE_BYTE_BUDGET) return Math.max(fitsWhenCut, 1);
    count++;
    if (used + cutReserveBytes <= RESPONSE_BYTE_BUDGET) fitsWhenCut = count;
  }
  return count;
}
