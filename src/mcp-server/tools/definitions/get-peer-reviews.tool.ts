/**
 * @fileoverview Fetch peer review activity records for an ORCID researcher:
 * reviewer roles, review types, ISSN-keyed groups, and convening organizations. A review
 * with a journal ISSN is headed by it, since the convening organization is often the
 * service that imported the review.
 * @module mcp-server/tools/definitions/get-peer-reviews.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { deprecatedIdNotice } from '@/mcp-server/tools/deprecated-id-notice.js';
import { clampNotice, joinNotices } from '@/mcp-server/tools/notices.js';
import { SourceSchema, sourcesText } from '@/mcp-server/tools/record-sources.js';
import { singleLine } from '@/mcp-server/tools/third-party-text.js';
import { orcidIdSchema } from '@/services/orcid/orcid-id.js';
import {
  getOrcidService,
  normalizeOrcidId,
  type RecordResult,
} from '@/services/orcid/orcid-service.js';
import type { PeerReview } from '@/services/orcid/types.js';

/** Most reviews one page returns; a larger `limit` is clamped to it with a notice. */
const MAX_LIMIT = 1000;

/** The Markdown `format()` renders for one review, trailing newline included. */
function renderReview(
  r: z.infer<typeof orcidGetPeerReviews.output>['peerReviews'][number],
): string {
  const org = r.conveningOrganization;
  const lines = [
    r.groupIssn
      ? `### Journal ISSN ${singleLine(r.groupIssn)}`
      : `### ${singleLine(org?.name ?? 'Unknown organization')}`,
  ];
  if (r.groupIssn && org?.name) lines.push(`**Convening organization:** ${singleLine(org.name)}`);
  if (r.reviewerRole) lines.push(`**Role:** ${r.reviewerRole}`);
  if (r.reviewType) lines.push(`**Type:** ${r.reviewType}`);
  if (r.completionDate) lines.push(`**Completed:** ${r.completionDate}`);
  if (r.reviewUrl) lines.push(`**URL:** ${singleLine(r.reviewUrl)}`);
  const sources = sourcesText(r.sources);
  if (sources) lines.push(`**Sources:** ${sources}`);
  if (org?.city) lines.push(`**Org City:** ${singleLine(org.city)}`);
  if (org?.country) lines.push(`**Org Country:** ${org.country}`);
  if (org?.disambiguatedId)
    lines.push(
      `**Org ID:** ${singleLine(org.disambiguatedId)} (${singleLine(org.disambiguationSource ?? 'unknown source')})`,
    );
  return `${lines.join('\n')}\n`;
}

/** The page header `format()` renders. */
function renderHeader(result: {
  orcidId: string;
  orcidUri: string;
  reviewCount: number;
  totalCount: number;
  offset: number;
  nextOffset?: number | undefined;
  truncated: boolean;
}): string[] {
  return [
    `## Peer Reviews for ORCID ${result.orcidId}`,
    `**URI:** ${result.orcidUri}`,
    `**Total Reviews:** ${result.totalCount}`,
    `**Returned:** ${result.reviewCount} (offset ${result.offset})`,
    `**Truncated:** ${result.truncated ? 'Yes' : 'No'}`,
    ...(result.nextOffset !== undefined ? [`**Next Offset:** ${result.nextOffset}`] : []),
  ];
}

export const orcidGetPeerReviews = tool('orcid_get_peer_reviews', {
  title: 'Get ORCID Researcher Peer Reviews',
  description:
    "Fetch peer review activity for an ORCID researcher: reviewer role (reviewer, editor, chair, etc.), review type, completion dates, ISSN-keyed group identifiers, and the convening organization as ORCID records it — often the service that imported the review (e.g. Publons, Clarivate). ORCID returns no journal name; groupIssn is the key to the journal, and a review that has one is headed by it. Use to assess editorial activity, journal affiliations, and the scope of a researcher's peer review contributions. Reviews come from the researcher or from member organizations that import them; sources names who added each, and coverage varies by researcher.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    orcid_id: orcidIdSchema,
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based review offset; continue with nextOffset.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(25)
      .describe('Reviews per page. Default 25; a larger value returns at most 1,000 and says so.'),
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    reviewCount: z.number().describe('Total number of peer review records returned.'),
    totalCount: z.number().describe('Total reviews before pagination.'),
    offset: z.number().describe('Zero-based offset applied to this page.'),
    nextOffset: z
      .number()
      .optional()
      .describe('First omitted review offset; absent on final, empty, or past-end pages.'),
    truncated: z.boolean().describe('True when more reviews remain after this page.'),
    peerReviews: z
      .array(
        z
          .object({
            reviewerRole: z
              .string()
              .optional()
              .describe(
                'Reviewer role (e.g. reviewer, editor, chair, organizer, co-investigator, co-reviewer).',
              ),
            reviewType: z
              .string()
              .optional()
              .describe('Review type (e.g. review, evaluation, grant-review, editor-report).'),
            completionDate: z
              .string()
              .optional()
              .describe('Completion date of the review (YYYY, YYYY-MM, or YYYY-MM-DD).'),
            conveningOrganization: z
              .object({
                name: z
                  .string()
                  .optional()
                  .describe(
                    'Convening organization name as ORCID records it — often the service that imported the review (e.g. Publons).',
                  ),
                city: z.string().optional().describe('Convening organization city.'),
                country: z.string().optional().describe('Convening organization country.'),
                disambiguatedId: z
                  .string()
                  .optional()
                  .describe('Disambiguated organization identifier.'),
                disambiguationSource: z
                  .string()
                  .optional()
                  .describe('Source of disambiguation (ROR, GRID, RINGGOLD, etc.).'),
              })
              .optional()
              .describe(
                'Organization ORCID records as convening the review, often the importing service. Identify the journal by groupIssn.',
              ),
            reviewUrl: z.string().optional().describe('URL for the review record, if available.'),
            groupIssn: z
              .string()
              .optional()
              .describe(
                'ISSN of the journal group this review belongs to, if available — the key to the journal name, which ORCID does not return.',
              ),
            sources: z
              .array(SourceSchema)
              .describe(
                'The party that added this review to the ORCID record — the researcher, or a member organization such as a review-import service or publisher. Empty when ORCID records no source.',
              ),
          })
          .describe('Peer review record.'),
      )
      .describe('Peer review records for this ORCID iD.'),
  }),

  // Agent-facing context: empty-result notice surfaces in structuredContent and content[]
  // without occupying the domain return.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Deprecated-iD disclosure naming the primary iD, requested/effective limit disclosure, past-end guidance, or empty-history guidance.',
      ),
  },

  errors: [
    {
      reason: 'profile_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The ORCID iD does not correspond to a registered researcher.',
      recovery:
        'Verify the ORCID iD is correct and try orcid_search_researchers to find valid iDs.',
    },
  ],

  async handler(input, ctx) {
    const service = getOrcidService();
    ctx.log.info('orcid_get_peer_reviews', { orcidId: input.orcid_id });

    let record: RecordResult<PeerReview[]>;
    try {
      record = await service.getPeerReviews(input.orcid_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'profile_not_found',
          `ORCID iD ${normalizeOrcidId(input.orcid_id)} not found`,
        );
      }
      throw err;
    }
    const { orcidId: bareId, data: reviews } = record;
    const orcidUri = `https://orcid.org/${bareId}`;
    const totalCount = reviews.length;
    const limit = Math.min(input.limit, MAX_LIMIT);
    const peerReviews = reviews.slice(input.offset, input.offset + limit);
    const endOffset = input.offset + peerReviews.length;
    const truncated = endOffset < totalCount;

    // One notice per call, in a fixed order: deprecation, clamp, then past-end or empty history.
    const notice = joinNotices(
      deprecatedIdNotice(normalizeOrcidId(input.orcid_id), bareId),
      clampNotice('limit', input.limit, limit, 'reviews'),
      totalCount === 0
        ? 'No peer review records found. Reviews reach ORCID from the researcher or from member organizations that import them, so coverage varies; absence does not mean no review activity.'
        : input.offset >= totalCount &&
            `Offset ${input.offset} exceeds totalCount (${totalCount}). Reduce offset to page through the reviews.`,
    );

    ctx.log.info('orcid_get_peer_reviews completed', {
      orcidId: bareId,
      reviewCount: reviews.length,
    });

    if (notice) ctx.enrich.notice(notice);

    return {
      orcidId: bareId,
      orcidUri,
      reviewCount: peerReviews.length,
      totalCount,
      offset: input.offset,
      ...(truncated && { nextOffset: endOffset }),
      truncated,
      peerReviews,
    };
  },

  format: (result) => {
    const lines = renderHeader(result);

    if (result.peerReviews.length === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('');
    lines.push(...result.peerReviews.map(renderReview));

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
