/**
 * @fileoverview Fetch funding records for a researcher from ORCID: grants, contracts,
 * awards, and salary awards with funder names, grant numbers, and funding periods.
 * @module mcp-server/tools/definitions/get-funding.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';
import type { FundingRecord } from '@/services/orcid/types.js';

export const orcidGetFunding = tool('orcid_get_funding', {
  title: 'Get ORCID Researcher Funding',
  description:
    'Fetch funding records for an ORCID researcher: grants, contracts, awards, and salary awards. Returns funder names, funder organization identifiers, grant numbers, and funding periods. Funding data is entirely self-reported — most researchers do not enter funding even when they have grants. Absence of funding records does not imply absence of funding. When records exist they are high-value for grant tracking and funder analysis.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    orcid_id: z
      .string()
      .regex(
        /^(https?:\/\/orcid\.org\/)?\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/,
        'Must be a valid ORCID iD (e.g. 0000-0001-2345-6789) or full ORCID URI.',
      )
      .describe(
        'ORCID iD — bare format (0000-0001-2345-6789) or full URI (https://orcid.org/0000-0001-2345-6789).',
      ),
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    fundingCount: z.number().describe('Total number of funding records returned.'),
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
          })
          .describe('Funding record.'),
      )
      .describe('Funding records associated with this ORCID iD.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Note when no funding is found — absence of records does not mean absence of funding.',
      ),
  }),

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

    const notice =
      records.length === 0
        ? 'No funding records found. ORCID funding data is self-reported and most researchers do not enter funding details. Absence does not imply no funding.'
        : undefined;

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      fundingCount: records.length,
      funding: records,
      ...(notice && { notice }),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Funding for ORCID ${result.orcidId}`,
      `**URI:** ${result.orcidUri}`,
      `**Total Funding Records:** ${result.fundingCount}`,
    ];

    if (result.notice) {
      lines.push('', `> ${result.notice}`);
    }

    if (result.funding.length === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('');
    for (const f of result.funding) {
      const title = f.title ?? '(untitled funding)';
      lines.push(`### ${title}`);
      if (f.type) lines.push(`**Type:** ${f.type}`);
      if (f.funder?.name) lines.push(`**Funder:** ${f.funder.name}`);
      if (f.funder?.city) lines.push(`**Funder City:** ${f.funder.city}`);
      if (f.funder?.country) lines.push(`**Funder Country:** ${f.funder.country}`);
      if (f.funder?.disambiguatedId) {
        lines.push(
          `**Funder ID:** ${f.funder.disambiguatedId} (${f.funder.disambiguationSource ?? 'unknown source'})`,
        );
      }
      if (f.grantNumbers.length) lines.push(`**Grant Numbers:** ${f.grantNumbers.join(', ')}`);
      const dateRange = [f.startDate, f.endDate].filter(Boolean).join(' – ');
      if (dateRange) lines.push(`**Period:** ${dateRange}`);
      if (f.url) lines.push(`**URL:** ${f.url}`);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
