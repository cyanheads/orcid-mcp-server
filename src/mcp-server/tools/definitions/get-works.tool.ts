/**
 * @fileoverview Retrieve works (publications, datasets, software, preprints, etc.)
 * associated with an ORCID iD. Returns titles, types, dates, journal names, the
 * sources that asserted each work, and external identifiers ready for chaining to
 * Crossref, PubMed, or arXiv. ORCID returns the whole works list in one response, so the
 * work-type and publication-year filters run locally over all of it, and offset/limit then
 * page the filtered list by count.
 * @module mcp-server/tools/definitions/get-works.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { deprecatedIdNotice } from '@/mcp-server/tools/deprecated-id-notice.js';
import { clampNotice, joinNotices } from '@/mcp-server/tools/notices.js';
import { SourceSchema, sourcesText } from '@/mcp-server/tools/record-sources.js';
import { singleLine } from '@/mcp-server/tools/third-party-text.js';
import { orcidIdSchema } from '@/services/orcid/orcid-id.js';
import {
  getOrcidService,
  normalizeOrcidId,
  type RecordResult,
} from '@/services/orcid/orcid-service.js';
import type { Work } from '@/services/orcid/types.js';

/** Most works one page returns; a larger `limit` is clamped to it with a notice. */
const MAX_LIMIT = 1000;

/**
 * ORCID's closed work-type vocabulary: the 58 values of `WorkType` in ORCID's orcid-model
 * (`org.orcid.jaxb.model.common.WorkType`), which ORCID validates writes against. A type ORCID
 * adds later still appears in output, but filtering on it needs this list updated.
 */
const WORK_TYPES = [
  'annotation',
  'artistic-performance',
  'blog-post',
  'book-chapter',
  'book-review',
  'book',
  'cartographic-material',
  'clinical-study',
  'conference-abstract',
  'conference-output',
  'conference-paper',
  'conference-poster',
  'conference-presentation',
  'conference-proceedings',
  'data-management-plan',
  'data-set',
  'design',
  'dictionary-entry',
  'disclosure',
  'dissertation-thesis',
  'edited-book',
  'encyclopedia-entry',
  'image',
  'invention',
  'journal-article',
  'journal-issue',
  'learning-object',
  'lecture-speech',
  'license',
  'magazine-article',
  'manual',
  'moving-image',
  'musical-composition',
  'newsletter-article',
  'newspaper-article',
  'online-resource',
  'other',
  'patent',
  'physical-object',
  'preprint',
  'registered-copyright',
  'report',
  'research-technique',
  'research-tool',
  'review',
  'software',
  'sound',
  'spin-off-company',
  'standards-and-policy',
  'supervised-student-publication',
  'technical-standard',
  'test',
  'trademark',
  'transcription',
  'translation',
  'website',
  'working-paper',
  'undefined',
] as const;

/** The filters a call applied, as echoed back; absent keys were not set. */
const AppliedFiltersSchema = z
  .object({
    workTypes: z.array(z.string()).optional().describe('Work types kept (work_types).'),
    yearFrom: z.number().optional().describe('Earliest publication year kept (year_from).'),
    yearTo: z.number().optional().describe('Latest publication year kept (year_to).'),
  })
  .describe('Filters applied before paging.');

type AppliedFilters = z.infer<typeof AppliedFiltersSchema>;

/** The filters in one line, named by their input keys, for the echo and the no-match notice. */
function filtersText(f: AppliedFilters): string {
  return [
    f.workTypes && `work_types: ${f.workTypes.join(', ')}`,
    f.yearFrom !== undefined && `year_from: ${f.yearFrom}`,
    f.yearTo !== undefined && `year_to: ${f.yearTo}`,
  ]
    .filter(Boolean)
    .join('; ');
}

/** Publication year from the leading four digits of `publicationDate`; undefined when undated. */
function publicationYear(work: Work): number | undefined {
  const year = work.publicationDate?.match(/^\d{4}/)?.[0];
  return year === undefined ? undefined : Number(year);
}

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
      .describe(
        "Work type in ORCID's vocabulary (e.g. journal-article, data-set, software, preprint), taken from the preferred version.",
      ),
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
        "External identifiers of the whole ORCID work group (DOIs, PMIDs, arXiv IDs, ISBNs, etc.): the preferred version's own, part-of IDs such as an ISSN included, then each identifier only another source in the group holds. Omitted when include_external_ids is false.",
      ),
    sources: z
      .array(SourceSchema)
      .describe(
        "Every party that added this work to the ORCID record, one entry per distinct source in the work group, the preferred version's first. Empty when ORCID records no source.",
      ),
  })
  .describe('Work summary record — one ORCID work group, built from its preferred version.');

/** The Markdown `format()` renders for one work, trailing blank line included. */
function renderWork(w: z.infer<typeof WorkSummarySchema>): string {
  const lines = [`### ${singleLine(w.title ?? '(untitled)')}`];
  if (w.putCode != null) lines.push(`**Put-code:** ${w.putCode}`);
  if (w.workType) lines.push(`**Type:** ${w.workType}`);
  if (w.publicationDate) lines.push(`**Date:** ${w.publicationDate}`);
  if (w.journalTitle) lines.push(`**Journal:** ${singleLine(w.journalTitle)}`);
  if (w.url) lines.push(`**URL:** ${singleLine(w.url)}`);
  if (w.externalIds?.length) {
    const idParts = w.externalIds.map((id) => {
      const rel = id.relationship ? ` [${id.relationship}]` : '';
      const urlPart = id.url ? ` (${singleLine(id.url)})` : '';
      return `${id.type}:${singleLine(id.value)}${urlPart}${rel}`;
    });
    lines.push(`**IDs:** ${idParts.join(', ')}`);
  }
  const sources = sourcesText(w.sources);
  if (sources) lines.push(`**Sources:** ${sources}`);
  lines.push('');
  return lines.join('\n');
}

export const orcidGetWorks = tool('orcid_get_works', {
  title: 'Get ORCID Researcher Works',
  description:
    'Retrieve works associated with an ORCID iD — publications, datasets, software, preprints, and more. Returns work summaries with put-codes, titles, types, publication dates, journal names, and all external identifiers (DOIs, PMIDs, arXiv IDs, ISBNs). Narrow the list with work_types and year_from/year_to; the filters run over the whole record before paging, so matchedCount counts every match and workCount the whole record. The first 25 matching works are returned by default; page with offset and the returned nextOffset, or raise limit. Set include_external_ids to false to omit identifier lists for a lighter payload. Pass the putCode from each work to orcid_get_work_detail to retrieve the full record including abstract and contributors. External IDs are ready for chaining to Crossref, PubMed, or arXiv servers. Works come from the researcher or from member organizations such as Crossref or a university system; each work lists its sources and whether the researcher asserted it (selfAsserted). A researcher may not have linked all their publications.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z
    .object({
      orcid_id: orcidIdSchema,
      work_types: z
        .array(z.enum(WORK_TYPES).describe("A work type in ORCID's vocabulary."))
        .optional()
        .describe(
          'Keep only works of these types, matched against each workType (e.g. ["journal-article", "preprint"]; ORCID spells datasets data-set). Any listed type matches; an empty list keeps every type.',
        ),
      year_from: z
        .number()
        .int()
        .optional()
        .describe(
          'Keep only works published in or after this year, read from the first four digits of publicationDate. Under either year bound, works with no publication date are left out and counted in the notice.',
        ),
      year_to: z
        .number()
        .int()
        .optional()
        .describe('Keep only works published in or before this year; not before year_from.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .default(25)
        .describe('Works per page. Default 25; a larger value returns at most 1,000 and says so.'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe(
          'Zero-based index of the first matching work to return (default 0). Continue with nextOffset.',
        ),
      include_external_ids: z
        .boolean()
        .default(true)
        .describe(
          'When true (default), each work carries its external identifiers (DOIs, PMIDs, arXiv IDs, ISBNs). Set false to omit them for a lighter payload when only titles, types, and dates are needed.',
        ),
    })
    .superRefine((input, ctx) => {
      if (
        input.year_from !== undefined &&
        input.year_to !== undefined &&
        input.year_from > input.year_to
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['year_from'],
          message: `year_from (${input.year_from}) must not be after year_to (${input.year_to}).`,
        });
      }
    }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    workCount: z
      .number()
      .describe('Total works on this ORCID record, before filters, offset, and limit.'),
    matchedCount: z
      .number()
      .describe(
        'Works matching work_types and the year range, before offset and limit; equals workCount when no filter is set.',
      ),
    returnedCount: z.number().describe('Number of works returned in this response.'),
    offset: z
      .number()
      .describe('Zero-based offset into the matching works applied for this response.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call, with the same filters, to continue paging. Omitted when this response includes the last matching work.',
      ),
    truncated: z
      .boolean()
      .describe('True when more matching works follow this page — fetch them with nextOffset.'),
    works: z
      .array(WorkSummarySchema)
      .describe('Matching works in ORCID order, sliced to the requested offset and limit.'),
  }),

  // Agent-facing context: notices and the filter echo reach structuredContent and content[]
  // without occupying the domain return.
  enrichment: {
    appliedFilters: AppliedFiltersSchema.optional().describe(
      'The filters applied before paging, present only when one is set.',
    ),
    notice: z
      .string()
      .optional()
      .describe(
        'Deprecated-iD disclosure naming the primary iD, requested/effective limit disclosure, the count of undated works a year filter left out, no-match or past-end guidance, or empty-record guidance: works may be private or not yet added.',
      ),
  },

  enrichmentTrailer: {
    // Rendered only when the handler set the field.
    appliedFilters: { render: (filters: AppliedFilters) => `**Filters:** ${filtersText(filters)}` },
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
      workTypes: input.work_types,
      yearFrom: input.year_from,
      yearTo: input.year_to,
      limit: input.limit,
      offset: input.offset,
    });

    let record: RecordResult<Work[]>;
    try {
      record = await service.getWorks(input.orcid_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'profile_not_found',
          `ORCID iD ${normalizeOrcidId(input.orcid_id)} not found`,
        );
      }
      throw err;
    }
    const { orcidId: bareId, data: allWorks } = record;
    const workCount = allWorks.length;
    const limit = Math.min(input.limit, MAX_LIMIT);

    // An empty work_types list from a form client means no type filter.
    const types = input.work_types?.length ? new Set<string>(input.work_types) : undefined;
    const yearFiltered = input.year_from !== undefined || input.year_to !== undefined;
    const filters: AppliedFilters = {
      ...(types && { workTypes: [...types] }),
      ...(input.year_from !== undefined && { yearFrom: input.year_from }),
      ...(input.year_to !== undefined && { yearTo: input.year_to }),
    };
    // Filter the whole record before the slice, so offset, nextOffset, and truncated run over
    // the matches. Undated works a year bound drops are counted only among those the type
    // filter keeps.
    let undated = 0;
    const matched =
      types || yearFiltered
        ? allWorks.filter((w) => {
            if (types && !types.has(w.workType ?? '')) return false;
            if (!yearFiltered) return true;
            const year = publicationYear(w);
            if (year === undefined) {
              undated++;
              return false;
            }
            return (
              (input.year_from === undefined || year >= input.year_from) &&
              (input.year_to === undefined || year <= input.year_to)
            );
          })
        : allWorks;
    const matchedCount = matched.length;

    const works = matched.slice(input.offset, input.offset + limit).map((w) => {
      const { externalIds, ...rest } = w;
      return input.include_external_ids ? { ...rest, externalIds } : rest;
    });
    const returnedCount = works.length;
    const endOffset = input.offset + returnedCount;
    const truncated = endOffset < matchedCount;

    // One notice per call, in a fixed order: deprecation, clamp, filter, past-end, empty record.
    const notice = joinNotices(
      deprecatedIdNotice(normalizeOrcidId(input.orcid_id), bareId),
      clampNotice('limit', input.limit, limit, 'works'),
      undated > 0 &&
        (undated === 1
          ? '1 work without a publication date was left out by the year filter.'
          : `${undated} works without a publication date were left out by the year filter.`),
      workCount === 0
        ? 'No works found. They may be set to private, or neither the researcher nor a member organization added any; absence does not mean no publications.'
        : matchedCount === 0
          ? `No works match the filters (${filtersText(filters)}) among the record's ${workCount} works. Drop or widen a filter.`
          : input.offset >= matchedCount &&
            `Offset ${input.offset} exceeds matchedCount (${matchedCount}). Reduce offset to page through the works.`,
    );

    ctx.log.info('orcid_get_works completed', {
      orcidId: bareId,
      workCount,
      matchedCount,
      returnedCount,
      truncated,
    });

    if (Object.keys(filters).length > 0) ctx.enrich({ appliedFilters: filters });
    if (notice) ctx.enrich.notice(notice);

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      workCount,
      matchedCount,
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
      `**Matched Works:** ${result.matchedCount}`,
      `**Returned:** ${result.returnedCount} (offset ${result.offset})`,
      `**Truncated:** ${result.truncated ? 'Yes' : 'No'}`,
    ];
    if (result.nextOffset != null) lines.push(`**Next Offset:** ${result.nextOffset}`);
    if (result.works.length > 0) lines.push('', ...result.works.map(renderWork));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
