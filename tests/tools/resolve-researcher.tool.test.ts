/**
 * @fileoverview Tests for orcidResolveResearcher tool.
 * @module tests/tools/resolve-researcher.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';

const mockExpandedSearch = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ expandedSearch: mockExpandedSearch }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

// An unrouted search fails loudly; each test layers the responses it expects.
beforeEach(() => {
  mockExpandedSearch.mockReset();
  mockExpandedSearch.mockRejectedValue(new Error('unmocked fetch'));
});

/** The group a `doi-self` clause opens with: its URL and label prefixes, in any letter case. */
const DOI_PREFIX = String.raw`(([hH][tT][tT][pP][sS]?\:\/\/)?([dD][xX]\.)?[dD][oO][iI]\.[oO][rR][gG]\/|[dD][oO][iI]\:)?`;
/** The `doi-self` regex clause for 10.1126/science.1225829, in any letter case (#84). */
const SCIENCE_DOI = String.raw`doi-self:/${DOI_PREFIX}10\.1126\/[sS][cC][iI][eE][nN][cC][eE]\.1225829/`;

const doudnaResult = {
  orcidId: '0000-0001-9522-8779',
  givenNames: 'Jennifer',
  familyNames: 'Doudna',
  creditName: undefined,
  otherNames: [],
  emails: [],
  institutionNames: ['UC Berkeley', 'Innovative Genomics Institute'],
};

describe('orcidResolveResearcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a ranked candidate list for an exact name match', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [doudnaResult],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    const result = await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.orcidId).toBe('0000-0001-9522-8779');
    expect(candidate.orcidUri).toBe('https://orcid.org/0000-0001-9522-8779');
    expect(candidate.nameMatchType).toBe('exact');
    expect(candidate.institutionOverlap).toBe(false); // no affiliation provided
    expect(candidate.anchorType).toBe('none');
    expect(enrichment.totalFound).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('scores institution overlap correctly', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [doudnaResult],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'UC Berkeley',
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0]!.institutionOverlap).toBe(true);
  });

  it('sets anchorType to doi when doi is provided', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [doudnaResult],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      doi: '10.1126/science.1225829',
    });
    const result = await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.candidates[0]!.anchorType).toBe('doi');
    expect(enrichment.queryUsed).toBe(
      `given-and-family-names:"Jennifer Doudna" AND ${SCIENCE_DOI}`,
    );
  });

  it('falls back to relaxed query when primary returns nothing and affiliation provided', async () => {
    // Primary (with affiliation) returns 0
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });
    // Relaxed (without affiliation) returns 1
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 1, results: [doudnaResult] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'MIT',
    });
    await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.relaxedQuery).toBeDefined();
    expect(enrichment.relaxedQuery).not.toContain('affiliation-org-name:');
  });

  it('falls back to anchor-only query when name+anchor returns nothing', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] }); // name + doi
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] }); // other names + doi
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [doudnaResult],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      doi: '10.1126/science.1225829',
    });
    await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.relaxedQuery).toBe(SCIENCE_DOI);
  });

  it('adds notice enrichment when no candidates found and returns empty list', async () => {
    mockExpandedSearch.mockResolvedValue({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Extremely Rare Name XYZ' });
    const result = await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.candidates).toHaveLength(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('Extremely Rare Name XYZ');
  });

  it('sorts candidates: exact before partial', async () => {
    // "Jennifer Doudna Lopez" shares two words with "Jennifer Doudna": partial, not exact.
    const partialMatch = {
      orcidId: '0000-0002-1111-2222',
      givenNames: 'Jennifer Doudna',
      familyNames: 'Lopez',
      creditName: undefined,
      otherNames: [],
      emails: [],
      institutionNames: [],
    };
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 2,
      results: [partialMatch, doudnaResult], // partial first in API response
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0]!.orcidId).toBe('0000-0001-9522-8779'); // exact match first
    expect(result.candidates[0]!.nameMatchType).toBe('exact');
    expect(result.candidates[1]!.nameMatchType).toBe('partial');
  });

  it('phrase-quotes the full name in the primary Solr clause (#4)', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 1, results: [doudnaResult] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    await orcidResolveResearcher.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    // Name must be phrase-quoted so Solr matches the full name, not individual tokens
    expect(callParams.q).toContain('given-and-family-names:"Jennifer Doudna"');
    expect(callParams.q).not.toContain('given-and-family-names:Jennifer Doudna');
  });

  it('phrase-quotes multi-word name in the primary Solr clause (#4)', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 1, results: [doudnaResult] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Mary Ann Smith' });
    await orcidResolveResearcher.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('given-and-family-names:"Mary Ann Smith"');
  });

  it('surfaces a service error as the query_failed contract, keeping the original as cause', async () => {
    const upstream = new Error('Connection refused');
    mockExpandedSearch.mockRejectedValueOnce(upstream);

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    const err = (await Promise.resolve(orcidResolveResearcher.handler(input, ctx)).catch(
      (e: unknown) => e,
    )) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.data?.reason).toBe('query_failed');
    expect(err.cause).toBe(upstream);
  });

  it('formats candidates with disambiguation signals', () => {
    const output = orcidResolveResearcher.output.parse({
      candidates: [
        {
          orcidId: '0000-0001-9522-8779',
          orcidUri: 'https://orcid.org/0000-0001-9522-8779',
          givenNames: 'Jennifer',
          familyNames: 'Doudna',
          otherNames: [],
          institutionNames: ['UC Berkeley'],
          nameMatchType: 'exact',
          institutionOverlap: true,
          anchorType: 'none',
        },
      ],
    });

    const blocks = orcidResolveResearcher.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0001-9522-8779');
    expect(text).toContain('https://orcid.org/0000-0001-9522-8779');
    expect(text).toContain('Jennifer Doudna');
    expect(text).toContain('exact');
    expect(text).toContain('Yes'); // institutionOverlap
    expect(text).toContain('none'); // anchorType
    expect(text).toContain('UC Berkeley');
  });

  it('formats result with no candidates', () => {
    const output = orcidResolveResearcher.output.parse({
      candidates: [],
    });

    const blocks = orcidResolveResearcher.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No candidates found');
  });
});

describe('orcidResolveResearcher — count/query pairing (#15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports primaryQuery/primaryTotalFound equal to queryUsed/totalFound when no fallback runs', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 3, results: [doudnaResult] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.relaxedQuery).toBeUndefined();
    expect(enrichment.queryUsed).toBe(enrichment.primaryQuery);
    expect(enrichment.totalFound).toBe(3);
    expect(enrichment.primaryTotalFound).toBe(3);
  });

  it('pairs queryUsed with totalFound from the final response after a drop-affiliation fallback', async () => {
    // Primary (affiliation-constrained) finds nothing; relaxed (name-only) finds records.
    mockExpandedSearch
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 5, results: [doudnaResult] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'University of California Berkeley',
    });
    await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    // queryUsed is the query that actually produced totalFound — the relaxed one, not the primary.
    expect(enrichment.queryUsed).not.toContain('affiliation-org-name:');
    expect(enrichment.queryUsed).toBe(enrichment.relaxedQuery);
    expect(enrichment.totalFound).toBe(5); // from the relaxed response, not the primary's 0

    // primary* fields preserve the constrained first attempt's audit trail.
    expect(enrichment.primaryQuery).toContain('affiliation-org-name:');
    expect(enrichment.primaryTotalFound).toBe(0);
  });

  it('keeps queryUsed/totalFound paired through every relaxed stage in sequence', async () => {
    // Stage 0 primary (name + doi + affiliation) → 0
    // Stage 1 drop-affiliation (name + doi) → 0
    // Stage 2 other names (other-names + doi) → 0
    // Stage 3 anchor-only (doi) → 4
    mockExpandedSearch
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 4, results: [doudnaResult] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'University of California Berkeley',
      doi: '10.1126/science.1225829',
    });
    await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    // Four upstream calls: primary, drop-affiliation, other names, anchor-only.
    expect(mockExpandedSearch.mock.calls.map(([params]) => params.q)).toEqual([
      `given-and-family-names:"Jennifer Doudna" AND ${SCIENCE_DOI} AND affiliation-org-name:"University of California Berkeley"`,
      `given-and-family-names:"Jennifer Doudna" AND ${SCIENCE_DOI}`,
      `other-names:"Jennifer Doudna" AND ${SCIENCE_DOI}`,
      SCIENCE_DOI,
    ]);

    // Effective query is the anchor-only stage that finally matched.
    expect(enrichment.queryUsed).toBe(SCIENCE_DOI);
    expect(enrichment.queryUsed).toBe(enrichment.relaxedQuery);
    expect(enrichment.totalFound).toBe(4); // from the anchor-only response

    // primaryQuery still describes the fully-constrained first attempt.
    expect(enrichment.primaryQuery).toContain('affiliation-org-name:');
    expect(enrichment.primaryQuery).toContain(SCIENCE_DOI);
    expect(enrichment.primaryTotalFound).toBe(0);
  });
});

describe('orcidResolveResearcher — dual DOI+PMID anchor fallback (#19)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recovers via the PMID anchor when a wrong DOI zeroes the combined query', async () => {
    // Stage 0 combined (name AND doi AND pmid) → 0 because the DOI is wrong.
    // Stage 1 other names (other-names AND doi AND pmid) → 0.
    // Stage 2 anchor-only DOI → 0 (still the wrong DOI).
    // Stage 3 anchor-only PMID → 1 (the valid PMID) — must NOT be discarded.
    mockExpandedSearch
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 1, results: [doudnaResult] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      doi: '10.0000/not-real',
      pmid: '41961593',
      rows: 3,
    });
    const result = await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    // Four upstream calls: combined primary, other names, DOI-only, PMID-only.
    expect(mockExpandedSearch).toHaveBeenCalledTimes(4);
    // The valid PMID anchor produced the candidate and is reported as the anchor used.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.anchorType).toBe('pmid');
    expect(enrichment.queryUsed).toBe('pmid-self:"41961593"');
    expect(enrichment.relaxedQuery).toBe('pmid-self:"41961593"');
  });

  it('prefers the DOI anchor and never tries PMID when the DOI matches', async () => {
    // Stage 0 combined (name AND doi AND pmid) → 0 because the PMID is wrong.
    // Stage 1 other names (other-names AND doi AND pmid) → 0.
    // Stage 2 anchor-only DOI → matches, so the PMID clause is never queried.
    mockExpandedSearch
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 2, results: [doudnaResult] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      doi: '10.1126/science.1225829',
      pmid: '00000000',
    });
    const result = await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(mockExpandedSearch).toHaveBeenCalledTimes(3); // combined, other names, DOI-only (PMID skipped)
    expect(result.candidates[0]!.anchorType).toBe('doi');
    expect(enrichment.relaxedQuery).toBe(SCIENCE_DOI);
  });

  it('names the DOI in the empty-result notice when neither anchor finds anything', async () => {
    // Every stage is empty, the PMID-only one last: no anchor answered, so the notice keeps
    // the highest-precedence anchor rather than the last one tried.
    mockExpandedSearch.mockResolvedValue({ numFound: 0, results: [] });
    const notice =
      'No ORCID records found matching "Jennifer Doudna" with the provided DOI anchor. Verify the DOI is correct or try without the anchor using orcid_search_researchers.';

    const result = await runToolContract(orcidResolveResearcher, {
      name: 'Jennifer Doudna',
      doi: '10.0000/not-real',
      pmid: '00000000',
    });
    const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');

    // Combined primary, other names, DOI-only, PMID-only.
    expect(mockExpandedSearch).toHaveBeenCalledTimes(4);
    expect(result.structuredContent).toMatchObject({
      candidates: [],
      relaxedQuery: 'pmid-self:"00000000"',
      notice,
    });
    expect(text.split('\n').filter((line) => line.startsWith('> '))).toEqual([`> ${notice}`]);
  });
});

describe('orcidResolveResearcher — blank name is rejected at the schema (#34)', () => {
  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['a tab', '\t'],
  ])(
    'rejects a %s name with invalid_arguments and an actionable recovery hint',
    async (_, name) => {
      const result = await runToolContract(orcidResolveResearcher, { name });

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as {
          error: { code: number; data: { reason: string; recovery: { hint: string } } };
        }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data.reason).toBe('invalid_arguments');
      expect(error.data.recovery.hint).toMatch(/author name/i);
      expect(mockExpandedSearch).not.toHaveBeenCalled();
    },
  );

  it('accepts a name that is non-blank after trimming', () => {
    expect(orcidResolveResearcher.input.parse({ name: ' Doudna ' }).name).toBe(' Doudna ');
  });
});

describe('orcidResolveResearcher — DOI/PMID URL anchors (#44, #84)', () => {
  async function primaryQuery(raw: Record<string, unknown>): Promise<string> {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 1, results: [doudnaResult] });
    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    await orcidResolveResearcher.handler(orcidResolveResearcher.input.parse(raw), ctx);
    return getEnrichment(ctx).primaryQuery as string;
  }

  it.each([
    'https://doi.org/10.1126/science.1225829',
    'https://dx.doi.org/10.1126/science.1225829',
    'doi:10.1126/science.1225829',
    'Doi:10.1126/science.1225829',
    '10.1126/SCIENCE.1225829',
  ])('anchors %s exactly like the bare DOI', async (doi) => {
    expect(await primaryQuery({ name: 'Jennifer Doudna', doi })).toBe(
      `given-and-family-names:"Jennifer Doudna" AND ${SCIENCE_DOI}`,
    );
  });

  it('resolves the named researcher from the primary query whatever case the DOI is given in', async () => {
    const jamesBeilstenEdmands = {
      ...doudnaResult,
      orcidId: '0000-0003-1565-5328',
      givenNames: 'James',
      familyNames: 'Beilsten-Edmands',
      institutionNames: [],
    };
    const primary = String.raw`given-and-family-names:"James Beilsten\-Edmands" AND doi-self:/${DOI_PREFIX}10\.1088\/1361\-648[xX]\/[aA][aA][bB]193/`;
    mockExpandedSearch.mockImplementation(async ({ q }: { q: string }) => {
      if (q !== primary) throw new Error(`unmocked query: ${q}`);
      return { numFound: 1, results: [jamesBeilstenEdmands] };
    });

    for (const doi of ['10.1088/1361-648X/aab193', '10.1088/1361-648x/aab193']) {
      mockExpandedSearch.mockClear();
      const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
      const result = await orcidResolveResearcher.handler(
        orcidResolveResearcher.input.parse({ name: 'James Beilsten-Edmands', doi }),
        ctx,
      );

      expect(mockExpandedSearch).toHaveBeenCalledTimes(1);
      expect(result.candidates.map((c) => [c.orcidId, c.nameMatchType, c.anchorType])).toEqual([
        ['0000-0003-1565-5328', 'exact', 'doi'],
      ]);
      expect(getEnrichment(ctx).queryUsed).toBe(primary);
    }
  });

  it.each([
    'https://pubmed.ncbi.nlm.nih.gov/22745249/',
    'https://www.ncbi.nlm.nih.gov/pubmed/22745249',
    'https://pubmed.ncbi.nlm.nih.gov/22745249/?from_single_result=22745249',
    'PMID: 22745249',
  ])('anchors %s exactly like the bare PMID', async (pmid) => {
    expect(await primaryQuery({ name: 'Jennifer Doudna', pmid })).toBe(
      'given-and-family-names:"Jennifer Doudna" AND pmid-self:"22745249"',
    );
  });

  it('keeps a valid PMID anchor inside its own phrase clause (#47)', async () => {
    expect(await primaryQuery({ name: 'Jennifer Doudna', pmid: '22745249' })).toBe(
      'given-and-family-names:"Jennifer Doudna" AND pmid-self:"22745249"',
    );
  });

  it('treats a genuinely blank DOI as no anchor rather than an empty clause', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 1, results: [doudnaResult] });
    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const result = await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna', doi: ' \t ' }),
      ctx,
    );

    expect(getEnrichment(ctx).primaryQuery).toBe('given-and-family-names:"Jennifer Doudna"');
    expect(result.candidates[0]!.anchorType).toBe('none');
  });
});
