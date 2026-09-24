/**
 * @fileoverview Retrieve works (publications, datasets, software, preprints, etc.)
 * associated with an ORCID iD. Returns titles, types, dates, journal names, and
 * external identifiers ready for chaining to Crossref, PubMed, or arXiv. Prolific
 * records are sliced locally via offset/limit so default payloads stay compact, and every
 * page is capped by the shared response byte budget.
 * @module mcp-server/tools/definitions/get-works.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { countWithinBudget, jsonBytes, recordCost } from '@/mcp-server/tools/response-budget.js';
import { orcidIdSchema } from '@/services/orcid/orcid-id.js';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';
import type { Work } from '@/services/orcid/types.js';

const ExternalIdSchema = z
  .object({
    type: z.string().describe('Identifier type (e.g. doi, pmid, arxiv, isbn).'),
    value: z.string().describe('Identifier value.'),
    url: z.string().optional().describe('Resolver URL for this identifier, if available.'),
    relationship: z.string().optional().describe('Relationship to the work (self or part-of).'),
  })
  .describe('External identifier for a work.');

const WorkSummarySchema = z
  .object({
    putCode: z
      .number()
      .optional()
      .describe(
        'Work put-code — pass to orcid_get_work_detail to fetch the full record including abstract and contributors.',
      ),
    title: z.string().optional().describe('Work title.'),
    workType: z
      .string()
      .optional()
      .describe('Work type (e.g. journal-article, dataset, software, preprint).'),
    publicationDate: z
      .string()
      .optional()
      .describe('Publication date (YYYY, YYYY-MM, or YYYY-MM-DD).'),
    journalTitle: z.string().optional().describe('Journal or container title.'),
    url: z.string().optional().describe('URL for the work, if available.'),
    externalIds: z
      .array(ExternalIdSchema)
      .optional()
      .describe(
        'External identifiers (DOIs, PMIDs, arXiv IDs, ISBNs, etc.). Omitted when include_external_ids is false.',
      ),
  })
  .describe('Work summary record.');

/** The Markdown `format()` renders for one work, trailing blank line included. */
function renderWork(w: z.infer<typeof WorkSummarySchema>): string {
  const lines = [`### ${w.title ?? '(untitled)'}`];
  if (w.putCode != null) lines.push(`**Put-code:** ${w.putCode}`);
  if (w.workType) lines.push(`**Type:** ${w.workType}`);
  if (w.publicationDate) lines.push(`**Date:** ${w.publicationDate}`);
  if (w.journalTitle) lines.push(`**Journal:** ${w.journalTitle}`);
  if (w.url) lines.push(`**URL:** ${w.url}`);
  if (w.externalIds?.length) {
    const idParts = w.externalIds.map((id) => {
      const rel = id.relationship ? ` [${id.relationship}]` : '';
      const urlPart = id.url ? ` (${id.url})` : '';
      return `${id.type}:${id.value}${urlPart}${rel}`;
    });
    lines.push(`**IDs:** ${idParts.join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

export const orcidGetWorks = tool('orcid_get_works', {
  title: 'Get ORCID Researcher Works',
  description:
    'Retrieve works associated with an ORCID iD — publications, datasets, software, preprints, and more. Returns work summaries with put-codes, titles, types, publication dates, journal names, and all external identifiers (DOIs, PMIDs, arXiv IDs, ISBNs). The first 50 works are returned by default; workCount reports the total available, and prolific records are paged with offset and the returned nextOffset (or raise limit). A page also stops early once the response reaches its 64,000-byte budget, so returnedCount can come in below limit; truncated and nextOffset then carry the continuation. Set include_external_ids to false to omit identifier lists for a lighter payload. Pass the putCode from each work to orcid_get_work_detail to retrieve the full record including abstract and contributors. External IDs are ready for chaining to Crossref, PubMed, or arXiv servers. Works are self-reported; a researcher may not have linked all their publications.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    orcid_id: orcidIdSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(50)
      .describe(
        'Maximum works to return in this response (default 50, max 1000). The full list is sliced locally — page prolific records with offset and the returned nextOffset. A page stops early at the 64,000-byte response budget, so a large limit may return fewer works.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first work to return (default 0). Combine with limit to page through the full works list.',
      ),
    include_external_ids: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), each work carries its external identifiers (DOIs, PMIDs, arXiv IDs, ISBNs). Set false to omit them for a lighter payload when only titles, types, and dates are needed.',
      ),
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    workCount: z
      .number()
      .describe('Total works available for this ORCID iD, before offset and limit are applied.'),
    returnedCount: z
      .number()
      .describe(
        'Number of works returned in this response, after applying offset, limit, and the 64,000-byte response budget.',
      ),
    offset: z
      .number()
      .describe('Zero-based offset applied to the full works list for this response.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call to continue paging. Omitted when this response includes the final work.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when more works are available beyond this response, whether limit or the response budget ended the page — fetch them with nextOffset.',
      ),
    works: z
      .array(WorkSummarySchema)
      .describe(
        'Works for this ORCID iD, sliced to the requested offset and limit and to the response budget.',
      ),
  }),

  // Agent-facing context: empty-result notice surfaces in structuredContent and content[]
  // without occupying the domain return.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Note when the works list is empty — may indicate no self-reported works or private visibility settings.',
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
    ctx.log.info('orcid_get_works', {
      orcidId: input.orcid_id,
      limit: input.limit,
      offset: input.offset,
    });

    let allWorks: Work[];
    try {
      allWorks = await service.getWorks(input.orcid_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'profile_not_found',
          `ORCID iD ${normalizeOrcidId(input.orcid_id)} not found`,
          { ...ctx.recoveryFor('profile_not_found') },
        );
      }
      throw err;
    }
    const bareId = normalizeOrcidId(input.orcid_id);
    const orcidUri = `https://orcid.org/${bareId}`;
    const workCount = allWorks.length;

    const page = allWorks.slice(input.offset, input.offset + input.limit).map((w) => {
      const { externalIds, ...rest } = w;
      return input.include_external_ids ? { ...rest, externalIds } : rest;
    });
    // Envelope sized for its widest counters, so the page never overshoots the budget.
    const envelopeBytes = jsonBytes({
      orcidId: bareId,
      orcidUri,
      workCount,
      returnedCount: page.length,
      offset: input.offset,
      nextOffset: workCount,
      truncated: false,
      works: [],
    });
    const works = page.slice(
      0,
      countWithinBudget(
        page.values().map((w) => recordCost(w, renderWork(w))),
        envelopeBytes,
      ),
    );
    const returnedCount = works.length;
    const endOffset = input.offset + returnedCount;
    const truncated = endOffset < workCount;

    ctx.log.info('orcid_get_works completed', {
      orcidId: bareId,
      workCount,
      returnedCount,
      truncated,
    });

    if (workCount === 0) {
      ctx.enrich.notice(
        'No works found. The researcher may not have linked works to their ORCID record, or works may be set to private visibility.',
      );
    }

    return {
      orcidId: bareId,
      orcidUri,
      workCount,
      returnedCount,
      offset: input.offset,
      ...(truncated && { nextOffset: endOffset }),
      truncated,
      works,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Works for ORCID ${result.orcidId}`,
      `**URI:** ${result.orcidUri}`,
      `**Total Works:** ${result.workCount}`,
      `**Returned:** ${result.returnedCount} (offset ${result.offset})`,
      `**Truncated:** ${result.truncated ? 'Yes' : 'No'}`,
    ];
    if (result.nextOffset != null) lines.push(`**Next Offset:** ${result.nextOffset}`);
    if (result.works.length > 0) lines.push('', ...result.works.map(renderWork));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
