/**
 * @fileoverview How a record tool reports a deprecated (merged) ORCID iD: the notice naming
 * both iDs, the `/person` merge check the endpoints ORCID never redirects rely on, and the
 * sentence an answer opens with when that check could not run.
 * @module mcp-server/tools/deprecated-id-notice
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { OrcidService } from '@/services/orcid/orcid-service.js';

/**
 * Longest the merge check waits once the request it follows has answered. The call's own
 * deadline still caps it, so a hung `/person` delays a ready answer by at most this long.
 */
const MERGE_CHECK_MAX_WAIT_MS = 10_000;

/**
 * Notice naming both iDs when `orcidId`, the iD the record was served under, differs from the
 * canonical `requestedId`; an empty string otherwise. Both are validated ORCID iDs (digits,
 * hyphens, and `X`), so neither needs Markdown escaping.
 */
export function deprecatedIdNotice(requestedId: string, orcidId: string): string {
  return requestedId === orcidId
    ? ''
    : `ORCID iD ${requestedId} is deprecated: ORCID merged it into ${orcidId}, and this response reports that primary record. Use ${orcidId} in later calls.`;
}

/**
 * What `/person` said about an iD: `answered` with the iD ORCID serves the record under (a
 * merged iD's primary), `not_found` for a 404, or `failed` for anything else, the wait bound
 * and a request the call deadline left no time for included.
 */
export type MergeCheck =
  | { status: 'answered'; orcidId: string }
  | { status: 'not_found' }
  | { status: 'failed' };

/**
 * Ask `/person`, which redirects a merged iD, whether `requestedId` was merged into another
 * iD. Used where ORCID answers a merged iD empty or not-found instead of redirecting it. Waits
 * at most {@link MERGE_CHECK_MAX_WAIT_MS} and never past the call deadline. Rethrows the
 * caller's cancellation; every other failure but a 404 is logged and returned as `failed`.
 */
export async function checkMerge(
  service: Pick<OrcidService, 'getPerson'>,
  requestedId: string,
  ctx: Context,
): Promise<MergeCheck> {
  try {
    const person = await service.getPerson(requestedId, ctx, {
      maxWaitMs: MERGE_CHECK_MAX_WAIT_MS,
    });
    return { status: 'answered', orcidId: person.orcidId };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound)
      return { status: 'not_found' };
    ctx.log.warning('Merge check on /person failed; returning the answer unconfirmed.', {
      orcidId: requestedId,
    });
    return { status: 'failed' };
  }
}

/** What each answer a failed merge check leaves standing calls unconfirmed. */
const UNCONFIRMED = {
  'empty-summary': 'its existence and this empty result are unconfirmed',
  'unresolved-works': 'the put-codes that did not resolve are unconfirmed',
  'missing-allocation': 'this not-found answer is unconfirmed',
} as const;

/**
 * The sentence an answer opens with when its merge check `failed`: it names the requested iD,
 * says the check could not run and what that leaves unconfirmed, and tells the caller to call
 * again. `requestedId` is a validated ORCID iD, so it needs no Markdown escaping.
 */
export function mergeCheckFailedNotice(
  requestedId: string,
  answer: keyof typeof UNCONFIRMED,
): string {
  return `ORCID iD ${requestedId} could not be checked for a merge into another iD, so ${UNCONFIRMED[answer]}; call again before relying on this answer.`;
}
