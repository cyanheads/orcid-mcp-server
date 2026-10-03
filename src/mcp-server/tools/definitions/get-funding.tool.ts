/**
 * @fileoverview Fetch funding records for a researcher from ORCID: grants, contracts,
 * awards, and salary awards with funder names, grant numbers, and funding periods.
 * @module mcp-server/tools/definitions/get-funding.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { SourceSchema, sourcesText } from '@/mcp-server/tools/record-sources.js';
import { singleLine } from '@/mcp-server/tools/third-party-text.js';
import { orcidIdSchema } from '@/services/orcid/orcid-id.js';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';
import type { FundingRecord } from '@/services/orcid/types.js';

export const orcidGetFunding = tool('orcid_get_funding', {
  title: 'Get ORCID Researcher Funding',
  description:
    'Fetch funding records for an ORCID researcher: grants, contracts, awards, and salary awards. Returns funder names, funder organization identifiers, grant numbers, funding periods, and sources. Funding items come from the researcher or from member organizations such as funders, institutions, and search-and-link tools; sources names who added each. Most researchers have no funding entries even when they hold grants, so absence of funding records does not imply absence of funding. When records exist they are high-value for grant tracking and funder analysis.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    orcid_id: orcidIdSchema,
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    fundingCount: z
      .number()
      .describe(
        'Number of funding items returned, one per ORCID funding group — versions of one grant added by different sources or deposited twice count once.',
      ),
    funding: z
      .array(
        z
          .object({
            title: z.string().optional().describe('Funding title or project name.'),
            type: z
              .string()
              .optional()
              .describe('Funding type (e.g. grant, contract, award, salary-award).'),
            funder: z
              .object({
                name: z.string().optional().describe('Funder organization name.'),
                city: z.string().optional().describe('Funder city.'),
                country: z.string().optional().describe('Funder country.'),
                disambiguatedId: z
                  .string()
                  .optional()
                  .describe(
                    'Disambiguated funder identifier (e.g. Crossref Funder ID URL or ROR URL).',
                  ),
                disambiguationSource: z
                  .string()
                  .optional()
                  .describe('Source of funder disambiguation (FUNDREF, ROR, GRID, etc.).'),
              })
              .optional()
              .describe('Funder organization details.'),
            startDate: z
              .string()
              .optional()
              .describe('Funding start date (YYYY, YYYY-MM, or YYYY-MM-DD).'),
            endDate: z
              .string()
              .optional()
              .describe('Funding end date (YYYY, YYYY-MM, or YYYY-MM-DD).'),
            grantNumbers: z
              .array(z.string().describe('Grant or award number.'))
              .describe('Grant numbers or award identifiers for this funding record.'),
            url: z.string().optional().describe('URL for the funding record, if available.'),
            periods: z
              .array(
                z
                  .object({
                    startDate: z
                      .string()
                      .optional()
                      .describe('Period start date (YYYY, YYYY-MM, or YYYY-MM-DD).'),
                    endDate: z
                      .string()
                      .optional()
                      .describe('Period end date (YYYY, YYYY-MM, or YYYY-MM-DD).'),
                  })
                  .describe('Award period one version of this funding item records.'),
              )
              .optional()
              .describe(
                "Every distinct award period the funding item's versions record, ordered by start date — present only when there are two or more, such as renewals under one grant number. The other fields come from ORCID's preferred version.",
              ),
            sources: z
              .array(SourceSchema)
              .describe(
                "Every party that added this funding item to the ORCID record — the researcher, a funder or institution, or a search-and-link tool — one entry per distinct source in the funding group, the preferred version's first. Empty when ORCID records no source.",
              ),
          })
          .describe('Funding item: one ORCID funding group, built from its preferred version.'),
      )
      .describe('Funding items associated with this ORCID iD, one per ORCID funding group.'),
  }),

  // Agent-facing context: empty-result notice surfaces in structuredContent and content[]
  // without occupying the domain return.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Note when no funding is found — absence of records does not mean absence of funding.',
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
    ctx.log.info('orcid_get_funding', { orcidId: input.orcid_id });

    let records: FundingRecord[];
    try {
      records = await service.getFundings(input.orcid_id, ctx);
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

    ctx.log.info('orcid_get_funding completed', { orcidId: bareId, fundingCount: records.length });

    if (records.length === 0) {
      ctx.enrich.notice(
        'No funding records found. Funding reaches ORCID from the researcher or from member organizations, and most records carry none. Absence does not imply no funding.',
      );
    }

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      fundingCount: records.length,
      funding: records,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Funding for ORCID ${result.orcidId}`,
      `**URI:** ${result.orcidUri}`,
      `**Total Funding Records:** ${result.fundingCount}`,
    ];

    if (result.funding.length === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('');
    for (const f of result.funding) {
      lines.push(`### ${singleLine(f.title ?? '(untitled funding)')}`);
      if (f.type) lines.push(`**Type:** ${f.type}`);
      if (f.funder?.name) lines.push(`**Funder:** ${singleLine(f.funder.name)}`);
      if (f.funder?.city) lines.push(`**Funder City:** ${singleLine(f.funder.city)}`);
      if (f.funder?.country) lines.push(`**Funder Country:** ${f.funder.country}`);
      if (f.funder?.disambiguatedId) {
        lines.push(
          `**Funder ID:** ${singleLine(f.funder.disambiguatedId)} (${singleLine(f.funder.disambiguationSource ?? 'unknown source')})`,
        );
      }
      if (f.grantNumbers.length) {
        lines.push(`**Grant Numbers:** ${f.grantNumbers.map(singleLine).join(', ')}`);
      }
      const dateRange = [f.startDate, f.endDate].filter(Boolean).join(' – ');
      if (dateRange) lines.push(`**Period:** ${dateRange}`);
      if (f.periods) {
        const periods = f.periods.map((p) => [p.startDate, p.endDate].filter(Boolean).join(' – '));
        lines.push(`**Periods:** ${periods.join('; ')}`);
      }
      if (f.url) lines.push(`**URL:** ${singleLine(f.url)}`);
      const sources = sourcesText(f.sources);
      if (sources) lines.push(`**Sources:** ${sources}`);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
