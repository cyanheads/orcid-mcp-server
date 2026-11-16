/**
 * @fileoverview Disambiguate an author name to a verified ORCID iD. Returns a
 * ranked candidate list with transparent disambiguation signals: name match type,
 * institution overlap, and anchor type (doi/pmid/none).
 * @module mcp-server/tools/definitions/resolve-researcher.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { joinNotices } from '@/mcp-server/tools/notices.js';
import { blockquote, singleLine } from '@/mcp-server/tools/third-party-text.js';
import { getOrcidService } from '@/services/orcid/orcid-service.js';
import {
  DOI_INPUT_PATTERN,
  doiSelfClause,
  escapeSolrValue,
  isInitial,
  PMID_INPUT_PATTERN,
  splitNameWords,
  stripIdentifierPrefix,
} from '@/services/orcid/solr-query.js';
import { foldForMatching, foldNameForMatching } from '@/services/orcid/text-folding.js';
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

/** The most candidates one search stage requests, and so the most the ranking can cover. */
const MAX_CANDIDATES = 20;

/** Name match type based on how well the result name matches input. */
type NameMatchType = 'exact' | 'partial' | 'other-name' | 'none';

/** A supplied DOI or PMID: its bare value and the clause every stage carries it as. */
type Anchor = { type: 'doi' | 'pmid'; value: string; clause: string };

/**
 * Notice part for candidates an anchor-only stage found (#85): no name stage matched a record
 * with every anchor supplied, and these were found by `answered` alone. With both anchors
 * supplied they may still hold the named person, so they are not called other people.
 */
function anchorOnlyNotice(name: string, anchors: Anchor[], answered: Anchor): string {
  const supplied = anchors.map((a) => `${a.type.toUpperCase()} ${a.value}`).join(' and ');
  return `No record matched "${name}" with ${supplied}; these candidates were found by the ${answered.type.toUpperCase()} alone.`;
}

/**
 * Notice part when the ranking covers `ranked` of `total` matches (#85), `''` when it covers
 * them all: a larger `rows` while `rows` is below what one stage can rank, and the search
 * tool's paging step once the matches outnumber the candidate cap.
 */
function rankingNotice(ranked: number, total: number, rows: number): string {
  if (total <= ranked) return '';
  const rankable = Math.min(total, MAX_CANDIDATES);
  return joinNotices(
    `The ranking covers ${ranked} of ${total.toLocaleString('en-US')} records matching queryUsed.`,
    rows < rankable &&
      `Call again with rows: ${rankable} to rank ${rankable === total ? 'all of them' : `the first ${rankable}`}.`,
    total > MAX_CANDIDATES &&
      `To list the records not ranked here, call orcid_search_researchers with query set to queryUsed and start: ${ranked}; it returns them in ORCID's relevance order, without match signals.`,
  );
}

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

/**
 * Folded words of a name for token comparison; periods separate words ("J.A." → j, a). A dash
 * joins the words beside it ("Min-Jun" → minjun) unless `fold` reads it as a space.
 */
function matchTokens(name: string, fold = foldForMatching): string[] {
  return fold(name.replace(/\./g, ' ')).split(/\s+/).filter(Boolean);
}

function computeNameMatch(candidate: ExpandedSearchResult, inputName: string): NameMatchType {
  // Accent-insensitive on both sides (#35): a record often carries the ASCII rendering of an
  // accented name, and the input may be either form. A dash is compared both ways — dropped
  // ("Min-Jun" = "Minjun") and read as a space ("Jean-Pierre" = "Jean Pierre") — since a name
  // is written in both spellings.
  const joined = (s: string) => foldForMatching(s).trim();
  const spaced = (s: string) => foldNameForMatching(s).trim();

  const inputJoined = joined(inputName);
  // A name with no letters or digits left has nothing to compare — and would otherwise
  // equal the empty string of a candidate with no credit name.
  if (!inputJoined) return 'none';
  const inputSpaced = spaced(inputName);
  const isInputName = (s: string) => joined(s) === inputJoined || spaced(s) === inputSpaced;

  // Build full names from candidate
  const fullName = [candidate.givenNames, candidate.familyNames].filter(Boolean).join(' ');
  const creditName = candidate.creditName ?? '';

  if (isInputName(fullName) || isInputName(creditName)) {
    return 'exact';
  }

  // The input's first initial matches a name only through that name's first word ("J." for
  // "John"), never a middle initial elsewhere ("J. Smith" is not "Carolyn J Smith"), so it can
  // reach partial or other-name but never exact (#53). Every other input word needs the same
  // folded word in the name.
  const firstInitial = splitNameWords(inputName).find(isInitial);
  const initial = firstInitial ? foldForMatching(firstInitial) : '';
  // The input's words joined at a dash and split at it ("Jean-Luc" → jeanluc; jean, luc), so a
  // dashed input word offers its parts as a dashed record word does.
  const inputForms = [matchTokens(inputName), matchTokens(inputName, foldNameForMatching)].map(
    (tokens) => {
      const initialAt = initial ? tokens.indexOf(initial) : -1;
      return {
        initialAt,
        needed: Math.min(2, tokens.length),
        wordTokens: tokens.filter((_, i) => i !== initialAt),
      };
    },
  );
  const covers = (name: string, firstWord: string | undefined) => {
    // A dashed record word offers its whole and its parts, so "Wei" matches in "Qian-Wei".
    const words = new Set([...matchTokens(name), ...matchTokens(name, foldNameForMatching)]);
    const initialHit = firstWord?.startsWith(initial) ? 1 : 0;
    return inputForms.some(
      ({ initialAt, needed, wordTokens }) =>
        wordTokens.filter((t) => words.has(t)).length + (initialAt !== -1 ? initialHit : 0) >=
        needed,
    );
  };

  if (covers(fullName, matchTokens(candidate.givenNames ?? '')[0])) {
    return 'partial';
  }

  // Check other-names
  for (const otherName of candidate.otherNames) {
    if (isInputName(otherName)) return 'other-name';
    if (covers(otherName, matchTokens(otherName)[0])) return 'other-name';
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
    'Disambiguate an author name to a verified ORCID iD. Returns ranked candidates (5 by default, at most 20 per search stage) with transparent disambiguation signals — name match type (exact/partial/other-name/none), institution overlap flag, and whether a DOI or PMID anchor was used in the query — plus the other names listed on each record. The name is searched as an exact phrase first; when that finds nothing, byline initials (J. Doudna, Jennifer A. Doudna) and then the other names listed on ORCID records are tried. A DOI or PMID anchor is near-deterministic — it filters to researchers who have linked that specific work to their ORCID record; when no name query finds a record with it, each anchor is tried alone and the notice says the candidates were found by the anchor alone. The ranking covers only the candidates returned: when totalFound is larger, the notice gives the rows value that ranks more and the orcid_search_researchers call that lists the rest, without match signals. Use this tool (not orcid_search_researchers) when the input is an ambiguous name that needs ranked disambiguation. No synthetic scores are used — raw signals only.',
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
      .regex(
        DOI_INPUT_PATTERN,
        'Provide doi as a complete DOI (10.1126/science.1225829), optionally prefixed by doi: or a doi.org URL; omit it or leave it blank when unknown.',
      )
      .optional()
      .describe(
        'Complete DOI of a work authored by this researcher, bare (10.1126/science.1225829) or as a https://doi.org/, https://dx.doi.org/, or doi: form. Requires 10., digits, a slash, and a non-whitespace suffix; blank means unset. Acts as a near-deterministic anchor — filters to researchers who linked this DOI to their ORCID record, matched in any letter case and whether the record holds it bare or as one of those forms.',
      ),
    pmid: z
      .string()
      .regex(
        PMID_INPUT_PATTERN,
        'Provide pmid as digits (22745249), optionally prefixed by PMID: or a PubMed URL; omit it or leave it blank when unknown.',
      )
      .optional()
      .describe(
        'Numeric PubMed ID of a work authored by this researcher, bare (22745249), as PMID:22745249, or as a pubmed.ncbi.nlm.nih.gov or ncbi.nlm.nih.gov/pubmed URL. Blank means unset; a label or URL without digits is invalid. Acts as a near-deterministic anchor — filters to researchers who linked this PMID to their ORCID record.',
      ),
    rows: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(5)
      .describe(
        'Candidates to return. Default 5; a larger value returns at most 20 per search stage and says so.',
      ),
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
            otherNames: z
              .array(z.string().describe('Alternative name.'))
              .describe('Other names listed on the ORCID record.'),
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
      .describe(
        'Ranked candidates, ordered by name match quality then institution overlap. The ranking covers only these: totalFound counts every record matching queryUsed, and when it is larger the notice says how to reach the rest.',
      ),
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

  // Agent-facing context: the queries used, total match count, and the notice (candidate cap,
  // anchor-only answer, ranking coverage, or empty-result guidance).
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
        'One string joining, in order: the requested/effective candidate cap; that the candidates were found by a DOI or PMID anchor alone, no record matching the name with the anchors supplied; and, when totalFound exceeds the candidates returned, how many the ranking covers, the rows value that ranks more, and the orcid_search_researchers call that lists the rest. With no candidates, the cap and recovery guidance instead.',
      ),
  },

  enrichmentTrailer: {
    queryUsed: { label: 'Query Used' },
    relaxedQuery: { label: 'Relaxed Query' },
    totalFound: { label: 'Total Found' },
    primaryQuery: { label: 'Primary Query' },
    primaryTotalFound: { label: 'Primary Total Found' },
    // The notice quotes the caller's name and anchors as written, so structuredContent carries
    // them raw; only this rendering escapes the whole notice, which is plain text throughout.
    notice: { render: (notice) => blockquote(escapeMarkdownInline(String(notice))) },
  },

  async handler(input, ctx) {
    const service = getOrcidService();
    const effectiveRows = Math.min(input.rows, MAX_CANDIDATES);
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
        return await service.expandedSearch({ q, rows: effectiveRows }, ctx);
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

    // Model every supplied anchor as its own clause, highest precedence first (DOI before
    // PMID): the DOI as one regex term matching every letter case and URL form it may be
    // deposited in (#84), the PMID escaped and phrase-quoted (#47). The anchor-only fallback
    // retries each independently so a valid anchor is never discarded when a wrong one zeroes
    // out the combined query. A URL-form identifier is reduced to the bare one; one that is
    // genuinely blank anchors nothing; malformed nonblank inputs fail validation.
    const anchorClauses: Anchor[] = [];
    const doi = input.doi && stripIdentifierPrefix('doi', input.doi);
    if (doi) {
      anchorClauses.push({ type: 'doi', value: doi, clause: doiSelfClause(doi) });
    }
    const pmid = input.pmid && stripIdentifierPrefix('pmid', input.pmid);
    if (pmid) {
      anchorClauses.push({
        type: 'pmid',
        value: pmid,
        clause: `pmid-self:"${escapeSolrValue(pmid)}"`,
      });
    }

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
    let answeredAlone: Anchor | undefined;
    if (finalResponse.numFound === 0 && anchorClauses.length > 0) {
      for (const anchor of anchorClauses) {
        relaxedQuery = anchor.clause;
        finalResponse = await search(anchor.clause);
        if (finalResponse.numFound > 0) {
          answeredAlone = anchor;
          break;
        }
      }
    }

    // The anchor that produced the candidates: the one an anchor-only stage matched, else the
    // highest-precedence supplied anchor, which every name stage leads its anchors with.
    const anchorType: Anchor['type'] | 'none' =
      answeredAlone?.type ?? anchorClauses[0]?.type ?? 'none';

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
      otherNames: candidate.otherNames,
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

    const capNotice =
      input.rows > effectiveRows &&
      `Requested rows ${input.rows}; using the maximum of ${effectiveRows} candidates per search stage.`;
    const resultNotice =
      candidates.length > 0
        ? joinNotices(
            answeredAlone && anchorOnlyNotice(input.name, anchorClauses, answeredAlone),
            rankingNotice(candidates.length, finalResponse.numFound, effectiveRows),
          )
        : anchorType !== 'none'
          ? `No ORCID records found matching "${input.name}" with the provided ${anchorType.toUpperCase()} anchor. Verify the ${anchorType.toUpperCase()} is correct or try without the anchor using orcid_search_researchers.`
          : `No ORCID records found matching "${input.name}". Try a different spelling or use orcid_search_researchers with a broader query.`;
    const notice = joinNotices(capNotice, resultNotice);
    if (notice) ctx.enrich.notice(notice);

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
      if (c.otherNames.length) {
        lines.push(`**Other Names:** ${c.otherNames.map(singleLine).join(', ')}`);
      }
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
