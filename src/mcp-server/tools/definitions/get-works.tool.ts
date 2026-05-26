/**
 * @fileoverview Retrieve works (publications, datasets, software, preprints, etc.)
 * associated with an ORCID iD. Returns titles, types, dates, journal names, and
 * external identifiers ready for chaining to Crossref, PubMed, or arXiv.
 * @module mcp-server/tools/definitions/get-works.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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

export const orcidGetWorks = tool('orcid_get_works', {
  title: 'Get ORCID Researcher Works',
  description:
    'Retrieve works associated with an ORCID iD — publications, datasets, software, preprints, and more. Returns work summaries with titles, types, publication dates, journal names, and all external identifiers (DOIs, PMIDs, arXiv IDs, ISBNs). External IDs are ready for chaining to Crossref, PubMed, or arXiv servers. The /works endpoint returns summaries only — pass DOIs to Crossref or PMIDs to PubMed to retrieve full metadata or abstracts. Works are self-reported; a researcher may not have linked all their publications.',
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
    workCount: z.number().describe('Total number of works returned.'),
    works: z
      .array(
        z
          .object({
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
              .describe('External identifiers (DOIs, PMIDs, arXiv IDs, ISBNs, etc.).'),
          })
          .describe('Work summary record.'),
      )
      .describe('Works associated with this ORCID iD.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Note when the works list is empty — may indicate no self-reported works or private visibility settings.',
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
    ctx.log.info('orcid_get_works', { orcidId: input.orcid_id });

    let works: Work[];
    try {
      works = await service.getWorks(input.orcid_id, ctx);
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

    ctx.log.info('orcid_get_works completed', { orcidId: bareId, workCount: works.length });

    const notice =
      works.length === 0
        ? 'No works found. The researcher may not have linked works to their ORCID record, or works may be set to private visibility.'
        : undefined;

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      workCount: works.length,
      works,
      ...(notice && { notice }),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Works for ORCID ${result.orcidId}`,
      `**URI:** ${result.orcidUri}`,
      `**Total Works:** ${result.workCount}`,
    ];

    if (result.notice) {
      lines.push('', `> ${result.notice}`);
    }

    if (result.works.length === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('');
    for (const w of result.works) {
      lines.push(`### ${w.title ?? '(untitled)'}`);
      if (w.workType) lines.push(`**Type:** ${w.workType}`);
      if (w.publicationDate) lines.push(`**Date:** ${w.publicationDate}`);
      if (w.journalTitle) lines.push(`**Journal:** ${w.journalTitle}`);
      if (w.url) lines.push(`**URL:** ${w.url}`);
      if (w.externalIds.length) {
        const idParts = w.externalIds.map((id) => {
          const rel = id.relationship ? ` [${id.relationship}]` : '';
          const urlPart = id.url ? ` (${id.url})` : '';
          return `${id.type}:${id.value}${urlPart}${rel}`;
        });
        lines.push(`**IDs:** ${idParts.join(', ')}`);
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
