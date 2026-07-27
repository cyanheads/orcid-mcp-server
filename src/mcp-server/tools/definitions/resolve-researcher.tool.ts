/**
 * @fileoverview Disambiguate an author name to a verified ORCID iD. Returns a
 * ranked candidate list with transparent disambiguation signals: name match type,
 * institution overlap, and anchor type (doi/pmid/none).
 * @module mcp-server/tools/definitions/resolve-researcher.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getOrcidService } from '@/services/orcid/orcid-service.js';
import { escapeSolrValue } from '@/services/orcid/solr-query.js';
import type { ExpandedSearchResult } from '@/services/orcid/types.js';

/**
 * Generic organization words that carry no disambiguating signal on their own. A name — or
 * a matched run — made of nothing but these words can't establish institution overlap, so
 * a bare "university"/"institute" never marks unrelated institutions as overlapping (#20).
 */
const ORG_STOPWORDS = new Set([
  'university',
  'universities',
  'institute',
  'institutes',
  'institution',
  'institutions',
  'college',
  'colleges',
  'school',
  'schools',
  'department',
  'departments',
  'dept',
  'center',
  'centre',
  'centers',
  'centres',
  'laboratory',
  'laboratories',
  'lab',
  'labs',
  'hospital',
  'hospitals',
  'of',
  'the',
  'and',
  'for',
  'national',
  'state',
]);

/** Name match type based on how well the result name matches input. */
type NameMatchType = 'exact' | 'partial' | 'other-name' | 'none';

function computeNameMatch(candidate: ExpandedSearchResult, inputName: string): NameMatchType {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim();

  const normalizedInput = normalize(inputName);

  // Build full names from candidate
  const fullName = [candidate.givenNames, candidate.familyNames].filter(Boolean).join(' ');
  const creditName = candidate.creditName ?? '';

  if (normalize(fullName) === normalizedInput || normalize(creditName) === normalizedInput) {
    return 'exact';
  }

  const inputTokens = normalizedInput.split(/\s+/).filter(Boolean);
  const candidateTokens = normalize(fullName).split(/\s+/).filter(Boolean);
  const overlap = inputTokens.filter((t) => candidateTokens.includes(t));
  if (overlap.length >= Math.min(2, inputTokens.length)) {
    return 'partial';
  }

  // Check other-names
  for (const otherName of candidate.otherNames) {
    if (normalize(otherName) === normalizedInput) return 'other-name';
    const otherTokens = normalize(otherName).split(/\s+/).filter(Boolean);
    const otherOverlap = inputTokens.filter((t) => otherTokens.includes(t));
    if (otherOverlap.length >= Math.min(2, inputTokens.length)) return 'other-name';
  }

  return 'none';
}

/**
 * Content words of an institution name, in order. Tokens of 3 characters or fewer carry
 * too little identity to match on. Generic org words are deliberately *kept* — they
 * position the distinctive words within the name, which is what separates
 * "University of Washington" from "Washington University".
 */
function contentTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 3);
}

/**
 * True when the shorter content-word sequence appears as a contiguous run inside the
 * longer one, and that run carries at least one non-generic word.
 *
 * Requiring the whole of one name to appear inside the other is what closes #27: a single
 * shared proper noun ("washington") no longer matches wherever it happens to appear, since
 * "university of washington" is not a contiguous run of "george washington university".
 * Abbreviated forms still match, because the abbreviation's content words are a run of the
 * full name ("UC Berkeley" → "University of California, Berkeley").
 *
 * Known residual: a name that is a genuine prefix or suffix of a different institution's
 * name still matches — "Washington University" is a contiguous run of "George Washington
 * University". Anchoring the run (rejecting a match preceded by another content word)
 * would close it, but would also reject "UC Berkeley" against "University of California,
 * Berkeley" and "Genomics Institute" against "Innovative Genomics Institute", which are
 * both correct matches. The narrower false positive is the better trade.
 */
function sharesWholeRun(a: string[], b: string[]): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length === 0) return false;
  // A run of nothing but generic org words ("institute", "university") is not a signal.
  if (!shorter.some((t) => !ORG_STOPWORDS.has(t))) return false;

  for (let i = 0; i + shorter.length <= longer.length; i++) {
    if (shorter.every((t, j) => longer[i + j] === t)) return true;
  }
  return false;
}

function computeInstitutionOverlap(
  candidate: ExpandedSearchResult,
  inputAffiliation: string | undefined,
): boolean {
  if (!inputAffiliation?.trim()) return false;
  const inputTokens = contentTokens(inputAffiliation);
  // An affiliation of nothing but generic org words carries no disambiguating signal (#20).
  if (!inputTokens.some((t) => !ORG_STOPWORDS.has(t))) return false;

  return candidate.institutionNames.some((inst) =>
    sharesWholeRun(inputTokens, contentTokens(inst)),
  );
}

export const orcidResolveResearcher = tool('orcid_resolve_researcher', {
  title: 'Resolve ORCID Researcher',
  description:
    'Disambiguate an author name to a verified ORCID iD. Returns ranked candidates (5 by default, up to 20 via the rows parameter) with transparent disambiguation signals: name match type (exact/partial/other-name/none), institution overlap flag, and whether a DOI or PMID anchor was used in the query. A DOI or PMID anchor is near-deterministic — it filters to researchers who have linked that specific work to their ORCID record. Use this tool (not orcid_search_researchers) when the input is an ambiguous name that needs ranked disambiguation. No synthetic scores are used — raw signals only.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    name: z
      .string()
      .min(1)
      .describe(
        'Author name to disambiguate (full name preferred, e.g. "Jennifer Doudna" or "J. Doudna").',
      ),
    affiliation: z
      .string()
      .optional()
      .describe(
        "Researcher's institution or organization name. Used for institution overlap scoring and optionally as a search constraint.",
      ),
    doi: z
      .string()
      .optional()
      .describe(
        'DOI of a work authored by this researcher. Acts as a near-deterministic anchor — filters to researchers who linked this DOI to their ORCID record.',
      ),
    pmid: z
      .string()
      .optional()
      .describe(
        'PubMed ID of a work authored by this researcher. Acts as a near-deterministic anchor — filters to researchers who linked this PMID to their ORCID record.',
      ),
    rows: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe('Maximum candidate count to return (1–20). Defaults to 5.'),
  }),

  output: z.object({
    candidates: z
      .array(
        z
          .object({
            orcidId: z.string().describe('Candidate ORCID iD (bare format).'),
            orcidUri: z.string().describe('Full ORCID URI.'),
            givenNames: z.string().optional().describe('Given names from the ORCID record.'),
            familyNames: z.string().optional().describe('Family name from the ORCID record.'),
            creditName: z.string().optional().describe('Published credit name, if set.'),
            institutionNames: z
              .array(z.string().describe('Institution name.'))
              .describe('Affiliated institutions from the ORCID record.'),
            nameMatchType: z
              .enum(['exact', 'partial', 'other-name', 'none'])
              .describe(
                'How closely the candidate name matches the input name: exact (full match), partial (token overlap), other-name (match on alternate name), or none.',
              ),
            institutionOverlap: z
              .boolean()
              .describe(
                "True when the provided affiliation and one of the candidate's institutions are the same name, or one appears inside the other as a contiguous run of words (so an abbreviated form still matches its full name). A single shared word such as a city or surname is not enough.",
              ),
            anchorType: z
              .enum(['doi', 'pmid', 'none'])
              .describe(
                'Type of identifier anchor used in the query: doi, pmid, or none. A doi or pmid anchor means the candidate has linked that work to their ORCID record.',
              ),
          })
          .describe('Disambiguation candidate with transparency signals.'),
      )
      .describe('Ranked candidates, ordered by name match quality then institution overlap.'),
  }),

  errors: [
    {
      reason: 'query_failed',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'ORCID rejects a search built from the supplied name, affiliation, or identifier anchor.',
      recovery:
        'Check name for stray punctuation and verify doi or pmid is a real identifier, then retry with affiliation omitted.',
    },
  ],

  // Agent-facing context: the queries used, total match count, and empty-result guidance.
  // Reaches both structuredContent and content[] without a format() entry.
  enrichment: {
    queryUsed: z
      .string()
      .describe(
        'The Solr query that produced the returned candidates — the primary query, or the final relaxed query when a fallback ran. Paired with totalFound.',
      ),
    relaxedQuery: z
      .string()
      .optional()
      .describe(
        'Solr query used in a secondary relaxed search, if the primary returned no results.',
      ),
    totalFound: z
      .number()
      .describe(
        'Total ORCID records matching queryUsed (the query that produced the returned candidates).',
      ),
    primaryQuery: z
      .string()
      .describe(
        'The primary, most-constrained Solr query attempted first (name + optional anchor + optional affiliation). Always populated; equals queryUsed when no relaxed fallback ran.',
      ),
    primaryTotalFound: z
      .number()
      .describe(
        'Total ORCID records matching primaryQuery. Zero when the primary query found nothing and a relaxed fallback produced the returned candidates.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no candidates are found or when the anchor query failed to match.',
      ),
  },

  enrichmentTrailer: {
    queryUsed: { label: 'Query Used' },
    relaxedQuery: { label: 'Relaxed Query' },
    totalFound: { label: 'Total Found' },
    primaryQuery: { label: 'Primary Query' },
    primaryTotalFound: { label: 'Primary Total Found' },
  },

  async handler(input, ctx) {
    const service = getOrcidService();
    ctx.log.info('orcid_resolve_researcher', {
      name: input.name,
      hasAffiliation: !!input.affiliation,
      hasDoi: !!input.doi,
      hasPmid: !!input.pmid,
    });

    // Every search stage (primary, affiliation-relaxed, anchor-only) goes through here so
    // an upstream rejection carries the contract's recovery hint no matter which one fired.
    // Transient conditions keep their original code so the client retains the retryable
    // signal — the service layer has already exhausted its retry budget.
    const search = async (q: string) => {
      try {
        return await service.expandedSearch({ q, rows: input.rows }, ctx);
      } catch (err) {
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
          `ORCID could not complete the search for query: ${q}`,
          { ...ctx.recoveryFor('query_failed') },
          { cause: err },
        );
      }
    };

    // Model every supplied anchor as its own escaped clause, highest precedence first
    // (DOI before PMID). The anchor-only fallback retries each independently so a valid
    // anchor is never discarded when a wrong one zeroes out the combined query.
    const anchorClauses: { type: 'doi' | 'pmid'; clause: string }[] = [];
    if (input.doi?.trim()) {
      anchorClauses.push({ type: 'doi', clause: `doi-self:${escapeSolrValue(input.doi.trim())}` });
    }
    if (input.pmid?.trim()) {
      anchorClauses.push({
        type: 'pmid',
        clause: `pmid-self:${escapeSolrValue(input.pmid.trim())}`,
      });
    }

    // Describes the anchor that produced the returned candidates. Starts at the highest-
    // precedence supplied anchor (the one the combined query leads with) and is reassigned
    // if a lower-precedence anchor-only fallback is what actually matched.
    let anchorType: 'doi' | 'pmid' | 'none' = anchorClauses[0]?.type ?? 'none';

    // Build primary query: name + every supplied anchor + optional affiliation
    const primaryClauses: string[] = [
      `given-and-family-names:"${escapeSolrValue(input.name.trim())}"`,
      ...anchorClauses.map((a) => a.clause),
    ];
    if (input.affiliation?.trim()) {
      primaryClauses.push(`affiliation-org-name:"${escapeSolrValue(input.affiliation.trim())}"`);
    }
    const primaryQuery = primaryClauses.join(' AND ');

    const primaryResponse = await search(primaryQuery);

    let relaxedQuery: string | undefined;
    let finalResponse = primaryResponse;

    // Relaxed fallback: drop affiliation constraint if primary returned nothing
    if (primaryResponse.numFound === 0 && input.affiliation?.trim()) {
      const relaxedClauses = primaryClauses.filter((c) => !c.startsWith('affiliation-org-name:'));
      relaxedQuery = relaxedClauses.join(' AND ');
      finalResponse = await search(relaxedQuery);
    }

    // Anchor-only fallback: if the combined query (and its drop-affiliation relaxation)
    // still found nothing, retry each supplied anchor on its own — DOI first, then PMID —
    // and report the anchor that actually matched.
    if (finalResponse.numFound === 0 && anchorClauses.length > 0) {
      for (const anchor of anchorClauses) {
        relaxedQuery = anchor.clause;
        finalResponse = await search(anchor.clause);
        if (finalResponse.numFound > 0) {
          anchorType = anchor.type;
          break;
        }
      }
    }

    ctx.log.info('orcid_resolve_researcher completed', {
      primaryFound: primaryResponse.numFound,
      finalFound: finalResponse.numFound,
      candidateCount: finalResponse.results.length,
    });

    // Score and sort candidates
    const scored = finalResponse.results.map((r) => ({
      candidate: r,
      nameMatch: computeNameMatch(r, input.name),
      instOverlap: computeInstitutionOverlap(r, input.affiliation),
    }));

    // Sort: exact > partial > other-name > none, then institution overlap within each tier
    const matchOrder: NameMatchType[] = ['exact', 'partial', 'other-name', 'none'];
    scored.sort((a, b) => {
      const aOrder = matchOrder.indexOf(a.nameMatch);
      const bOrder = matchOrder.indexOf(b.nameMatch);
      if (aOrder !== bOrder) return aOrder - bOrder;
      // Within same tier, institution overlap comes first
      if (a.instOverlap !== b.instOverlap) return a.instOverlap ? -1 : 1;
      return 0;
    });

    const candidates = scored.map(({ candidate, nameMatch, instOverlap }) => ({
      orcidId: candidate.orcidId,
      orcidUri: `https://orcid.org/${candidate.orcidId}`,
      ...(candidate.givenNames && { givenNames: candidate.givenNames }),
      ...(candidate.familyNames && { familyNames: candidate.familyNames }),
      ...(candidate.creditName && { creditName: candidate.creditName }),
      institutionNames: candidate.institutionNames,
      nameMatchType: nameMatch,
      institutionOverlap: instOverlap,
      anchorType,
    }));

    // queryUsed/totalFound must describe the SAME query — the effective query that
    // produced the returned candidates (the primary query, or the last relaxed stage
    // when a fallback ran). primaryQuery/primaryTotalFound preserve the primary attempt.
    const effectiveQuery = relaxedQuery ?? primaryQuery;
    ctx.enrich({
      queryUsed: effectiveQuery,
      totalFound: finalResponse.numFound,
      primaryQuery,
      primaryTotalFound: primaryResponse.numFound,
    });
    if (relaxedQuery) ctx.enrich({ relaxedQuery });

    if (candidates.length === 0) {
      if (anchorType !== 'none') {
        ctx.enrich.notice(
          `No ORCID records found matching "${input.name}" with the provided ${anchorType.toUpperCase()} anchor. Verify the ${anchorType.toUpperCase()} is correct or try without the anchor using orcid_search_researchers.`,
        );
      } else {
        ctx.enrich.notice(
          `No ORCID records found matching "${input.name}". Try a different spelling or use orcid_search_researchers with a broader query.`,
        );
      }
    }

    return { candidates };
  },

  format: (result) => {
    const lines: string[] = [`## ORCID Disambiguation Results`];

    if (result.candidates.length === 0) {
      lines.push('', 'No candidates found.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('', `**Candidates (${result.candidates.length}):**`);
    result.candidates.forEach((c, i) => {
      const nameParts = [c.givenNames, c.familyNames].filter(Boolean);
      const displayName = c.creditName ?? (nameParts.length ? nameParts.join(' ') : c.orcidId);
      lines.push('');
      lines.push(`### ${i + 1}. ${displayName}`);
      lines.push(`**ORCID iD:** ${c.orcidId}`);
      lines.push(`**ORCID URI:** ${c.orcidUri}`);
      if (c.givenNames) lines.push(`**Given Names:** ${c.givenNames}`);
      if (c.familyNames) lines.push(`**Family Names:** ${c.familyNames}`);
      if (c.creditName) lines.push(`**Credit Name:** ${c.creditName}`);
      lines.push(`**Name Match:** ${c.nameMatchType}`);
      lines.push(`**Institution Overlap:** ${c.institutionOverlap ? 'Yes' : 'No'}`);
      lines.push(`**Anchor Type:** ${c.anchorType}`);
      if (c.institutionNames.length) {
        lines.push(`**Institutions:** ${c.institutionNames.join('; ')}`);
      }
    });

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
