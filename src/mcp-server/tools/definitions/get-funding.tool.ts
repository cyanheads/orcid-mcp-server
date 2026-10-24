/**
 * @fileoverview Fetch funding records for a researcher from ORCID: grants, contracts,
 * awards, and salary awards with funder names, grant numbers, and funding periods.
 * @module mcp-server/tools/definitions/get-funding.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { SourceSchema, sourcesText } from '@/mcp-server/tools/record-sources.js';
import { jsonBytes, RESPONSE_BYTE_BUDGET } from '@/mcp-server/tools/response-budget.js';
import { singleLine } from '@/mcp-server/tools/third-party-text.js';
import { orcidIdSchema } from '@/services/orcid/orcid-id.js';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';
import type { FundingRecord } from '@/services/orcid/types.js';

const FundingOutputSchema = z.object({
  orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
  orcidUri: z.string().describe('Full ORCID URI.'),
  view: z
    .enum(['summary', 'detail'])
    .default('summary')
    .describe('Grouped summaries or one selected deposit.'),
  budgetOverflow: z
    .string()
    .optional()
    .describe(
      'Explicit exception when metadata or one indivisible code point exceeds the 64,000-byte detail budget.',
    ),
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
            .describe('Exact deposited description page, including its original line endings.'),
          descriptionOffset: z
            .number()
            .optional()
            .describe('Starting Unicode code-point offset of this description page.'),
          descriptionLength: z
            .number()
            .optional()
            .describe('Full deposited description length in Unicode code points.'),
          nextDescriptionOffset: z
            .number()
            .optional()
            .describe(
              'First omitted code point; pass as description_offset with the same put_code.',
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
    'List funding for an ORCID researcher, or supply a summary putCode as put_code to fetch one deposited award. Summary returns one preferred record per grant group with all sources and distinct periods. Detail returns that deposit alone with its own source, optional exact decimal amount and currency, URL, and deposited description. Continue description text by passing nextDescriptionOffset as description_offset with the same put_code; offsets count Unicode code points. Complete detail surfaces fit 64,000 bytes, with explicit metadata or single-code-point overflow exceptions. Funding records are sparse; absence does not imply no funding.',
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
    description_offset: z
      .number()
      .int()
      .nonnegative()
      .safe()
      .optional()
      .describe(
        'Unicode code-point offset into the deposited description, default 0; requires put_code.',
      ),
  }),

  output: FundingOutputSchema,

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
      reason: 'detail_required',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'description_offset is provided without a funding selector.',
      recovery:
        'Supply put_code from orcid_get_funding summaries to page a selected description, or omit description_offset.',
    },
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

    if (input.put_code === undefined && input.description_offset !== undefined)
      throw ctx.fail('detail_required');
    if (input.put_code !== undefined) {
      let detail: FundingRecord;
      try {
        detail = await service.getFundingDetail(input.orcid_id, input.put_code, ctx);
      } catch (error) {
        if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound)
          throw ctx.fail('funding_not_found');
        if (error instanceof McpError && error.code === JsonRpcErrorCode.Forbidden)
          throw ctx.fail('funding_inaccessible');
        throw error;
      }
      const bareId = normalizeOrcidId(input.orcid_id);
      const offset = input.description_offset ?? 0;
      const { description, ...metadata } = detail;
      const codePoints = description === undefined ? undefined : Array.from(description);
      const remaining = codePoints?.slice(offset) ?? [];
      const page = (count: number, budgetOverflow?: string): FundingResult => ({
        orcidId: bareId,
        orcidUri: `https://orcid.org/${bareId}`,
        view: 'detail',
        fundingCount: 1,
        ...(budgetOverflow && { budgetOverflow }),
        funding: [
          {
            ...metadata,
            ...(codePoints !== undefined && {
              description: remaining.slice(0, count).join(''),
              descriptionOffset: offset,
              descriptionLength: codePoints.length,
              ...(offset + count < codePoints.length && { nextDescriptionOffset: offset + count }),
            }),
          },
        ],
      });
      const fits = (value: FundingResult) =>
        jsonBytes(value) <= RESPONSE_BYTE_BUDGET &&
        jsonBytes(renderFunding(value)) <= RESPONSE_BYTE_BUDGET;
      if (fits(page(remaining.length))) return page(remaining.length);
      let low = 0;
      let high = remaining.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(page(middle))) low = middle;
        else high = middle - 1;
      }
      if (low > 0) return page(low);
      return page(
        Math.min(remaining.length, 1),
        remaining.length
          ? 'Award metadata and one indivisible description code point exceed the 64,000-byte budget; one code point is returned to advance continuation.'
          : 'Award metadata exceeds the 64,000-byte budget; no description text remains.',
      );
    }

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
    ...(result.budgetOverflow ? [`**Budget exception:** ${result.budgetOverflow}`] : []),
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
    if (f.description !== undefined) {
      lines.push(
        `**Description offset:** ${f.descriptionOffset}`,
        `**Description length:** ${f.descriptionLength}`,
        `**Description (JSON string):** ${JSON.stringify(f.description)}`,
      );
    }
    if (f.nextDescriptionOffset !== undefined)
      lines.push(`**Next description offset:** ${f.nextDescriptionOffset}`);
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
