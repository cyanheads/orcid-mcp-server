/**
 * @fileoverview Fetch full detail records for one or more ORCID works by their put-codes
 * using the bulk works endpoint. Records past the shared response byte budget are
 * deferred and named for a follow-up call.
 * @module mcp-server/tools/definitions/get-work-detail
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  countWithinBudget,
  jsonBytes,
  RESPONSE_BYTE_BUDGET,
  recordCost,
} from '@/mcp-server/tools/response-budget.js';
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

/** The Markdown `format()` renders for one work, opening with its `---` separator. */
function renderWorkDetail(work: z.infer<typeof WorkDetailSchema>): string {
  const lines = ['', '---', `## ${work.title ?? '(untitled)'}`, `**Put-code:** ${work.putCode}`];
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
    lines.push('', `**Citation (${work.citation.type}):**`, '```', work.citation.value, '```');
  }
  if (work.languageCode) lines.push(`**Language:** ${work.languageCode}`);
  return lines.join('\n');
}

type WorkError = { putCode?: number; message: string };

/** One bulk entry in response order, before it is sorted into `works` or `errors`. */
type WorkEntry = { kind: 'work'; record: WorkDetail } | { kind: 'error'; record: WorkError };

function deferredNotice(count: number): string {
  return `The response reached its ${RESPONSE_BYTE_BUDGET.toLocaleString('en-US')}-byte budget, so ${count} put-code${count === 1 ? ' was' : 's were'} deferred. Call orcid_get_work_detail again with deferredPutCodes as put_codes to fetch ${count === 1 ? 'it' : 'them'}.`;
}

/** Transient upstream codes the handler keeps, mapped to the outcome its message names. */
const TRANSIENT_OUTCOMES = new Map<number, string>([
  [JsonRpcErrorCode.ServiceUnavailable, 'is unavailable'],
  [JsonRpcErrorCode.Timeout, 'timed out'],
  [JsonRpcErrorCode.RateLimited, 'is rate-limited'],
]);

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
    'Fetch full detail records for 1–100 works by their put-codes in a single request. Put-codes are returned by orcid_get_works in the putCode field of each work entry. Returns the abstract (short-description), all contributors with CRediT roles, the complete external ID list (DOI, PMID, arXiv, ISBN, etc.), citation metadata (BibTeX or other formats when provided), journal title, and URL for each work. Per-record errors (not-found or inaccessible put-codes) are surfaced as error entries rather than failing the whole call. Records are added until the response reaches its 64,000-byte budget; put-codes left out are returned in deferredPutCodes to pass back in a follow-up call. A repeated put-code is fetched once.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    orcid_id: orcidIdSchema,
    put_codes: z
      .array(z.number().int().positive().describe('Work put-code (positive integer).'))
      .min(1)
      .max(100)
      .describe(
        'Array of 1–100 work put-codes to fetch. Put-codes are available in the putCode field returned by orcid_get_works. A repeated put-code is fetched once. Any the 64,000-byte response budget leaves out come back in deferredPutCodes.',
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
    deferredPutCodes: z
      .array(z.number().describe('Deferred work put-code.'))
      .optional()
      .describe(
        'Requested put-codes left out because the response reached its 64,000-byte budget. Pass them as put_codes in another call to fetch them. Omitted when every put-code was fetched.',
      ),
  }),

  // Agent-facing context: the deferral notice surfaces in structuredContent and content[]
  // without occupying the domain return.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Note when the response budget deferred some put-codes — call again with deferredPutCodes.',
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
    // The bulk endpoint answers a repeated put-code with its record plus an invalid-put-code
    // error, so repeats are collapsed (first occurrence kept) before the request is sent.
    const putCodes = [...new Set(input.put_codes)];
    ctx.log.info('orcid_get_work_detail', { orcidId: bareId, count: putCodes.length });

    let results: BulkWorkResult[];
    try {
      results = await service.getWorkDetails(input.orcid_id, putCodes, ctx);
    } catch (err) {
      // A whole-request 404 means the ORCID iD itself does not resolve. A transient
      // upstream failure (retries already exhausted in the service layer) keeps its
      // original code, plus any retryable/retryAfter signal it carried, so clients can
      // wait and retry instead of seeing a downgraded InternalError. Anything else is a
      // genuinely unexpected bulk failure. Every branch builds fresh message + data (never
      // spreading the caught error's data), which is what redacts upstream transport
      // details (url/status/statusText/body) from the client payload.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('profile_not_found', `ORCID iD ${bareId} not found`, {
          ...ctx.recoveryFor('profile_not_found'),
        });
      }
      const transientOutcome =
        err instanceof McpError ? TRANSIENT_OUTCOMES.get(err.code) : undefined;
      if (err instanceof McpError && transientOutcome) {
        const { retryable, retryAfter } = err.data ?? {};
        throw new McpError(
          err.code,
          `ORCID bulk works endpoint ${transientOutcome} for ${bareId}.`,
          {
            ...(retryable !== undefined && { retryable }),
            ...(retryAfter !== undefined && { retryAfter }),
          },
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

    const entries = results.map((result): WorkEntry => {
      if (result.type === 'error') {
        return {
          kind: 'error',
          record: {
            ...(result.putCode !== undefined && { putCode: result.putCode }),
            message: result.message,
          },
        };
      }
      const d = result.detail;
      return {
        kind: 'work',
        record: {
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
        },
      };
    });

    // Entries are budgeted in upstream order: the bulk endpoint returns works first, in an
    // order of its own rather than the request's, then error entries. An error entry's text
    // line is shorter than its JSON, so its JSON is its cost. A cut response also carries the
    // deferred list and its notice, sized here for the worst case of every put-code deferred.
    const orcidUri = `https://orcid.org/${bareId}`;
    const kept = entries.slice(
      0,
      countWithinBudget(
        entries
          .values()
          .map((entry) =>
            entry.kind === 'work'
              ? recordCost(entry.record, renderWorkDetail(entry.record))
              : jsonBytes(entry.record),
          ),
        jsonBytes({ orcidId: bareId, orcidUri, works: [], errors: [] }),
        jsonBytes({ deferredPutCodes: putCodes, notice: deferredNotice(putCodes.length) }),
      ),
    );

    const works: WorkDetail[] = [];
    const errors: WorkError[] = [];
    for (const entry of kept) {
      if (entry.kind === 'work') works.push(entry.record);
      else errors.push(entry.record);
    }
    // Deferred = requested put-codes no kept entry settled, in request order.
    const settled = new Set([...works, ...errors].map((record) => record.putCode));
    const deferredPutCodes =
      kept.length < entries.length ? putCodes.filter((code) => !settled.has(code)) : [];

    ctx.log.info('orcid_get_work_detail completed', {
      orcidId: bareId,
      resolved: works.length,
      errors: errors.length,
      deferred: deferredPutCodes.length,
    });

    if (deferredPutCodes.length > 0) ctx.enrich.notice(deferredNotice(deferredPutCodes.length));

    return {
      orcidId: bareId,
      orcidUri,
      works,
      errors,
      ...(deferredPutCodes.length > 0 && { deferredPutCodes }),
    };
  },

  format: (result) => {
    const lines = [
      `**ORCID iD:** ${result.orcidId} | **URI:** ${result.orcidUri}`,
      `**Works resolved:** ${result.works.length} | **Errors:** ${result.errors.length}`,
      ...result.works.map(renderWorkDetail),
    ];

    if (result.errors.length) {
      lines.push('', '---', '**Errors:**');
      for (const err of result.errors) {
        const putCodeLabel = err.putCode !== undefined ? ` (put-code ${err.putCode})` : '';
        lines.push(`- ${err.message}${putCodeLabel}`);
      }
    }

    if (result.deferredPutCodes?.length) {
      lines.push('', '---', `**Deferred put-codes:** ${result.deferredPutCodes.join(', ')}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
