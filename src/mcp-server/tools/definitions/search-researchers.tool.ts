/**
 * @fileoverview Search the ORCID registry using structured field parameters or
 * raw Solr syntax. Returns ORCID iDs with inline name and institution data.
 * @module mcp-server/tools/definitions/search-researchers.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOrcidService } from '@/services/orcid/orcid-service.js';
import { escapeSolrValue } from '@/services/orcid/solr-query.js';

/** Build a Solr query string from structured search parameters. */
function buildSolrQuery(input: {
  given_name?: string | undefined;
  family_name?: string | undefined;
  affiliation?: string | undefined;
  keyword?: string | undefined;
  ror_id?: string | undefined;
  doi?: string | undefined;
  pmid?: string | undefined;
  query?: string | undefined;
}): string {
  const clauses: string[] = [];

  // Every structured value is escaped so reserved characters (quotes, DOI punctuation,
  // ROR colons/slashes) stay literal and cannot break out of their clause or malform the
  // upstream request. The raw `query` passthrough below is deliberately left unescaped.
  if (input.given_name?.trim()) {
    clauses.push(`given-names:"${escapeSolrValue(input.given_name.trim())}"`);
  }
  if (input.family_name?.trim()) {
    clauses.push(`family-name:"${escapeSolrValue(input.family_name.trim())}"`);
  }
  if (input.affiliation?.trim()) {
    clauses.push(`affiliation-org-name:"${escapeSolrValue(input.affiliation.trim())}"`);
  }
  if (input.keyword?.trim()) {
    clauses.push(`keyword:"${escapeSolrValue(input.keyword.trim())}"`);
  }
  if (input.ror_id?.trim()) {
    clauses.push(`ror-org-id:"${escapeSolrValue(input.ror_id.trim())}"`);
  }
  if (input.doi?.trim()) {
    clauses.push(`doi-self:${escapeSolrValue(input.doi.trim())}`);
  }
  if (input.pmid?.trim()) {
    clauses.push(`pmid-self:${escapeSolrValue(input.pmid.trim())}`);
  }
  if (input.query?.trim()) {
    clauses.push(input.query.trim());
  }

  return clauses.join(' AND ') || '*:*';
}

export const orcidSearchResearchers = tool('orcid_search_researchers', {
  title: 'Search ORCID Researchers',
  description:
    'Search the ORCID registry using structured field parameters or raw Solr syntax. All provided structured params are ANDed together. The `query` field appends raw Solr syntax to the generated clause. Returns ORCID iDs with inline name and institution data — no follow-up profile fetches needed for basic disambiguation. For ranked disambiguation of an ambiguous author name, use orcid_resolve_researcher instead. The ORCID Public API caps results at 10,000 — use pagination for large result sets.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    given_name: z.string().optional().describe("Researcher's given (first) name."),
    family_name: z.string().optional().describe("Researcher's family (last) name."),
    affiliation: z.string().optional().describe('Organization name to filter by. Phrase match.'),
    keyword: z
      .string()
      .optional()
      .describe("Keyword to search in the researcher's keyword fields. Phrase match."),
    ror_id: z
      .string()
      .optional()
      .describe(
        'ROR organization ID to filter by (full URL, e.g. https://ror.org/00f54p054). Returns researchers affiliated with this organization.',
      ),
    doi: z
      .string()
      .optional()
      .describe(
        'DOI to anchor the search. Returns researchers who have linked this DOI to their ORCID record.',
      ),
    pmid: z
      .string()
      .optional()
      .describe(
        'PubMed ID to anchor the search. Returns researchers who have linked this PMID to their ORCID record.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Raw Solr query string appended to the generated clause with AND. Supports all ORCID Solr fields and boolean operators.',
      ),
    rows: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(20)
      .describe('Maximum results to return (1–1000).'),
    start: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .default(0)
      .describe(
        'Pagination offset (0-based), 0–10,000. The ORCID Public API rejects start > 10,000 for unauthenticated requests.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            orcidId: z.string().describe('ORCID iD (bare format).'),
            orcidUri: z.string().describe('Full ORCID URI.'),
            givenNames: z.string().optional().describe('Given names from the ORCID record.'),
            familyNames: z.string().optional().describe('Family name from the ORCID record.'),
            creditName: z.string().optional().describe('Published credit name, if set.'),
            otherNames: z
              .array(z.string().describe('Alternative name.'))
              .describe('Other names listed on the ORCID record.'),
            institutionNames: z
              .array(z.string().describe('Institution name.'))
              .describe('Affiliated institution names returned inline with each search result.'),
          })
          .describe('Expanded search result for one researcher.'),
      )
      .describe('Matching researchers with inline name and institution data.'),
    rows: z.number().describe('Number of results returned in this response.'),
    start: z.number().describe('Pagination offset used for this response.'),
    nextStart: z
      .number()
      .optional()
      .describe(
        'Offset to pass as start on the next call to continue paging. Present only when more matches remain below the ORCID Public API 10,000-offset ceiling; omitted at the final reachable page and when this response already includes the last match.',
      ),
  }),

  // Agent-facing context: the query the API received, total match count, and empty-result
  // guidance. Reaches both structuredContent and content[] without a format() entry.
  enrichment: {
    effectiveQuery: z.string().describe('Solr query sent to the ORCID API.'),
    numFound: z.number().describe('Total number of matching records in ORCID (before pagination).'),
    truncated: z
      .boolean()
      .describe(
        "True when numFound exceeds the ORCID Public API's 10,000-offset retrieval ceiling, so some matches cannot be paged to with the current query. Narrow or partition the query to reach them.",
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty, pagination overshoots the total, or matches exceed the 10,000-offset ceiling. Absent on fully retrievable pages.',
      ),
  },

  enrichmentTrailer: {
    effectiveQuery: { label: 'Effective Query' },
    numFound: { label: 'Total Found' },
    truncated: { label: 'Truncated' },
  },

  async handler(input, ctx) {
    const service = getOrcidService();
    const effectiveQuery = buildSolrQuery(input);

    ctx.log.info('orcid_search_researchers', {
      effectiveQuery,
      rows: input.rows,
      start: input.start,
    });

    const response = await service.expandedSearch(
      { q: effectiveQuery, rows: input.rows, start: input.start },
      ctx,
    );

    ctx.log.info('orcid_search_researchers completed', {
      numFound: response.numFound,
      returned: response.results.length,
    });

    const numFound = response.numFound;
    const returned = response.results.length;
    // numFound above the public API's 10,000-offset ceiling means some matches can never
    // be paged to with the current query — a corpus-level truncation, distinct from a
    // per-page row cap.
    const truncated = numFound > 10000;
    // Next legal offset: just past the last returned result. Offered only while another
    // page both holds more matches and stays within the 10,000-offset ceiling.
    const endStart = input.start + returned;
    const hasNextPage = endStart < numFound && endStart <= 10000;

    ctx.enrich({ effectiveQuery, numFound, truncated });

    if (numFound === 0) {
      ctx.enrich.notice(
        'No results found. Try fewer constraints, verify spelling, or use the query field with Solr syntax.',
      );
    } else if (returned === 0 && input.start > 0 && input.start >= numFound) {
      ctx.enrich.notice(
        `Offset ${input.start} exceeds numFound (${numFound}). Reduce start to page through results.`,
      );
    } else if (truncated) {
      ctx.enrich.notice(
        `ORCID reports ${numFound.toLocaleString('en-US')} matches, but the public API cannot page beyond offset 10,000. Narrow or partition the query with additional structured fields or raw Solr constraints to retrieve the remaining records.`,
      );
    }

    return {
      results: response.results.map((r) => ({
        orcidId: r.orcidId,
        orcidUri: `https://orcid.org/${r.orcidId}`,
        ...(r.givenNames && { givenNames: r.givenNames }),
        ...(r.familyNames && { familyNames: r.familyNames }),
        ...(r.creditName && { creditName: r.creditName }),
        otherNames: r.otherNames,
        institutionNames: r.institutionNames,
      })),
      rows: returned,
      start: input.start,
      ...(hasNextPage && { nextStart: endStart }),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## ORCID Search Results`,
      `**Returned:** ${result.rows} | **Offset:** ${result.start}`,
    ];
    if (result.nextStart != null) {
      lines.push(`**Next Start:** ${result.nextStart}`);
    }

    if (result.results.length === 0) {
      lines.push('', 'No results.');
    } else {
      lines.push('');
      for (const r of result.results) {
        const nameParts = [r.givenNames, r.familyNames].filter(Boolean);
        const displayName = r.creditName ?? (nameParts.length ? nameParts.join(' ') : r.orcidId);
        lines.push(`### ${displayName}`);
        lines.push(`**ORCID iD:** ${r.orcidId}`);
        lines.push(`**ORCID URI:** ${r.orcidUri}`);
        if (r.givenNames || r.familyNames) {
          lines.push(`**Name:** ${[r.givenNames, r.familyNames].filter(Boolean).join(' ')}`);
        }
        if (r.creditName) lines.push(`**Credit Name:** ${r.creditName}`);
        if (r.otherNames.length) lines.push(`**Other Names:** ${r.otherNames.join(', ')}`);
        if (r.institutionNames.length) {
          lines.push(`**Institutions:** ${r.institutionNames.join('; ')}`);
        }
        lines.push('');
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
