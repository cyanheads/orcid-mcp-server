/**
 * @fileoverview Fetch peer review activity records for an ORCID researcher:
 * convening organizations, reviewer roles, review types, and ISSN-keyed groups.
 * @module mcp-server/tools/definitions/get-peer-reviews.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { orcidIdSchema } from '@/services/orcid/orcid-id.js';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';
import type { PeerReview } from '@/services/orcid/types.js';

export const orcidGetPeerReviews = tool('orcid_get_peer_reviews', {
  title: 'Get ORCID Researcher Peer Reviews',
  description:
    "Fetch peer review activity for an ORCID researcher: convening organizations (journals and publishers), reviewer role (reviewer, editor, chair, etc.), review type, completion dates, and ISSN-keyed group identifiers. Use to assess editorial activity, journal affiliations, and the scope of a researcher's peer review contributions. Peer review records are self-reported or imported by participating publishers — coverage varies by researcher.",
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    orcid_id: orcidIdSchema,
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    reviewCount: z.number().describe('Total number of peer review records returned.'),
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
                  .describe('Convening organization name (journal or publisher).'),
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
              .describe('Journal or publisher that convened the review.'),
            reviewUrl: z.string().optional().describe('URL for the review record, if available.'),
            groupIssn: z
              .string()
              .optional()
              .describe('ISSN of the journal group this review belongs to, if available.'),
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
        'Note when no peer reviews are found — coverage varies by researcher and publisher participation.',
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

    ctx.log.info('orcid_get_peer_reviews completed', {
      orcidId: bareId,
      reviewCount: reviews.length,
    });

    if (reviews.length === 0) {
      ctx.enrich.notice(
        'No peer review records found. Coverage depends on researcher self-reporting and publisher participation in ORCID peer review import.',
      );
    }

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      reviewCount: reviews.length,
      peerReviews: reviews,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Peer Reviews for ORCID ${result.orcidId}`,
      `**URI:** ${result.orcidUri}`,
      `**Total Reviews:** ${result.reviewCount}`,
    ];

    if (result.peerReviews.length === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('');
    for (const r of result.peerReviews) {
      const orgName = r.conveningOrganization?.name ?? 'Unknown organization';
      lines.push(`### ${orgName}`);
      if (r.reviewerRole) lines.push(`**Role:** ${r.reviewerRole}`);
      if (r.reviewType) lines.push(`**Type:** ${r.reviewType}`);
      if (r.completionDate) lines.push(`**Completed:** ${r.completionDate}`);
      if (r.groupIssn) lines.push(`**Journal ISSN:** ${r.groupIssn}`);
      if (r.reviewUrl) lines.push(`**URL:** ${r.reviewUrl}`);
      // Render all conveningOrganization sub-fields for format parity
      if (r.conveningOrganization?.city)
        lines.push(`**Org City:** ${r.conveningOrganization.city}`);
      if (r.conveningOrganization?.country)
        lines.push(`**Org Country:** ${r.conveningOrganization.country}`);
      if (r.conveningOrganization?.disambiguatedId) {
        lines.push(
          `**Org ID:** ${r.conveningOrganization.disambiguatedId} (${r.conveningOrganization.disambiguationSource ?? 'unknown source'})`,
        );
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
