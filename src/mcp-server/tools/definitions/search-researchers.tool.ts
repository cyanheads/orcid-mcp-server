/**
 * @fileoverview Search the ORCID registry using structured field parameters or
 * raw Solr syntax. Returns ORCID iDs with inline name and institution data.
 * @module mcp-server/tools/definitions/search-researchers.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOrcidService } from '@/services/orcid/orcid-service.js';

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

  if (input.given_name?.trim()) {
    clauses.push(`given-names:${input.given_name.trim()}`);
  }
  if (input.family_name?.trim()) {
    clauses.push(`family-name:${input.family_name.trim()}`);
  }
  if (input.affiliation?.trim()) {
    clauses.push(`affiliation-org-name:"${input.affiliation.trim()}"`);
  }
  if (input.keyword?.trim()) {
    clauses.push(`keyword:"${input.keyword.trim()}"`);
  }
  if (input.ror_id?.trim()) {
    // ROR IDs contain colons and must be quoted in Solr
    clauses.push(`ror-org-id:"${input.ror_id.trim()}"`);
  }
  if (input.doi?.trim()) {
    clauses.push(`doi-self:${input.doi.trim()}`);
  }
  if (input.pmid?.trim()) {
    clauses.push(`pmid-self:${input.pmid.trim()}`);
  }
  if (input.query?.trim()) {
    clauses.push(input.query.trim());
  }

  return clauses.join(' AND ') || '*:*';
}

export const orcidSearchResearchers = tool('orcid_search_researchers', {
  title: 'Search ORCID Researchers',
  description:
    'Search the ORCID registry using structured field parameters or raw Solr syntax. All provided structured params are ANDed together. The `query` field appends raw Solr syntax to the generated clause. Returns ORCID iDs with inline name and institution data via expanded-search — no follow-up profile fetches needed for basic disambiguation. For ranked disambiguation of an ambiguous author name, use orcid_resolve_researcher instead. The ORCID Public API caps results at 10,000 — use pagination for large result sets.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    given_name: z
      .string()
      .optional()
      .describe('Given (first) name to search. Maps to Solr field given-names.'),
    family_name: z
      .string()
      .optional()
      .describe('Family (last) name to search. Maps to Solr field family-name.'),
    affiliation: z
      .string()
      .optional()
      .describe(
        'Organization name to filter by. Maps to Solr field affiliation-org-name. Quoted phrase match.',
      ),
    keyword: z
      .string()
      .optional()
      .describe('Keyword to search in researcher keyword fields. Quoted phrase match.'),
    ror_id: z
      .string()
      .optional()
      .describe(
        'ROR organization ID to filter by (full URL, e.g. https://ror.org/00f54p054). Maps to Solr field ror-org-id.',
      ),
    doi: z
      .string()
      .optional()
      .describe(
        'DOI to anchor the search. Returns researchers who have linked this DOI to their ORCID record. Maps to Solr field doi-self.',
      ),
    pmid: z
      .string()
      .optional()
      .describe(
        'PubMed ID to anchor the search. Returns researchers who have linked this PMID to their ORCID record. Maps to Solr field pmid-self.',
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
      .default(0)
      .describe('Pagination offset (0-based). ORCID Public API caps at 10,000 total results.'),
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
              .describe('Affiliated institution names returned by expanded-search.'),
          })
          .describe('Expanded search result for one researcher.'),
      )
      .describe('Matching researchers with inline name and institution data.'),
    numFound: z.number().describe('Total number of matching records in ORCID (before pagination).'),
    rows: z.number().describe('Number of results returned in this response.'),
    start: z.number().describe('Pagination offset used for this response.'),
    effectiveQuery: z.string().describe('Solr query sent to the ORCID API.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty or pagination overshoots the total. Absent on successful pages.',
      ),
  }),

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No ORCID records matched the search query.',
      recovery:
        'Broaden the query — try fewer constraints, check spelling, or use the query field with Solr syntax.',
    },
  ],

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

    let notice: string | undefined;
    if (response.numFound === 0) {
      notice =
        'No results found. Try fewer constraints, verify spelling, or use the query field with Solr syntax.';
    } else if (
      response.results.length === 0 &&
      input.start > 0 &&
      input.start >= response.numFound
    ) {
      notice = `Offset ${input.start} exceeds numFound (${response.numFound}). Reduce start to page through results.`;
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
      numFound: response.numFound,
      rows: response.results.length,
      start: input.start,
      effectiveQuery,
      ...(notice && { notice }),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## ORCID Search Results`,
      `**Query:** \`${result.effectiveQuery}\``,
      `**Total Found:** ${result.numFound} | **Returned:** ${result.rows} | **Offset:** ${result.start}`,
    ];

    if (result.notice) {
      lines.push('', `> ${result.notice}`);
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
