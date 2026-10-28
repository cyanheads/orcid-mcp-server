/**
 * @fileoverview Fetch funding records for a researcher from ORCID: grants, contracts,
 * awards, and salary awards with funder names, grant numbers, and funding periods.
 * @module mcp-server/tools/definitions/get-funding.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { deprecatedIdNotice } from '@/mcp-server/tools/deprecated-id-notice.js';
import { joinNotices } from '@/mcp-server/tools/notices.js';
import { SourceSchema, sourcesText } from '@/mcp-server/tools/record-sources.js';
import { singleLine } from '@/mcp-server/tools/third-party-text.js';
import { orcidIdSchema } from '@/services/orcid/orcid-id.js';
import {
  getOrcidService,
  normalizeOrcidId,
  type RecordResult,
} from '@/services/orcid/orcid-service.js';
import type { FundingRecord } from '@/services/orcid/types.js';

const FundingOutputSchema = z.object({
  orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
  orcidUri: z.string().describe('Full ORCID URI.'),
  view: z
    .enum(['summary', 'detail'])
    .default('summary')
    .describe('Grouped summaries or one selected deposit.'),
  fundingCount: z
    .number()
    .describe('Number of funding items returned: one per group in summary, one deposit in detail.'),
  funding: z
    .array(
      z
        .object({
          putCode: z
            .number()
            .optional()
            .describe(
              'Preferred summary or selected deposit put-code; pass as put_code for detail.',
            ),
          description: z
            .string()
            .optional()
            .describe(
              'Deposited description, whole and exact, including its original line endings. Detail view only.',
            ),
          amount: z
            .object({
              value: z
                .string()
                .optional()
                .describe('Exact deposited decimal text; no numeric conversion.'),
              currency: z.string().optional().describe('Deposited currency code, when present.'),
            })
            .optional()
            .describe('Deposited amount and currency; missing values are not inferred.'),
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
              "The parties that added the funding item: every distinct group source in summary, the selected deposit's own source in detail. Empty when ORCID records no source.",
            ),
        })
        .describe('One preferred funding group summary or the selected deposit detail.'),
    )
    .describe('Funding group summaries or one selected funding deposit.'),
});

export const orcidGetFunding = tool('orcid_get_funding', {
  title: 'Get ORCID Researcher Funding',
  description:
    'List funding for an ORCID researcher, or supply a summary putCode as put_code to fetch one deposited award. Summary returns one preferred record per grant group with all sources and distinct periods. Detail returns that deposit alone with its own source, optional exact decimal amount and currency, URL, and its whole deposited description (ORCID caps it at 5,000 characters). Funding records are sparse; absence does not imply no funding.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    orcid_id: orcidIdSchema,
    put_code: z
      .number()
      .int()
      .positive()
      .safe()
      .optional()
      .describe('Selected deposit putCode from a funding summary. Omit to list grouped summaries.'),
  }),

  output: FundingOutputSchema,

  // Agent-facing context: empty-result notice surfaces in structuredContent and content[]
  // without occupying the domain return.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Note when no funding is found — absence of records does not mean absence of funding — or when a deprecated iD was served from its primary iD.',
      ),
  },

  errors: [
    {
      reason: 'funding_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The selected funding deposit is unavailable at this ORCID iD.',
      recovery:
        'Call orcid_get_funding without put_code to list current summaries, then select a returned putCode as put_code.',
    },
    {
      reason: 'funding_inaccessible',
      code: JsonRpcErrorCode.Forbidden,
      when: 'ORCID denies public access to the selected funding deposit.',
      recovery:
        'Omit put_code to list publicly visible summaries and choose an accessible deposit; a private deposit cannot be read through the Public API.',
    },
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

    const requestedId = normalizeOrcidId(input.orcid_id);
    if (input.put_code !== undefined) {
      let record: RecordResult<FundingRecord>;
      try {
        record = await service.getFundingDetail(input.orcid_id, input.put_code, ctx);
      } catch (error) {
        if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound)
          throw ctx.fail('funding_not_found');
        if (error instanceof McpError && error.code === JsonRpcErrorCode.Forbidden)
          throw ctx.fail('funding_inaccessible');
        throw error;
      }
      const { orcidId: bareId, data: detail } = record;
      const notice = deprecatedIdNotice(requestedId, bareId);
      if (notice) ctx.enrich.notice(notice);
      return {
        orcidId: bareId,
        orcidUri: `https://orcid.org/${bareId}`,
        view: 'detail' as const,
        fundingCount: 1,
        funding: [detail],
      };
    }

    let record: RecordResult<FundingRecord[]>;
    try {
      record = await service.getFundings(input.orcid_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('profile_not_found', `ORCID iD ${requestedId} not found`);
      }
      throw err;
    }
    const { orcidId: bareId, data: records } = record;

    ctx.log.info('orcid_get_funding completed', { orcidId: bareId, fundingCount: records.length });

    const notice = joinNotices(
      deprecatedIdNotice(requestedId, bareId),
      records.length === 0 &&
        'No funding records found. Funding reaches ORCID from the researcher or from member organizations, and most records carry none. Absence does not imply no funding.',
    );
    if (notice) ctx.enrich.notice(notice);

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      view: 'summary' as const,
      fundingCount: records.length,
      funding: records,
    };
  },

  format: (result) => renderFunding(result),
});

type FundingResult = z.output<typeof FundingOutputSchema>;

/** Render every funding field; description is a JSON scalar to preserve original line endings. */
function renderFunding(result: FundingResult): { type: 'text'; text: string }[] {
  const lines: string[] = [
    `## Funding for ORCID ${result.orcidId}`,
    `**URI:** ${result.orcidUri}`,
    `**View:** ${result.view}`,
    `**Total Funding Records:** ${result.fundingCount}`,
  ];

  if (result.funding.length === 0) {
    return [{ type: 'text', text: lines.join('\n') }];
  }

  lines.push('');
  for (const f of result.funding) {
    lines.push(`### ${singleLine(f.title ?? '(untitled funding)')}`);
    if (f.putCode !== undefined) lines.push(`**Put-code:** ${f.putCode}`);
    if (f.amount?.value !== undefined) lines.push(`**Amount:** ${f.amount.value}`);
    if (f.amount?.currency !== undefined) lines.push(`**Currency:** ${f.amount.currency}`);
    if (f.description !== undefined)
      lines.push(`**Description (JSON string):** ${JSON.stringify(f.description)}`);
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
}
