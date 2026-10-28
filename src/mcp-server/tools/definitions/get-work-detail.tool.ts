/**
 * @fileoverview Fetch full detail records for one or more ORCID works by their put-codes
 * using the bulk works endpoint. Put-codes past the 100-code fetch cap, and any ORCID returns
 * no result for, are named for a follow-up call.
 * @module mcp-server/tools/definitions/get-work-detail
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { deprecatedIdNotice } from '@/mcp-server/tools/deprecated-id-notice.js';
import { joinNotices } from '@/mcp-server/tools/notices.js';
import { SourceSchema, sourcesText } from '@/mcp-server/tools/record-sources.js';
import { blockquote, fence, singleLine } from '@/mcp-server/tools/third-party-text.js';
import { orcidIdSchema } from '@/services/orcid/orcid-id.js';
import {
  getOrcidService,
  normalizeOrcidId,
  type RecordResult,
} from '@/services/orcid/orcid-service.js';
import type { BulkWorkResult, WorkDetail } from '@/services/orcid/types.js';

/**
 * Contributors a record keeps whole. A longer list keeps this many, in upstream order, plus
 * every later entry carrying the requested iD. A large-collaboration record lists thousands of
 * authors (one ATLAS paper: 5,246, about 774 KB across both surfaces), so without the cut a
 * single record could outweigh a whole batch; with it, a record's size tracks its own fields.
 */
const CONTRIBUTOR_CAP = 100;

/**
 * Largest deposited citation kept, in UTF-8 bytes. Some sources deposit BibTeX naming every
 * author (60,532 B for one LIGO paper), repeating the contributor list the cap above bounds. A
 * cut citation would be invalid, so a longer one is left out whole; the DOI still resolves it.
 */
const CITATION_MAX_BYTES = 8_192;

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
      .describe('Work type (e.g. journal-article, data-set, software, preprint).'),
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
      .describe(
        'Citation metadata, when provided by the depositing system and no longer than 8,192 bytes.',
      ),
    citationOmitted: z
      .boolean()
      .optional()
      .describe(
        'True when the deposited citation exceeded 8,192 bytes and was left out; the DOI in externalIds still resolves the work. Omitted otherwise.',
      ),
    url: z.string().optional().describe('URL for the work, when available.'),
    externalIds: z
      .array(ExternalIdSchema)
      .describe(
        "External identifiers on this put-code's own record (DOIs, PMIDs, arXiv IDs, ISBNs, etc.). One source's version of the work, so it can hold fewer identifiers than orcid_get_works lists for the whole work group.",
      ),
    contributors: z
      .array(ContributorSchema)
      .describe(
        "Work contributors with optional roles, in upstream order. May be empty if not deposited. When contributorsTruncated is true, holds the first 100 followed by every later entry carrying the requested researcher's iD.",
      ),
    contributorCount: z
      .number()
      .optional()
      .describe(
        'Total contributors on the ORCID record. Present only when contributorsTruncated is true.',
      ),
    contributorsTruncated: z
      .boolean()
      .optional()
      .describe(
        'True when the record lists more than 100 contributors and the list was cut. Omitted when the list is complete.',
      ),
    languageCode: z.string().optional().describe('Language code of the work, when provided.'),
    sources: z
      .array(SourceSchema)
      .describe(
        'The party that added this put-code to the ORCID record. Empty when ORCID records no source; orcid_get_works lists every source of the work group.',
      ),
  })
  .describe('Full detail record for one work.');

type WorkDetailRecord = z.infer<typeof WorkDetailSchema>;

/** Heading for the contributor list, naming the cut when the record was capped. */
function contributorsHeading(work: WorkDetailRecord): string {
  if (!work.contributorsTruncated) return '**Contributors:**';
  const total = work.contributorCount?.toLocaleString('en-US');
  const owner = work.contributors.length > CONTRIBUTOR_CAP ? ', plus the record owner' : '';
  return `**Contributors (first ${CONTRIBUTOR_CAP} of ${total}${owner}):**`;
}

/** The Markdown `format()` renders for one work, opening with its `---` separator. */
function renderWorkDetail(work: WorkDetailRecord): string {
  const lines = [
    '',
    '---',
    `## ${singleLine(work.title ?? '(untitled)')}`,
    `**Put-code:** ${work.putCode}`,
  ];
  if (work.subtitle) lines.push(`**Subtitle:** ${singleLine(work.subtitle)}`);
  if (work.workType) lines.push(`**Type:** ${work.workType}`);
  if (work.publicationDate) lines.push(`**Date:** ${work.publicationDate}`);
  if (work.journalTitle) lines.push(`**Journal:** ${singleLine(work.journalTitle)}`);
  if (work.url) lines.push(`**URL:** ${singleLine(work.url)}`);
  if (work.externalIds.length) {
    const idParts = work.externalIds.map((id) => {
      const rel = id.relationship ? ` [${id.relationship}]` : '';
      const urlPart = id.url ? ` (${singleLine(id.url)})` : '';
      return `${id.type}:${singleLine(id.value)}${urlPart}${rel}`;
    });
    lines.push(`**IDs:** ${idParts.join(', ')}`);
  }
  const sources = sourcesText(work.sources);
  if (sources) lines.push(`**Sources:** ${sources}`);
  if (work.abstract) {
    lines.push('', '**Abstract:**', blockquote(work.abstract));
  }
  if (work.contributors.length) {
    lines.push('', contributorsHeading(work));
    for (const c of work.contributors) {
      const name = singleLine(c.name ?? '(unnamed)');
      const role = c.role ? ` — ${c.role}` : '';
      const seq = c.sequence ? ` (${c.sequence})` : '';
      const orcid = c.orcidId ? ` [${c.orcidId}]` : '';
      lines.push(`- ${name}${role}${seq}${orcid}`);
    }
  }
  if (work.citation) {
    lines.push('', `**Citation (${work.citation.type}):**`, fence(work.citation.value));
  }
  if (work.citationOmitted) {
    lines.push(
      '',
      `**Citation:** omitted — the deposited citation exceeds ${CITATION_MAX_BYTES.toLocaleString('en-US')} bytes`,
    );
  }
  if (work.languageCode) lines.push(`**Language:** ${work.languageCode}`);
  return lines.join('\n');
}

/**
 * The tool's record for one work: the service detail with its two unbounded fields capped.
 * A contributor list over {@link CONTRIBUTOR_CAP} keeps its head plus every later entry whose
 * iD is `ownerId` (by iD only — names collide), and a citation over
 * {@link CITATION_MAX_BYTES} is dropped. Each cut is flagged; an uncut record is unchanged.
 */
function toWorkRecord(d: WorkDetail, ownerId: string): WorkDetailRecord {
  const cut = d.contributors.length > CONTRIBUTOR_CAP;
  const contributors = cut
    ? [
        ...d.contributors.slice(0, CONTRIBUTOR_CAP),
        ...d.contributors.slice(CONTRIBUTOR_CAP).filter((c) => c.orcidId === ownerId),
      ]
    : d.contributors;
  const citationOmitted =
    d.citation !== undefined && Buffer.byteLength(d.citation.value) > CITATION_MAX_BYTES;
  return {
    putCode: d.putCode,
    ...(d.title !== undefined && { title: d.title }),
    ...(d.subtitle !== undefined && { subtitle: d.subtitle }),
    ...(d.workType !== undefined && { workType: d.workType }),
    ...(d.publicationDate !== undefined && { publicationDate: d.publicationDate }),
    ...(d.journalTitle !== undefined && { journalTitle: d.journalTitle }),
    ...(d.abstract !== undefined && { abstract: d.abstract }),
    ...(d.citation !== undefined && !citationOmitted && { citation: d.citation }),
    ...(citationOmitted && { citationOmitted: true }),
    ...(d.url !== undefined && { url: d.url }),
    externalIds: d.externalIds,
    contributors,
    ...(cut && { contributorCount: d.contributors.length, contributorsTruncated: true }),
    ...(d.languageCode !== undefined && { languageCode: d.languageCode }),
    sources: d.sources,
  };
}

type WorkError = { putCode?: number; message: string };

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
    "Fetch full work details by put-code from orcid_get_works. Accepts 1–1,000 raw codes, deduplicates in first-occurrence order, and fetches the first 100 distinct codes in one request, returning every record ORCID sends. Returns abstracts, contributors with CRediT roles, the record's external IDs (DOI, PMID, arXiv, ISBN, etc.), citation metadata, journal title, URL, and source provenance. A record listing more than 100 contributors keeps the first 100 plus the requested researcher's own entries, with contributorCount and contributorsTruncated; a citation over 8,192 bytes is left out and flagged by citationOmitted. Per-record errors are returned alongside successful works. deferredPutCodes lists, in request order, the codes past the 100-code fetch cap and any ORCID returned no result for; pass them as put_codes in another call.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    orcid_id: orcidIdSchema,
    put_codes: z
      .array(z.number().int().positive().describe('Work put-code (positive integer).'))
      .min(1)
      .max(1000)
      .describe(
        'Array of 1–1,000 raw work put-codes from orcid_get_works. Deduplicated in first-occurrence order; the first 100 distinct codes are fetched and the rest return in deferredPutCodes. A record costs what its fields hold: 100 large-collaboration records, even with contributor lists cut to 100, exceed 1 MB.',
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
        'Requested distinct put-codes no returned work or error settled, in request order: those past the 100-code fetch cap and any ORCID returned no result for. Pass as put_codes in another call. Omitted when all are settled.',
      ),
  }),

  // Agent-facing context: the deferral notice surfaces in structuredContent and content[]
  // without occupying the domain return.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Deprecated-iD disclosure naming the primary iD, then separate notices for put-codes past the 100-code fetch cap and put-codes ORCID returned no result for; call again with deferredPutCodes.',
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
    const requestedId = normalizeOrcidId(input.orcid_id);
    // The bulk endpoint answers a repeated put-code with its record plus an invalid-put-code
    // error, so repeats are collapsed (first occurrence kept) before the request is sent.
    const requestedCodes = [...new Set(input.put_codes)];
    const putCodes = requestedCodes.slice(0, 100);
    const capNotice =
      requestedCodes.length > putCodes.length
        ? `Requested ${input.put_codes.length} raw put-codes (${requestedCodes.length} distinct); effective fetch cap 100 distinct put-codes in one request; ${requestedCodes.length - putCodes.length} put-codes deferred by the input cap.`
        : '';
    ctx.log.info('orcid_get_work_detail', { orcidId: requestedId, count: putCodes.length });

    let record: RecordResult<BulkWorkResult[]>;
    try {
      record = await service.getWorkDetails(input.orcid_id, putCodes, ctx);
      // ORCID answers the bulk endpoint for a deprecated iD with an invalid-put-code error per
      // code instead of redirecting it. When no work resolves, /person (which does redirect)
      // names the primary iD; a differing one gets the request again. A call that resolves any
      // work makes no extra request. The probe is best-effort: when it fails for any reason but
      // caller cancellation, the per-code errors already in hand are the answer.
      if (!record.data.some((result) => result.type === 'work')) {
        const primaryId = await service.getPerson(input.orcid_id, ctx).then(
          (person) => person.orcidId,
          (error: unknown) => {
            if (ctx.signal.aborted) throw error;
            ctx.log.warning('Deprecated-iD probe failed; returning the bulk results as served.', {
              orcidId: requestedId,
            });
            return;
          },
        );
        if (primaryId !== undefined && primaryId !== record.orcidId)
          record = await service.getWorkDetails(primaryId, putCodes, ctx);
      }
    } catch (err) {
      // Caller cancellation propagates as thrown, never relabelled as an upstream failure.
      if (ctx.signal.aborted) throw err;
      // A whole-request 404 means the ORCID iD itself does not resolve. A transient
      // upstream failure (retries already exhausted in the service layer) keeps its
      // original code, plus any retryable/retryAfter signal it carried, so clients can
      // wait and retry instead of seeing a downgraded InternalError. Anything else is a
      // genuinely unexpected bulk failure. Every branch builds fresh message + data (never
      // spreading the caught error's data), which is what redacts upstream transport
      // details (url/status/statusText/body) from the client payload.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('profile_not_found', `ORCID iD ${requestedId} not found`);
      }
      const transientOutcome =
        err instanceof McpError ? TRANSIENT_OUTCOMES.get(err.code) : undefined;
      if (err instanceof McpError && transientOutcome) {
        // `reason` is a framework constant (a deadline expiry's `retry_deadline_exceeded`),
        // never transport detail, so it rides along with the retry signals.
        const { retryable, retryAfter, reason } = err.data ?? {};
        throw new McpError(
          err.code,
          `ORCID bulk works endpoint ${transientOutcome} for ${requestedId}.`,
          {
            ...(retryable !== undefined && { retryable }),
            ...(retryAfter !== undefined && { retryAfter }),
            ...(reason !== undefined && { reason }),
          },
          { cause: err },
        );
      }
      throw ctx.fail(
        'fetch_failed',
        `ORCID bulk works endpoint failed for ${requestedId}`,
        undefined,
        { cause: err },
      );
    }
    const { orcidId: bareId, data: results } = record;
    const deprecation = deprecatedIdNotice(requestedId, bareId);

    // The bulk endpoint returns works first, in an order of its own rather than the request's,
    // then error entries; both keep that order.
    const works: WorkDetailRecord[] = [];
    const errors: WorkError[] = [];
    for (const result of results) {
      if (result.type === 'work') works.push(toWorkRecord(result.detail, bareId));
      else
        errors.push({
          ...(result.putCode !== undefined && { putCode: result.putCode }),
          message: result.message,
        });
    }
    // Deferred = requested put-codes no returned entry settled, in request order: the input
    // cap's remainder plus any fetched code ORCID answered nothing for.
    const settled = new Set([...works, ...errors].map((record) => record.putCode));
    const deferredPutCodes = requestedCodes.filter((code) => !settled.has(code));

    ctx.log.info('orcid_get_work_detail completed', {
      orcidId: bareId,
      resolved: works.length,
      errors: errors.length,
      deferred: deferredPutCodes.length,
    });

    const missingCount = putCodes.filter((code) => !settled.has(code)).length;
    const notice = joinNotices(
      deprecation,
      capNotice,
      missingCount > 0 &&
        `ORCID returned no identified result for ${missingCount} requested put-codes; they remain deferred. Call orcid_get_work_detail again with deferredPutCodes as put_codes.`,
    );
    if (notice) ctx.enrich.notice(notice);

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
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
