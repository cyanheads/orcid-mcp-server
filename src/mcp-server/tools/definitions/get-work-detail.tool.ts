/**
 * @fileoverview Fetch full detail records for one or more ORCID works by their put-codes
 * using the bulk works endpoint.
 * @module mcp-server/tools/definitions/get-work-detail
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { orcidIdSchema } from '@/services/orcid/orcid-id.js';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';
import type { BulkWorkResult, WorkDetail } from '@/services/orcid/types.js';

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

const WorkDetailSchema = z
  .object({
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
  })
  .describe('Full detail record for one work.');

const WorkErrorSchema = z
  .object({
    putCode: z
      .number()
      .optional()
      .describe('Put-code that produced this error, when identifiable.'),
    message: z.string().describe('Error message from ORCID (e.g. not found or access denied).'),
  })
  .describe('Error entry for a put-code that could not be resolved.');

export const orcidGetWorkDetail = tool('orcid_get_work_detail', {
  title: 'Get ORCID Work Details (Bulk)',
  description:
    'Fetch full detail records for 1–100 works by their put-codes in a single request. Put-codes are returned by orcid_get_works in the put_code field of each work entry. Returns the abstract (short-description), all contributors with CRediT roles, the complete external ID list (DOI, PMID, arXiv, ISBN, etc.), citation metadata (BibTeX or other formats when provided), journal title, and URL for each work. Per-record errors (not-found or inaccessible put-codes) are surfaced as error entries rather than failing the whole call.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    orcid_id: orcidIdSchema,
    put_codes: z
      .array(z.number().int().positive().describe('Work put-code (positive integer).'))
      .min(1)
      .max(100)
      .describe(
        'Array of 1–100 work put-codes to fetch. Put-codes are available in the put_code field returned by orcid_get_works.',
      ),
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    works: z.array(WorkDetailSchema).describe('Successfully resolved work detail records.'),
    errors: z
      .array(WorkErrorSchema)
      .describe(
        'Per-record errors for put-codes that could not be resolved (not found or inaccessible). Empty when all put-codes resolved successfully.',
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
    {
      reason: 'fetch_failed',
      code: JsonRpcErrorCode.InternalError,
      when: 'The ORCID bulk works endpoint returns an unexpected error.',
      recovery: 'Retry the request; if the error persists, verify the ORCID iD and put-codes.',
    },
  ],

  async handler(input, ctx) {
    const service = getOrcidService();
    const bareId = normalizeOrcidId(input.orcid_id);
    ctx.log.info('orcid_get_work_detail', { orcidId: bareId, count: input.put_codes.length });

    let results: BulkWorkResult[];
    try {
      results = await service.getWorkDetails(input.orcid_id, input.put_codes, ctx);
    } catch (err) {
      // A whole-request 404 means the ORCID iD itself does not resolve. A transient
      // upstream failure (retries already exhausted in the service layer) keeps its
      // original code so clients retain the retryable signal instead of seeing a
      // downgraded InternalError. Anything else is a genuinely unexpected bulk failure.
      // Every branch builds fresh message + data (never spreading the caught error's
      // data), which is what redacts upstream transport details (url/status/statusText/
      // body) from the client payload.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('profile_not_found', `ORCID iD ${bareId} not found`, {
          ...ctx.recoveryFor('profile_not_found'),
        });
      }
      if (
        err instanceof McpError &&
        (err.code === JsonRpcErrorCode.ServiceUnavailable || err.code === JsonRpcErrorCode.Timeout)
      ) {
        const message =
          err.code === JsonRpcErrorCode.Timeout
            ? `ORCID bulk works endpoint timed out for ${bareId}.`
            : `ORCID bulk works endpoint is unavailable for ${bareId}.`;
        throw new McpError(
          err.code,
          message,
          { ...(err.data?.retryable !== undefined && { retryable: err.data.retryable }) },
          { cause: err },
        );
      }
      throw ctx.fail(
        'fetch_failed',
        `ORCID bulk works endpoint failed for ${bareId}`,
        { ...ctx.recoveryFor('fetch_failed') },
        { cause: err },
      );
    }

    const works: WorkDetail[] = [];
    const errors: Array<{ putCode?: number; message: string }> = [];

    for (const result of results) {
      if (result.type === 'error') {
        errors.push({
          ...(result.putCode !== undefined && { putCode: result.putCode }),
          message: result.message,
        });
      } else {
        const d = result.detail;
        works.push({
          putCode: d.putCode,
          ...(d.title !== undefined && { title: d.title }),
          ...(d.subtitle !== undefined && { subtitle: d.subtitle }),
          ...(d.workType !== undefined && { workType: d.workType }),
          ...(d.publicationDate !== undefined && { publicationDate: d.publicationDate }),
          ...(d.journalTitle !== undefined && { journalTitle: d.journalTitle }),
          ...(d.abstract !== undefined && { abstract: d.abstract }),
          ...(d.citation !== undefined && { citation: d.citation }),
          ...(d.url !== undefined && { url: d.url }),
          externalIds: d.externalIds,
          contributors: d.contributors,
          ...(d.languageCode !== undefined && { languageCode: d.languageCode }),
        });
      }
    }

    ctx.log.info('orcid_get_work_detail completed', {
      orcidId: bareId,
      resolved: works.length,
      errors: errors.length,
    });

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      works,
      errors,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**ORCID iD:** ${result.orcidId} | **URI:** ${result.orcidUri}`,
      `**Works resolved:** ${result.works.length} | **Errors:** ${result.errors.length}`,
    ];

    for (const work of result.works) {
      lines.push('', `---`, `## ${work.title ?? '(untitled)'}`);
      lines.push(`**Put-code:** ${work.putCode}`);
      if (work.subtitle) lines.push(`**Subtitle:** ${work.subtitle}`);
      if (work.workType) lines.push(`**Type:** ${work.workType}`);
      if (work.publicationDate) lines.push(`**Date:** ${work.publicationDate}`);
      if (work.journalTitle) lines.push(`**Journal:** ${work.journalTitle}`);
      if (work.url) lines.push(`**URL:** ${work.url}`);
      if (work.externalIds.length) {
        const idParts = work.externalIds.map((id) => {
          const rel = id.relationship ? ` [${id.relationship}]` : '';
          const urlPart = id.url ? ` (${id.url})` : '';
          return `${id.type}:${id.value}${urlPart}${rel}`;
        });
        lines.push(`**IDs:** ${idParts.join(', ')}`);
      }
      if (work.abstract) {
        lines.push('', `**Abstract:** ${work.abstract}`);
      }
      if (work.contributors.length) {
        lines.push('', '**Contributors:**');
        for (const c of work.contributors) {
          const name = c.name ?? '(unnamed)';
          const role = c.role ? ` — ${c.role}` : '';
          const seq = c.sequence ? ` (${c.sequence})` : '';
          const orcid = c.orcidId ? ` [${c.orcidId}]` : '';
          lines.push(`- ${name}${role}${seq}${orcid}`);
        }
      }
      if (work.citation) {
        lines.push('', `**Citation (${work.citation.type}):**`);
        lines.push('```');
        lines.push(work.citation.value);
        lines.push('```');
      }
      if (work.languageCode) lines.push(`**Language:** ${work.languageCode}`);
    }

    if (result.errors.length) {
      lines.push('', '---', '**Errors:**');
      for (const err of result.errors) {
        const putCodeLabel = err.putCode !== undefined ? ` (put-code ${err.putCode})` : '';
        lines.push(`- ${err.message}${putCodeLabel}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
