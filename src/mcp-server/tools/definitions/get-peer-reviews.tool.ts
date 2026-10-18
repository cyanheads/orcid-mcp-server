/**
 * @fileoverview Fetch peer review activity records for an ORCID researcher:
 * reviewer roles, review types, ISSN-keyed groups, and convening organizations. A review
 * with a journal ISSN is headed by it, since the convening organization is often the
 * service that imported the review.
 * @module mcp-server/tools/definitions/get-peer-reviews.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { SourceSchema, sourcesText } from '@/mcp-server/tools/record-sources.js';
import {
  countWithinBudget,
  RESPONSE_BYTE_BUDGET,
  recordCost,
} from '@/mcp-server/tools/response-budget.js';
import { singleLine } from '@/mcp-server/tools/third-party-text.js';
import { orcidIdSchema } from '@/services/orcid/orcid-id.js';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';
import type { PeerReview } from '@/services/orcid/types.js';

/** Render one review identically for output and byte admission. */
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

/** Full page header, conservatively reserved with widest counters. */
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
      .default(50)
      .describe(
        'Requested page size (default 50, accepted maximum 10,000, effective maximum 1,000). Each surface is bounded to 64,000 bytes, except an indivisible oversized review returned alone with a notice.',
      ),
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
        'Empty-history guidance, requested/effective limit disclosure, or an explicit indivisible-review budget exception.',
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

    let reviews: PeerReview[];
    try {
      reviews = await service.getPeerReviews(input.orcid_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'profile_not_found',
          `ORCID iD ${normalizeOrcidId(input.orcid_id)} not found`,
        );
      }
      throw err;
    }
    const bareId = normalizeOrcidId(input.orcid_id);
    const orcidUri = `https://orcid.org/${bareId}`;
    const totalCount = reviews.length;
    const limit = Math.min(input.limit, 1000);
    const notices: string[] = [];
    if (input.limit > limit)
      notices.push(
        `Requested limit ${input.limit}; effective cap ${limit} reviews before the response byte budget.`,
      );
    if (totalCount === 0)
      notices.push(
        'No peer review records found. Reviews reach ORCID from the researcher or from member organizations that import them, so coverage varies; absence does not mean no review activity.',
      );
    const notice = notices.join(' ');
    const candidates = reviews.slice(input.offset, input.offset + limit);
    const widest = {
      orcidId: bareId,
      orcidUri,
      reviewCount: candidates.length,
      totalCount,
      offset: input.offset,
      nextOffset: totalCount,
      truncated: false,
    };
    const envelope = recordCost(
      { ...widest, peerReviews: [], ...(notice && { notice }) },
      `${renderHeader(widest).join('\n')}\n\n${notice ? `\n\n> ${notice}` : ''}`,
    );
    const peerReviews = candidates.slice(
      0,
      countWithinBudget(
        candidates.values().map((r) => recordCost(r, renderReview(r))),
        envelope,
      ),
    );
    const firstReview = peerReviews[0];
    if (
      peerReviews.length === 1 &&
      firstReview &&
      recordCost(firstReview, renderReview(firstReview)) + envelope > RESPONSE_BYTE_BUDGET
    )
      notices.push(
        'One indivisible peer review exceeds the 64,000-byte response budget and is returned alone; continuation advances past it.',
      );
    const endOffset = input.offset + peerReviews.length;
    const truncated = peerReviews.length > 0 && endOffset < totalCount;

    ctx.log.info('orcid_get_peer_reviews completed', {
      orcidId: bareId,
      reviewCount: reviews.length,
    });

    if (notices.length) ctx.enrich.notice(notices.join(' '));

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
