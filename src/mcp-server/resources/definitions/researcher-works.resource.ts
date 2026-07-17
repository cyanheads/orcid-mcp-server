/**
 * @fileoverview Resource for injecting a researcher's works list from ORCID as
 * stable inline context into prompts. Returns a compact, capped page of the most
 * recent works plus the total count; the orcid_get_works tool paginates the full
 * list. DOIs and PMIDs are ready for Crossref/PubMed chaining.
 * @module mcp-server/resources/definitions/researcher-works.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { invalidParams, JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import { isValidOrcidId, orcidIdParamSchema } from '@/services/orcid/orcid-id.js';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';

/**
 * Cap on works returned inline — the resource is compact prompt context, not an
 * exhaustive dump. Callers page the full list with the orcid_get_works tool.
 *
 * No cursor pagination: the MCP SDK's URI-template matcher compiles a `{?cursor}`
 * query expansion to a *required* segment, so a single resource template cannot match
 * both the natural no-cursor read and a `?cursor=` continuation. The tool owns paging.
 */
const MAX_WORKS = 25;

export const researcherWorksResource = resource('orcid://researcher/{orcid_id}/works', {
  name: 'orcid-researcher-works',
  description:
    "Works list for an ORCID researcher: titles, types, publication dates, journal names, and external identifiers (DOIs, PMIDs, arXiv IDs). Use when providing a researcher's publication list as background context for summarizing or reviewing a body of work. Returns the first 25 works plus workCount (the total available) — call the orcid_get_works tool to page through the full list or filter results. DOIs and PMIDs in the response are ready for Crossref or PubMed chaining. Prefer the orcid_get_works tool when filtering or processing results is needed.",
  mimeType: 'application/json',

  params: z.object({
    orcid_id: orcidIdParamSchema,
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    workCount: z
      .number()
      .describe('Total works available for this ORCID iD; works carries the first 25.'),
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
      .describe('The first 25 works for this ORCID iD; use orcid_get_works to page the full list.'),
  }),

  async handler(params, ctx) {
    // Reject a checksum-invalid iD locally, before any upstream call — mirrors the
    // tool route's InvalidParams. The regex-only param schema matched the shape; the
    // ISO 7064 check digit is verified here.
    if (!isValidOrcidId(params.orcid_id)) {
      throw invalidParams(
        `The ORCID iD ${params.orcid_id} is invalid — its ISO 7064 check digit does not match. Verify the iD and try again.`,
      );
    }

    const service = getOrcidService();
    const bareId = normalizeOrcidId(params.orcid_id);

    ctx.log.debug('orcid-researcher-works resource', { orcidId: bareId });

    let works: Awaited<ReturnType<typeof service.getWorks>>;
    try {
      works = await service.getWorks(params.orcid_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw notFound(
          `No works record found for ORCID iD ${bareId}. The record may not exist or may be fully private.`,
          { orcidId: bareId },
          { cause: err },
        );
      }
      throw err;
    }

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      workCount: works.length,
      works: works.slice(0, MAX_WORKS).map((w) => ({
        ...(w.title && { title: w.title }),
        ...(w.workType && { workType: w.workType }),
        ...(w.publicationDate && { publicationDate: w.publicationDate }),
        ...(w.journalTitle && { journalTitle: w.journalTitle }),
        externalIds: w.externalIds.map((id) => ({ type: id.type, value: id.value })),
      })),
    };
  },
});
