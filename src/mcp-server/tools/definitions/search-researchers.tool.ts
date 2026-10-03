/**
 * @fileoverview Search the ORCID registry using structured field parameters or
 * raw Solr syntax. Returns ORCID iDs with inline name and institution data.
 * @module mcp-server/tools/definitions/search-researchers.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { countWithinBudget, recordCost } from '@/mcp-server/tools/response-budget.js';
import { singleLine } from '@/mcp-server/tools/third-party-text.js';
import { getOrcidService } from '@/services/orcid/orcid-service.js';
import {
  escapeSolrValue,
  isExclusionOnlyQuery,
  isInitial,
  isValidRorId,
  normalizeRorId,
  ROR_ID_INPUT_PATTERN,
  splitNameWords,
  stripIdentifierPrefix,
} from '@/services/orcid/solr-query.js';
import type { ExpandedSearchResponse } from '@/services/orcid/types.js';

/** The ORCID Public API rejects `start` beyond this offset for unauthenticated requests. */
const MAX_START = 10_000;

const SearchResultSchema = z
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
  .describe('Expanded search result for one researcher.');

type SearchResult = z.infer<typeof SearchResultSchema>;

/** The page header `format()` renders, ending in the blank line before the first record. */
function renderHeader(page: { rows: number; start: number; nextStart?: number | undefined }) {
  return [
    '## ORCID Search Results',
    `**Returned:** ${page.rows} | **Offset:** ${page.start}`,
    ...(page.nextStart != null ? [`**Next Start:** ${page.nextStart}`] : []),
    '',
  ];
}

/**
 * One result as `format()` renders it, closing blank line included. Shared with the response
 * byte budget so each result is charged the text it actually adds to `content[]`.
 */
function renderResult(r: SearchResult): string {
  const nameParts = [r.givenNames, r.familyNames].filter(Boolean);
  const displayName = r.creditName ?? (nameParts.length ? nameParts.join(' ') : r.orcidId);
  const lines = [
    `### ${singleLine(displayName)}`,
    `**ORCID iD:** ${r.orcidId}`,
    `**ORCID URI:** ${r.orcidUri}`,
  ];
  if (nameParts.length) lines.push(`**Name:** ${singleLine(nameParts.join(' '))}`);
  if (r.creditName) lines.push(`**Credit Name:** ${singleLine(r.creditName)}`);
  if (r.otherNames.length) {
    lines.push(`**Other Names:** ${r.otherNames.map(singleLine).join(', ')}`);
  }
  if (r.institutionNames.length) {
    lines.push(`**Institutions:** ${r.institutionNames.map(singleLine).join('; ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Build a Solr query string from structured search parameters. Blank values contribute no
 * clause, so an input with nothing searchable compiles to `''` — which the input schema
 * rejects before the handler runs.
 */
function buildSolrQuery(input: {
  given_name?: string | undefined;
  family_name?: string | undefined;
  affiliation?: string | undefined;
  keyword?: string | undefined;
  ror_id?: string | undefined;
  doi?: string | undefined;
  pmid?: string | undefined;
  grant_number?: string | undefined;
  query?: string | undefined;
}): string {
  const clauses: string[] = [];
  const doi = input.doi && stripIdentifierPrefix('doi', input.doi);
  const pmid = input.pmid && stripIdentifierPrefix('pmid', input.pmid);

  // Every structured value is escaped and phrase-quoted so reserved characters (quotes, DOI
  // punctuation, ROR colons/slashes) stay literal and whitespace cannot split a value into
  // extra query terms (#47). The raw `query` passthrough below is deliberately left unescaped.
  const givenName = input.given_name?.trim();
  if (givenName) {
    // A given name of only initials ("J.", "J. A.") becomes one prefix term per initial, since
    // the phrase would match only a literal "J." (#53). A bare letter carries no reserved char.
    const words = splitNameWords(givenName);
    clauses.push(
      words.length > 0 && words.every(isInitial)
        ? words.map((initial) => `given-names:${initial.normalize('NFC')}*`).join(' AND ')
        : `given-names:"${escapeSolrValue(givenName)}"`,
    );
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
  if (input.ror_id) {
    clauses.push(`ror-org-id:"${escapeSolrValue(normalizeRorId(input.ror_id))}"`);
  }
  if (doi) {
    clauses.push(`doi-self:"${escapeSolrValue(doi)}"`);
  }
  if (pmid) {
    clauses.push(`pmid-self:"${escapeSolrValue(pmid)}"`);
  }
  // `grant-numbers` is a tokenized text field: only the phrase-quoted clause matches narrowly.
  if (input.grant_number?.trim()) {
    clauses.push(`grant-numbers:"${escapeSolrValue(input.grant_number.trim())}"`);
  }
  // The raw query joins as one group so a top-level OR keeps its alternatives instead of
  // binding to the structured clause before it (#61) — except when every top-level clause is
  // an exclusion, which ORCID matches only ungrouped. Supplied alone, it is sent verbatim.
  const query = input.query?.trim();
  if (query) {
    clauses.push(clauses.length === 0 || isExclusionOnlyQuery(query) ? query : `(${query})`);
  }

  return clauses.join(' AND ');
}

export const orcidSearchResearchers = tool('orcid_search_researchers', {
  title: 'Search ORCID Researchers',
  description:
    'Search the ORCID registry using structured field parameters or raw Solr syntax. Provide at least one non-blank search field; all provided structured params are ANDed together. The `query` field adds raw Solr syntax, ANDed with the structured params as one group. Returns ORCID iDs with inline name and institution data — no follow-up profile fetches needed for basic disambiguation. For ranked disambiguation of an ambiguous author name, use orcid_resolve_researcher instead. The ORCID Public API caps results at 10,000 — use pagination for large result sets. Each response also stops at 64,000 bytes; continue a cut page from nextStart.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z
    .object({
      given_name: z
        .string()
        .optional()
        .describe(
          "Researcher's given (first) name. Phrase match; a value of only initials (J. or J. A.) matches given names starting with each letter.",
        ),
      family_name: z.string().optional().describe("Researcher's family (last) name."),
      affiliation: z.string().optional().describe('Organization name to filter by. Phrase match.'),
      keyword: z
        .string()
        .optional()
        .describe("Keyword to search in the researcher's keyword fields. Phrase match."),
      // A blank or whitespace-only value from a form client means "unset": it trims to '',
      // which the pattern admits and buildSolrQuery skips. The pattern also admits padding, so
      // the advertised JSON Schema accepts every value the server does.
      ror_id: z
        .string()
        .trim()
        .regex(ROR_ID_INPUT_PATTERN, {
          message: 'Must be a ROR ID: 00cvxb145, ror.org/00cvxb145, or https://ror.org/00cvxb145.',
          abort: true,
        })
        .refine((value) => value === '' || isValidRorId(value), {
          message:
            'The ROR ID is invalid — its check digits do not match. Verify the ID and try again.',
        })
        .optional()
        .describe(
          'ROR organization ID to filter by, bare (00f54p054) or as a ror.org URL (https://ror.org/00f54p054). Returns researchers affiliated with this organization.',
        ),
      doi: z
        .string()
        .optional()
        .describe(
          'DOI to anchor the search, bare (10.1126/science.1225829) or as a https://doi.org/, https://dx.doi.org/, or doi: form. Returns researchers who have linked this DOI to their ORCID record.',
        ),
      pmid: z
        .string()
        .optional()
        .describe(
          'PubMed ID to anchor the search, bare (22745249), as PMID:22745249, or as a pubmed.ncbi.nlm.nih.gov or ncbi.nlm.nih.gov/pubmed URL. Returns researchers who have linked this PMID to their ORCID record.',
        ),
      grant_number: z
        .string()
        .optional()
        .describe(
          'Grant or award number on a funding item in the researcher record (e.g. 5F31MH010500-03). Matched as a case-insensitive phrase over the parts between separators such as hyphens and slashes: 5F31MH010500 also matches 5F31MH010500-03, but a number cut mid-part (5F31MH0105) matches nothing. Not an exact identifier lookup.',
        ),
      query: z
        .string()
        .optional()
        .describe(
          'Raw Solr query string. Sent as written when it is the only field; beside structured params it is ANDed as one parenthesized group, so a top-level OR keeps its alternatives (an exclusion-only query such as -keyword:x is ANDed ungrouped). Supports all ORCID Solr fields and boolean operators.',
        ),
      rows: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(20)
        .describe(
          'Maximum results to return (1–1000). A page also stops before its structured output or its text would pass 64,000 bytes, so fewer can come back; continue from nextStart.',
        ),
      start: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .default(0)
        .describe(
          'Pagination offset (0-based), 0–10,000. The ORCID Public API rejects start > 10,000 for unauthenticated requests.',
        ),
    })
    // A search with nothing to search on would run as a match-all over the whole registry.
    // A doi or pmid that is only a URL prefix normalizes to empty and counts as blank.
    .superRefine((input, ctx) => {
      if (!buildSolrQuery(input)) {
        ctx.addIssue({
          code: 'custom',
          path: [],
          message:
            'Provide at least one non-blank search field: given_name, family_name, affiliation, keyword, ror_id, doi, pmid, grant_number, or query.',
        });
      }
    }),

  output: z.object({
    results: z
      .array(SearchResultSchema)
      .describe('Matching researchers with inline name and institution data.'),
    rows: z
      .number()
      .describe(
        'Number of results returned in this response. Below the requested rows when the 64,000-byte response budget cut the page; nextStart then continues from the first result left out.',
      ),
    start: z.number().describe('Pagination offset used for this response.'),
    nextStart: z
      .number()
      .optional()
      .describe(
        'Offset to pass as start on the next call to continue paging. Present only when more matches remain below the ORCID Public API 10,000-offset ceiling; omitted at the final reachable page and when this response already includes the last match.',
      ),
  }),

  errors: [
    {
      reason: 'query_failed',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'ORCID rejects the compiled Solr query — most often malformed raw query syntax.',
      recovery:
        'Check the query field for unbalanced quotes or brackets and unknown Solr field names, or drop it and search with the structured parameters alone.',
    },
  ],

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

    let response: ExpandedSearchResponse;
    try {
      response = await service.expandedSearch(
        { q: effectiveQuery, rows: input.rows, start: input.start },
        ctx,
      );
    } catch (err) {
      // Transient upstream conditions keep their original code so the client retains the
      // retryable signal — the service layer has already exhausted its retry budget.
      // Everything else is a request that will not succeed as submitted; the raw `query`
      // passthrough is the usual cause, so route it to the contract's recovery hint.
      if (
        err instanceof McpError &&
        (err.code === JsonRpcErrorCode.ServiceUnavailable ||
          err.code === JsonRpcErrorCode.Timeout ||
          err.code === JsonRpcErrorCode.RateLimited)
      ) {
        throw err;
      }
      throw ctx.fail(
        'query_failed',
        `ORCID could not complete the search for query: ${effectiveQuery}`,
        undefined,
        { cause: err },
      );
    }

    const numFound = response.numFound;
    // numFound above the public API's 10,000-offset ceiling means some matches can never
    // be paged to with the current query — a corpus-level truncation, distinct from a
    // per-page row cap.
    const truncated = numFound > MAX_START;
    const notice =
      numFound === 0
        ? 'No results found. Try fewer constraints, verify spelling, or use the query field with Solr syntax.'
        : response.results.length === 0 && input.start > 0 && input.start >= numFound
          ? `Offset ${input.start} exceeds numFound (${numFound}). Reduce start to page through results.`
          : truncated
            ? `ORCID reports ${numFound.toLocaleString('en-US')} matches, but the public API cannot page beyond offset 10,000. Narrow or partition the query with additional structured fields or raw Solr constraints to retrieve the remaining records.`
            : undefined;

    const candidates: SearchResult[] = response.results.map((r) => ({
      orcidId: r.orcidId,
      orcidUri: `https://orcid.org/${r.orcidId}`,
      ...(r.givenNames && { givenNames: r.givenNames }),
      ...(r.familyNames && { familyNames: r.familyNames }),
      ...(r.creditName && { creditName: r.creditName }),
      otherNames: r.otherNames,
      institutionNames: r.institutionNames,
    }));

    // Results are admitted in order while both surfaces stay within the byte budget. The
    // envelope carries the enrichment both surfaces show and its widest counters; its text
    // twin is the page header plus the framework's enrichment trailer (one `**Label:** value`
    // line per field, the notice as a quote), and the larger of the two is charged.
    const widest = { rows: candidates.length, start: input.start, nextStart: MAX_START };
    const envelopeBytes = recordCost(
      { results: [], ...widest, effectiveQuery, numFound, truncated, notice },
      `${renderHeader(widest).join('\n')}\n\n\n**Effective Query:** ${effectiveQuery}\n**Total Found:** ${numFound}\n**Truncated:** ${truncated}${notice ? `\n> ${notice}` : ''}`,
    );
    const results = candidates.slice(
      0,
      countWithinBudget(
        candidates.values().map((r) => recordCost(r, renderResult(r))),
        envelopeBytes,
      ),
    );
    const returned = results.length;
    // Next legal offset: just past the last returned result. Offered only while another
    // page both holds more matches and stays within the 10,000-offset ceiling.
    const endStart = input.start + returned;
    const hasNextPage = endStart < numFound && endStart <= MAX_START;

    ctx.log.info('orcid_search_researchers completed', {
      numFound,
      fetched: candidates.length,
      returned,
    });

    ctx.enrich({ effectiveQuery, numFound, truncated });
    if (notice) ctx.enrich.notice(notice);

    return {
      results,
      rows: returned,
      start: input.start,
      ...(hasNextPage && { nextStart: endStart }),
    };
  },

  format: (result) => {
    const lines = [
      ...renderHeader(result),
      ...(result.results.length === 0 ? ['No results.'] : result.results.map(renderResult)),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
