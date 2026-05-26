/**
 * @fileoverview Resource for injecting a researcher's works list from ORCID as
 * stable inline context into prompts. DOIs and PMIDs are ready for Crossref/PubMed chaining.
 * @module mcp-server/resources/definitions/researcher-works.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';

export const researcherWorksResource = resource('orcid://researcher/{orcid_id}/works', {
  name: 'orcid-researcher-works',
  description:
    "Works list for an ORCID researcher: titles, types, publication dates, journal names, and external identifiers (DOIs, PMIDs, arXiv IDs). Use when providing a researcher's publication list as background context, e.g., before asking an LLM to summarize a body of work. DOIs and PMIDs in the response are ready for Crossref or PubMed chaining. Prefer the orcid_get_works tool when filtering or processing results is needed.",
  mimeType: 'application/json',

  params: z.object({
    orcid_id: z
      .string()
      .describe(
        'ORCID iD — bare format (0000-0001-2345-6789) or full URI (https://orcid.org/0000-0001-2345-6789).',
      ),
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    workCount: z.number().describe('Total works in this list.'),
    works: z
      .array(
        z
          .object({
            title: z.string().optional().describe('Work title.'),
            workType: z.string().optional().describe('Work type (journal-article, dataset, etc.).'),
            publicationDate: z.string().optional().describe('Publication date.'),
            journalTitle: z.string().optional().describe('Journal or container title.'),
            externalIds: z
              .array(
                z
                  .object({
                    type: z.string().describe('ID type (doi, pmid, arxiv, isbn, etc.).'),
                    value: z.string().describe('ID value.'),
                  })
                  .describe('External identifier.'),
              )
              .describe('External identifiers for this work.'),
          })
          .describe('Work summary.'),
      )
      .describe('Works associated with this ORCID iD.'),
  }),

  async handler(params, ctx) {
    const service = getOrcidService();
    const bareId = normalizeOrcidId(params.orcid_id);

    ctx.log.debug('orcid-researcher-works resource', { orcidId: bareId });

    const works = await service.getWorks(params.orcid_id, ctx);

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      workCount: works.length,
      works: works.map((w) => ({
        ...(w.title && { title: w.title }),
        ...(w.workType && { workType: w.workType }),
        ...(w.publicationDate && { publicationDate: w.publicationDate }),
        ...(w.journalTitle && { journalTitle: w.journalTitle }),
        externalIds: w.externalIds.map((id) => ({ type: id.type, value: id.value })),
      })),
    };
  },
});
