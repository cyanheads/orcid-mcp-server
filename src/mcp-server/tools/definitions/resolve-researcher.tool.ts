/**
 * @fileoverview Disambiguate an author name to a verified ORCID iD. Returns a
 * ranked candidate list with transparent disambiguation signals: name match type,
 * institution overlap, and anchor type (doi/pmid/none).
 * @module mcp-server/tools/definitions/resolve-researcher.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { singleLine } from '@/mcp-server/tools/third-party-text.js';
import { getOrcidService } from '@/services/orcid/orcid-service.js';
import {
  escapeSolrValue,
  isInitial,
  splitNameWords,
  stripIdentifierPrefix,
} from '@/services/orcid/solr-query.js';
import { foldForMatching } from '@/services/orcid/text-folding.js';
import type { ExpandedSearchResult } from '@/services/orcid/types.js';

/**
 * Generic organization words that carry no disambiguating signal on their own. A name — or
 * a matched run — made of nothing but these words can't establish institution overlap, so
 * a bare "university"/"institute" never marks unrelated institutions as overlapping (#20),
 * in English or in the other languages ORCID affiliations commonly use (#46).
 *
 * Entries are compared against `contentTokens` output, so they are folded (no accents,
 * lowercase), and a word of 3 characters or fewer ("de", "di", "und", "för") never needs
 * listing — it is already dropped. The non-English entries are the same concepts as the
 * English ones, taken from live ORCID `affiliation-org-name` values; a word that names a
 * specific place or institution stays out even when it is also a common word ("para" is
 * the Brazilian state Pará, as in "Universidade Federal do Pará"; "dell" is the Italian
 * "dell'" but also "Dell Medical School").
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
  // University (es, pt, it, ca/de, fr, nl, sv/da/no) and its adjective forms.
  'universidad',
  'universidade',
  'universita',
  'universitat',
  'universite',
  'universiteit',
  'universitet',
  'universitetet',
  'universitario',
  'universitaria',
  'universitaire',
  'universitetssjukhuset',
  // Institute (fr/de, es/pt, it, nl, no, sv) and the Swedish department word.
  'institut',
  'instituto',
  'istituto',
  'instituut',
  'institutt',
  'institutet',
  'institutionen',
  // College and school.
  'colegio',
  'escuela',
  'escola',
  'ecole',
  'scuola',
  'hochschule',
  'hogeschool',
  'hogskolan',
  'hogskola',
  'skole',
  // Center and laboratory.
  'centro',
  'zentrum',
  'senter',
  'laboratoire',
  'laboratorio',
  'laboratorium',
  // Hospital.
  'hopital',
  'ospedale',
  'sjukhus',
  'sykehus',
  'ziekenhuis',
  // National and state.
  'nacional',
  'nazionale',
  'nationale',
  'nationaal',
  'estadual',
  // Connectives long enough to survive the length filter ("Università degli Studi di").
  'degli',
  'della',
  'delle',
  'voor',
  'studi',
]);

/** Rejection text for an empty or whitespace-only `name`; also the synthesized recovery hint. */
const BLANK_NAME_MESSAGE =
  'Provide a non-blank author name to disambiguate, such as "Jennifer Doudna" or "J. Doudna".';

/** Name match type based on how well the result name matches input. */
type NameMatchType = 'exact' | 'partial' | 'other-name' | 'none';

/**
 * Read a "Family, Given" name — exactly one comma, both sides non-blank — as "Given Family",
 * the order the phrase clause and the name comparison expect (#53). Any other name is trimmed.
 */
function reorderCommaName(name: string): string {
  const parts = name.split(',');
  if (parts.length === 2) {
    const [family, given] = parts.map((part) => part.trim());
    if (family && given) return `${given} ${family}`;
  }
  return name.trim();
}

/**
 * The byline clause for a name with initials (#53); undefined when the name has no initial or
 * nothing but initials. Two or more other words form a phrase whose slop absorbs the dropped
 * initials ("Jennifer A. Doudna" → `"Jennifer Doudna"~1`), which keeps phrase precision where
 * an AND of the words would rank repeated-word names ("Wei Wei Wang") above exact ones. One
 * other word pairs with the first initial as a prefix term ("J. Doudna" → `("Doudna" AND J*)`);
 * prefix terms on this field are case- and accent-folded, and a bare letter needs no escaping.
 */
function bylineClause(name: string): string | undefined {
  const words = splitNameWords(name);
  const initials = words.filter(isInitial);
  const others = words.filter((word) => !isInitial(word));
  const [firstInitial] = initials;
  if (!firstInitial || others.length === 0) return undefined;
  const phrase = escapeSolrValue(others.join(' '));
  return others.length > 1
    ? `given-and-family-names:"${phrase}"~${initials.length}`
    : `given-and-family-names:("${phrase}" AND ${firstInitial.normalize('NFC')}*)`;
}

/** Folded words of a name for token comparison; periods separate words ("J.A." → j, a). */
function matchTokens(name: string): string[] {
  return foldForMatching(name.replace(/\./g, ' ')).split(/\s+/).filter(Boolean);
}

function computeNameMatch(candidate: ExpandedSearchResult, inputName: string): NameMatchType {
  // Accent-insensitive on both sides (#35): a record often carries the ASCII rendering of an
  // accented name, and the input may be either form.
  const normalize = (s: string) => foldForMatching(s).trim();

  const normalizedInput = normalize(inputName);
  // A name with no letters or digits left has nothing to compare — and would otherwise
  // equal the empty string of a candidate with no credit name.
  if (!normalizedInput) return 'none';

  // Build full names from candidate
  const fullName = [candidate.givenNames, candidate.familyNames].filter(Boolean).join(' ');
  const creditName = candidate.creditName ?? '';

  if (normalize(fullName) === normalizedInput || normalize(creditName) === normalizedInput) {
    return 'exact';
  }

  // The input's first initial matches a name only through that name's first word ("J." for
  // "John"), never a middle initial elsewhere ("J. Smith" is not "Carolyn J Smith"), so it can
  // reach partial or other-name but never exact (#53). Every other input word needs the same
  // folded word in the name.
  const inputTokens = matchTokens(inputName);
  const firstInitial = splitNameWords(inputName).find(isInitial);
  const initial = firstInitial ? foldForMatching(firstInitial) : '';
  const initialAt = initial ? inputTokens.indexOf(initial) : -1;
  const wordTokens = inputTokens.filter((_, i) => i !== initialAt);
  const needed = Math.min(2, inputTokens.length);
  const covers = (nameTokens: string[], firstWord: string | undefined) => {
    const words = new Set(nameTokens);
    const initialHit = initialAt !== -1 && firstWord?.startsWith(initial) ? 1 : 0;
    return wordTokens.filter((t) => words.has(t)).length + initialHit >= needed;
  };

  if (covers(matchTokens(fullName), matchTokens(candidate.givenNames ?? '')[0])) {
    return 'partial';
  }

  // Check other-names
  for (const otherName of candidate.otherNames) {
    if (normalize(otherName) === normalizedInput) return 'other-name';
    const otherTokens = matchTokens(otherName);
    if (covers(otherTokens, otherTokens[0])) return 'other-name';
  }

  return 'none';
}

/**
 * Content words of an institution name, in order. Punctuation separates words
 * ("Max-Planck-Institute" → max, planck, institute) before the accent-insensitive fold
 * (#35), so "Université de Montréal" and "Universite de Montreal" produce the same words.
 * Tokens of 3 characters or fewer carry too little identity to match on. Generic org words
 * are deliberately *kept* — they position the distinctive words within the name, which is
 * what separates "University of Washington" from "Washington University".
 */
function contentTokens(name: string): string[] {
  return foldForMatching(name.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' '))
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
    'Disambiguate an author name to a verified ORCID iD. Returns ranked candidates (5 by default, up to 20 via the rows parameter) with transparent disambiguation signals: name match type (exact/partial/other-name/none), institution overlap flag, and whether a DOI or PMID anchor was used in the query. The name is searched as an exact phrase first; when that finds nothing, byline initials (J. Doudna, Jennifer A. Doudna) and then the other names listed on ORCID records are tried. A DOI or PMID anchor is near-deterministic — it filters to researchers who have linked that specific work to their ORCID record. Use this tool (not orcid_search_researchers) when the input is an ambiguous name that needs ranked disambiguation. No synthetic scores are used — raw signals only.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    name: z
      .string()
      .min(1, { message: BLANK_NAME_MESSAGE, abort: true })
      .refine((name) => name.trim().length > 0, { message: BLANK_NAME_MESSAGE })
      .describe(
        'Author name to disambiguate: a full name ("Jennifer Doudna"), a byline with initials ("J. Doudna", "Jennifer A. Doudna"), or "Family, Given" ("Doudna, Jennifer", read as Jennifer Doudna). The exact phrase is tried first; initials and other names listed on a record are fallbacks, so a full name gives the most precise candidates.',
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
        'DOI of a work authored by this researcher, bare (10.1126/science.1225829) or as a https://doi.org/, https://dx.doi.org/, or doi: form. Acts as a near-deterministic anchor — filters to researchers who linked this DOI to their ORCID record.',
      ),
    pmid: z
      .string()
      .optional()
      .describe(
        'PubMed ID of a work authored by this researcher, bare (22745249), as PMID:22745249, or as a pubmed.ncbi.nlm.nih.gov or ncbi.nlm.nih.gov/pubmed URL. Acts as a near-deterministic anchor — filters to researchers who linked this PMID to their ORCID record.',
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
                'How closely the candidate name matches the input name, compared case- and accent-insensitively (José = Jose): exact (full match), partial (token overlap, where an initial such as J. matches a first given name starting with J), other-name (match on alternate name), or none.',
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
        'The Solr query that produced the returned candidates — the primary query, or the last fallback stage run when the primary found nothing. Paired with totalFound.',
      ),
    relaxedQuery: z
      .string()
      .optional()
      .describe(
        'The last fallback stage run (byline initials, affiliation dropped, other names, or an anchor alone), present only when the primary query found nothing.',
      ),
    totalFound: z
      .number()
      .describe(
        'Total ORCID records matching queryUsed (the query that produced the returned candidates).',
      ),
    primaryQuery: z
      .string()
      .describe(
        'The primary, most-constrained Solr query attempted first (exact name phrase + optional anchor + optional affiliation). Always populated; equals queryUsed when no fallback ran.',
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
          undefined,
          { cause: err },
        );
      }
    };

    // Model every supplied anchor as its own escaped, phrase-quoted clause, highest
    // precedence first (DOI before PMID). The quotes keep a value with inner whitespace one
    // clause rather than extra query terms (#47). The anchor-only fallback retries each
    // independently so a valid anchor is never discarded when a wrong one zeroes out the
    // combined query. A URL-form identifier is reduced to the bare one ORCID indexes; one
    // that is only a prefix comes back empty and anchors nothing.
    const anchorClauses: { type: 'doi' | 'pmid'; clause: string }[] = [];
    const doi = input.doi && stripIdentifierPrefix('doi', input.doi);
    if (doi) {
      anchorClauses.push({ type: 'doi', clause: `doi-self:"${escapeSolrValue(doi)}"` });
    }
    const pmid = input.pmid && stripIdentifierPrefix('pmid', input.pmid);
    if (pmid) {
      anchorClauses.push({ type: 'pmid', clause: `pmid-self:"${escapeSolrValue(pmid)}"` });
    }

    // Describes the anchor that produced the returned candidates. Starts at the highest-
    // precedence supplied anchor (the one the combined query leads with) and is reassigned
    // if a lower-precedence anchor-only fallback is what actually matched.
    let anchorType: 'doi' | 'pmid' | 'none' = anchorClauses[0]?.type ?? 'none';

    // A "Family, Given" name is read as "Given Family" before any clause is built or compared.
    const name = reorderCommaName(input.name);
    const affiliation = input.affiliation?.trim();
    const affiliationClause = affiliation
      ? `affiliation-org-name:"${escapeSolrValue(affiliation)}"`
      : undefined;
    // Every name stage carries every anchor; only the phrase and byline stages are tried with
    // the affiliation first.
    const stage = (nameClause: string, withAffiliation: boolean) =>
      [
        nameClause,
        ...anchorClauses.map((a) => a.clause),
        ...(withAffiliation && affiliationClause ? [affiliationClause] : []),
      ].join(' AND ');

    // The exact phrase always runs first, so a name that matches as written sends one query
    // (#4). The later stages run in order, each only while every earlier one found
    // nothing (#53): byline initials with the affiliation, then the phrase and the byline
    // without it, then the other names listed on records. Folding other-names into the first
    // query was rejected — a hyphenated other name ("Chih-Wei Wang") contains a common name's
    // phrase and crowds exact matches out of the candidate pool.
    const phrase = `given-and-family-names:"${escapeSolrValue(name)}"`;
    const byline = bylineClause(name);
    const primaryQuery = stage(phrase, true);
    const fallbackQueries = [
      ...(byline && affiliationClause ? [stage(byline, true)] : []),
      ...(affiliationClause ? [stage(phrase, false)] : []),
      ...(byline ? [stage(byline, false)] : []),
      stage(`other-names:"${escapeSolrValue(name)}"`, false),
    ];

    const primaryResponse = await search(primaryQuery);

    let relaxedQuery: string | undefined;
    let finalResponse = primaryResponse;

    for (const query of fallbackQueries) {
      if (finalResponse.numFound > 0) break;
      relaxedQuery = query;
      finalResponse = await search(query);
    }

    // Anchor-only fallback: if every name stage still found nothing, retry each supplied
    // anchor on its own — DOI first, then PMID — and report the anchor that actually matched.
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
      nameMatch: computeNameMatch(r, name),
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
    // produced the returned candidates (the primary query, or the last fallback stage
    // run). primaryQuery/primaryTotalFound preserve the primary attempt.
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
      lines.push(`### ${i + 1}. ${singleLine(displayName)}`);
      lines.push(`**ORCID iD:** ${c.orcidId}`);
      lines.push(`**ORCID URI:** ${c.orcidUri}`);
      if (c.givenNames) lines.push(`**Given Names:** ${singleLine(c.givenNames)}`);
      if (c.familyNames) lines.push(`**Family Names:** ${singleLine(c.familyNames)}`);
      if (c.creditName) lines.push(`**Credit Name:** ${singleLine(c.creditName)}`);
      lines.push(`**Name Match:** ${c.nameMatchType}`);
      lines.push(`**Institution Overlap:** ${c.institutionOverlap ? 'Yes' : 'No'}`);
      lines.push(`**Anchor Type:** ${c.anchorType}`);
      if (c.institutionNames.length) {
        lines.push(`**Institutions:** ${c.institutionNames.map(singleLine).join('; ')}`);
      }
    });

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
