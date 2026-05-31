/**
 * @fileoverview Fetch the full detail record for a single ORCID work by its put-code.
 * @module mcp-server/tools/definitions/get-work-detail
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';
import type { WorkDetail } from '@/services/orcid/types.js';

const ExternalIdSchema = z
  .object({
    type: z.string().describe('Identifier type (e.g. doi, pmid, arxiv, isbn, ppr).'),
    value: z.string().describe('Identifier value.'),
    url: z.string().optional().describe('Resolver URL for this identifier, if available.'),
    relationship: z.string().optional().describe('Relationship to the work (self or part-of).'),
  })
  .describe('External identifier for the work.');

const ContributorSchema = z
  .object({
    name: z.string().optional().describe('Contributor display name or credit name.'),
    orcidId: z.string().optional().describe('Contributor ORCID iD (bare format), if linked.'),
    role: z
      .string()
      .optional()
      .describe(
        'Contributor role (e.g. author, editor, conceptualization, data-curation). May be a CRediT taxonomy term.',
      ),
    sequence: z
      .string()
      .optional()
      .describe('Contributor sequence position (first or additional).'),
  })
  .describe('Work contributor with optional role and ORCID iD.');

export const orcidGetWorkDetail = tool('orcid_get_work_detail', {
  title: 'Get ORCID Work Detail',
  description:
    'Fetch the full detail record for a single work by its put-code, which is returned by orcid_get_works in the put_code field of each work entry. Returns the abstract (short-description), all contributors with CRediT roles, the complete external ID list (DOI, PMID, arXiv, ISBN, etc.), citation metadata (BibTeX or other formats when provided), journal title, and URL. Use this when you need more than the summary — especially the abstract or contributor list — after calling orcid_get_works to identify the put-code.',
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
    put_code: z
      .number()
      .int()
      .positive()
      .describe(
        'Work put-code, available in the put_code field returned by orcid_get_works. Each work group has a unique put-code.',
      ),
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    putCode: z.number().describe('Put-code of this work record.'),
    title: z.string().optional().describe('Work title.'),
    subtitle: z.string().optional().describe('Work subtitle, when provided.'),
    workType: z
      .string()
      .optional()
      .describe('Work type (e.g. journal-article, dataset, software, preprint).'),
    publicationDate: z
      .string()
      .optional()
      .describe('Publication date (YYYY, YYYY-MM, or YYYY-MM-DD).'),
    journalTitle: z.string().optional().describe('Journal or container title, when provided.'),
    abstract: z.string().optional().describe('Abstract or short description, when provided.'),
    citation: z
      .object({
        type: z.string().describe('Citation format (e.g. bibtex, formatted-unspecified).'),
        value: z.string().describe('Citation string in the specified format.'),
      })
      .optional()
      .describe('Citation metadata, when provided by the depositing system.'),
    url: z.string().optional().describe('URL for the work, when available.'),
    externalIds: z
      .array(ExternalIdSchema)
      .describe('All external identifiers (DOIs, PMIDs, arXiv IDs, ISBNs, etc.).'),
    contributors: z
      .array(ContributorSchema)
      .describe('Work contributors with optional roles. May be empty if not deposited.'),
    languageCode: z.string().optional().describe('Language code of the work, when provided.'),
  }),

  errors: [
    {
      reason: 'work_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The ORCID iD or put-code does not correspond to a known record.',
      recovery:
        'Verify the ORCID iD with orcid_search_researchers and the put-code with orcid_get_works.',
    },
  ],

  async handler(input, ctx) {
    const service = getOrcidService();
    ctx.log.info('orcid_get_work_detail', { orcidId: input.orcid_id, putCode: input.put_code });

    let detail: WorkDetail;
    try {
      detail = await service.getWorkDetail(input.orcid_id, input.put_code, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'work_not_found',
          `Work put-code ${input.put_code} not found for ORCID iD ${normalizeOrcidId(input.orcid_id)}`,
        );
      }
      throw err;
    }

    const bareId = normalizeOrcidId(input.orcid_id);
    ctx.log.info('orcid_get_work_detail completed', {
      orcidId: bareId,
      putCode: detail.putCode,
      hasAbstract: !!detail.abstract,
      contributorCount: detail.contributors.length,
    });

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      putCode: detail.putCode,
      ...(detail.title !== undefined && { title: detail.title }),
      ...(detail.subtitle !== undefined && { subtitle: detail.subtitle }),
      ...(detail.workType !== undefined && { workType: detail.workType }),
      ...(detail.publicationDate !== undefined && { publicationDate: detail.publicationDate }),
      ...(detail.journalTitle !== undefined && { journalTitle: detail.journalTitle }),
      ...(detail.abstract !== undefined && { abstract: detail.abstract }),
      ...(detail.citation !== undefined && { citation: detail.citation }),
      ...(detail.url !== undefined && { url: detail.url }),
      externalIds: detail.externalIds,
      contributors: detail.contributors,
      ...(detail.languageCode !== undefined && { languageCode: detail.languageCode }),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## ${result.title ?? '(untitled)'}`,
      `**ORCID iD:** ${result.orcidId} | **URI:** ${result.orcidUri} | **Put-code:** ${result.putCode}`,
    ];
    if (result.subtitle) lines.push(`**Subtitle:** ${result.subtitle}`);
    if (result.workType) lines.push(`**Type:** ${result.workType}`);
    if (result.publicationDate) lines.push(`**Date:** ${result.publicationDate}`);
    if (result.journalTitle) lines.push(`**Journal:** ${result.journalTitle}`);
    if (result.url) lines.push(`**URL:** ${result.url}`);
    if (result.externalIds.length) {
      const idParts = result.externalIds.map((id) => {
        const rel = id.relationship ? ` [${id.relationship}]` : '';
        const urlPart = id.url ? ` (${id.url})` : '';
        return `${id.type}:${id.value}${urlPart}${rel}`;
      });
      lines.push(`**IDs:** ${idParts.join(', ')}`);
    }
    if (result.abstract) {
      lines.push('', `**Abstract:** ${result.abstract}`);
    }
    if (result.contributors.length) {
      lines.push('', '**Contributors:**');
      for (const c of result.contributors) {
        const name = c.name ?? '(unnamed)';
        const role = c.role ? ` — ${c.role}` : '';
        const seq = c.sequence ? ` (${c.sequence})` : '';
        const orcid = c.orcidId ? ` [${c.orcidId}]` : '';
        lines.push(`- ${name}${role}${seq}${orcid}`);
      }
    }
    if (result.citation) {
      lines.push('', `**Citation (${result.citation.type}):**`);
      lines.push('```');
      lines.push(result.citation.value);
      lines.push('```');
    }
    if (result.languageCode) lines.push(`**Language:** ${result.languageCode}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
