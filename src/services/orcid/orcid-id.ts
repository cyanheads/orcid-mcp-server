/**
 * @fileoverview Shared ORCID iD parsing and validation. Combines the visible-shape
 * regex, ISO/IEC 7064:2003 MOD 11-2 check-digit verification, and URI-prefix
 * normalization in one place so every tool and resource validates an ORCID iD
 * identically — and rejects a checksum-invalid iD locally, before any upstream call.
 * @module services/orcid/orcid-id
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Bare or full-URI ORCID iD shape. Check digit is verified separately. */
const ORCID_ID_PATTERN = /^(https?:\/\/orcid\.org\/)?\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/** Strip the https://orcid.org/ prefix to get the bare 0000-0000-0000-0000 form. */
export function normalizeOrcidId(id: string): string {
  return id.replace(/^https?:\/\/orcid\.org\//, '').trim();
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
 * True when `id` is a well-shaped ORCID iD (bare or full URI) whose ISO 7064
 * check digit matches. Rejects checksum-invalid iDs such as `0000-0000-0000-0000`.
 */
export function isValidOrcidId(id: string): boolean {
  if (!ORCID_ID_PATTERN.test(id)) return false;
  const bare = normalizeOrcidId(id);
  return bare.slice(-1) === computeCheckDigit(bare);
}

/**
 * Reusable Zod schema for an `orcid_id` input/param. The regex rejects malformed
 * strings (and emits a JSON-Schema `pattern`); the refine rejects well-shaped iDs
 * with an invalid ISO 7064 check digit. Both run at parse time, so a bad iD fails
 * local validation before any handler or upstream request.
 */
export const orcidIdSchema = z
  .string()
  .regex(ORCID_ID_PATTERN, 'Must be a valid ORCID iD (e.g. 0000-0001-2345-6789) or full ORCID URI.')
  .refine(isValidOrcidId, {
    message:
      'The ORCID iD is invalid — its ISO 7064 check digit does not match. Verify the iD and try again.',
  })
  .describe(
    'ORCID iD — bare format (0000-0001-2345-6789) or full URI (https://orcid.org/0000-0001-2345-6789).',
  );

/**
 * Regex-only variant of {@link orcidIdSchema} for resource URI params: validates the
 * visible shape (and emits a JSON-Schema `pattern`) but omits the check-digit refine.
 * A resource param carries no place to attach the refine's custom message — so handlers
 * pair this with an explicit `isValidOrcidId(params.orcid_id)` check that throws a clear
 * `InvalidParams` naming the iD, matching the tool route and running before any upstream
 * call. Tools keep {@link orcidIdSchema}: the SDK validates their full schema (refine
 * included) and rejects a bad check digit as `InvalidParams` before the handler runs.
 */
export const orcidIdParamSchema = z
  .string()
  .regex(ORCID_ID_PATTERN, 'Must be a valid ORCID iD (e.g. 0000-0001-2345-6789) or full ORCID URI.')
  .describe(
    'ORCID iD — bare format (0000-0001-2345-6789) or full URI (https://orcid.org/0000-0001-2345-6789).',
  );
