/**
 * @fileoverview Shared ORCID iD parsing and validation. Combines the visible-shape
 * regex, ISO/IEC 7064:2003 MOD 11-2 check-digit verification, and canonicalization
 * (URI prefix, trailing slash, check-digit case) in one place so every tool and
 * resource validates an ORCID iD identically — and rejects a checksum-invalid iD
 * locally, before any upstream call.
 * @module services/orcid/orcid-id
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * Every caller form of an ORCID iD a tool accepts: the hyphenated iD, optionally after
 * `orcid.org/` (with an optional `http(s)://` scheme and `www.` host), with an optional
 * trailing `/`. The check digit may be `X` or `x`. Scheme and host stay lowercase and the
 * pattern carries no flags, because Zod drops regex flags from the emitted JSON Schema.
 * Check digit is verified separately.
 */
const ORCID_ID_PATTERN =
  /^(?:(?:https?:\/\/)?(?:www\.)?orcid\.org\/)?\d{4}-\d{4}-\d{4}-\d{3}[\dXx]\/?$/;

/**
 * The bare iD alone, for resource URI params: a URI segment cannot carry `/` and the
 * resource template matcher does not percent-decode it, so no prefixed form arrives there.
 */
const BARE_ORCID_ID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[\dXx]$/;

/** The optional URI prefix a caller may wrap the iD in. */
const ORCID_URI_PREFIX = /^(?:https?:\/\/)?(?:www\.)?orcid\.org\//;

const SHAPE_MESSAGE = 'Must be a valid ORCID iD (e.g. 0000-0001-2345-6789) or full ORCID URI.';

/**
 * Reduce any accepted caller form to the canonical bare iD the ORCID API serves:
 * trim, strip the `orcid.org/` URI prefix and a trailing `/`, and uppercase the check
 * digit (the Public API answers 404 for a lowercase `x`).
 */
export function normalizeOrcidId(id: string): string {
  const bare = id.trim().replace(ORCID_URI_PREFIX, '');
  return (bare.endsWith('/') ? bare.slice(0, -1) : bare).toUpperCase();
}

/**
 * Compute the ISO/IEC 7064:2003 MOD 11-2 check character over the first 15 digits
 * of a bare ORCID iD. Returns the expected final character ('0'–'9', or 'X' for 10).
 */
function computeCheckDigit(bareId: string): string {
  const base = bareId.replace(/-/g, '').slice(0, 15);
  let total = 0;
  for (const char of base) {
    total = (total + Number(char)) * 2;
  }
  const result = (12 - (total % 11)) % 11;
  return result === 10 ? 'X' : String(result);
}

/**
 * True when `id` is a well-shaped ORCID iD in any accepted caller form whose ISO 7064
 * check digit matches. Rejects checksum-invalid iDs such as `0000-0000-0000-0000`.
 */
export function isValidOrcidId(id: string): boolean {
  if (!ORCID_ID_PATTERN.test(id.trim())) return false;
  const bare = normalizeOrcidId(id);
  return bare.slice(-1) === computeCheckDigit(bare);
}

/**
 * Reusable Zod schema for an `orcid_id` tool input. Trims, then the regex rejects
 * malformed strings (and emits a JSON-Schema `pattern`) and aborts, so the refine —
 * which rejects a well-shaped iD with an invalid ISO 7064 check digit — reports only on
 * a well-shaped value. Both run at parse time, so a bad iD fails local validation before
 * any handler or upstream request. Handlers canonicalize with {@link normalizeOrcidId}.
 */
export const orcidIdSchema = z
  .string()
  .trim()
  .regex(ORCID_ID_PATTERN, { message: SHAPE_MESSAGE, abort: true })
  .refine(isValidOrcidId, {
    message:
      'The ORCID iD is invalid — its ISO 7064 check digit does not match. Verify the iD and try again.',
  })
  .describe(
    'ORCID iD — bare (0000-0001-2345-6789) or as an orcid.org URI (https://orcid.org/0000-0001-2345-6789). The check digit may be X or x.',
  );

/**
 * Regex-only, bare-only variant of {@link orcidIdSchema} for resource URI params:
 * validates the visible shape (and emits a JSON-Schema `pattern`) but omits the
 * check-digit refine. A resource param carries no place to attach the refine's custom
 * message — so handlers pair this with an explicit `isValidOrcidId` check on the
 * canonical iD that throws a clear `InvalidParams` naming it, matching the tool route
 * and running before any upstream call. Tools keep {@link orcidIdSchema}: the SDK
 * validates their full schema (refine included) and rejects a bad check digit as
 * `InvalidParams` before the handler runs.
 */
export const orcidIdParamSchema = z
  .string()
  .regex(BARE_ORCID_ID_PATTERN, 'Must be a bare ORCID iD (e.g. 0000-0001-2345-6789).')
  .describe('ORCID iD in bare format (0000-0001-2345-6789). The check digit may be X or x.');
