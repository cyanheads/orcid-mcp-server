/**
 * @fileoverview Extended coverage for orcidResolveResearcher: pmid anchor, credit name
 * matching, other-name matching, institution overlap matching, error contract, edge cases.
 * @module tests/tools/resolve-researcher-extended.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';
import type { ExpandedSearchResult } from '@/services/orcid/types.js';

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

const baseCandidate = {
  orcidId: '0000-0001-9522-8779',
  givenNames: 'Jennifer',
  familyNames: 'Doudna',
  creditName: undefined,
  otherNames: [],
  emails: [],
  institutionNames: ['UC Berkeley', 'Innovative Genomics Institute'],
};

describe('orcidResolveResearcher — pmid anchor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets anchorType to pmid and includes pmid-self in query when pmid provided', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [baseCandidate],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      pmid: '22745249',
    });
    const result = await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.candidates[0]!.anchorType).toBe('pmid');
    expect(enrichment.queryUsed).toContain('pmid-self:"22745249"');
  });

  it('falls back to pmid-only query when name+pmid returns nothing', async () => {
    mockExpandedSearch
      .mockResolvedValueOnce({ numFound: 0, results: [] }) // name + pmid returns nothing
      .mockResolvedValueOnce({ numFound: 1, results: [baseCandidate] }); // pmid-only fallback

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      pmid: '22745249',
    });
    await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.relaxedQuery).toBe('pmid-self:"22745249"');
  });
});

describe('orcidResolveResearcher — name match types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects exact match via creditName', async () => {
    const candidateWithCredit = {
      ...baseCandidate,
      creditName: 'Jennifer A. Doudna',
    };
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [candidateWithCredit],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer A. Doudna' });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0]!.nameMatchType).toBe('exact');
  });

  it('detects other-name match when input matches an alternate name', async () => {
    const candidateWithOtherName = {
      ...baseCandidate,
      givenNames: 'Jennifer Anne',
      familyNames: 'Doudna-Chen',
      otherNames: ['Jennifer Doudna'],
    };
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [candidateWithOtherName],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0]!.nameMatchType).toBe('other-name');
  });

  it.each([
    ["O'Brien Walsh", 'OBrien', 'Walsh'],
    ['J. Doudna', 'J', 'Doudna'],
    ['Jean-Luc Picard', 'Jean-Luc', 'Picard'],
  ])(
    'drops ASCII punctuation on both sides: "%s" is an exact match',
    async (name, given, family) => {
      mockExpandedSearch.mockResolvedValueOnce({
        numFound: 1,
        results: [{ ...baseCandidate, givenNames: given, familyNames: family }],
      });

      const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
      const result = await orcidResolveResearcher.handler(
        orcidResolveResearcher.input.parse({ name }),
        ctx,
      );

      expect(result.candidates[0]!.nameMatchType).toBe('exact');
    },
  );

  it('trims surrounding whitespace from the name before compiling the clause', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 1, results: [baseCandidate] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const result = await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({ name: '  Jennifer Doudna \t' }),
      ctx,
    );

    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('given-and-family-names:"Jennifer Doudna"');
    expect(result.candidates[0]!.nameMatchType).toBe('exact');
  });

  it('returns none when no tokens match', async () => {
    const unrelatedCandidate = {
      orcidId: '0000-0009-1111-2222',
      givenNames: 'Robert',
      familyNames: 'Smith',
      creditName: undefined,
      otherNames: [],
      emails: [],
      institutionNames: [],
    };
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [unrelatedCandidate],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0]!.nameMatchType).toBe('none');
  });
});

describe('orcidResolveResearcher — institution overlap scoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false overlap when affiliation consists only of short tokens', async () => {
    // Tokens <= 3 chars are filtered: "UC" (2) and "The" (3) skip
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [{ ...baseCandidate, institutionNames: ['UC Berkeley'] }],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'UC', // all tokens <= 3 chars — no overlap possible
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0]!.institutionOverlap).toBe(false);
  });

  it('returns false overlap when affiliation is empty', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [baseCandidate],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      // no affiliation
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0]!.institutionOverlap).toBe(false);
  });

  it('returns true overlap for partial institution name match', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [{ ...baseCandidate, institutionNames: ['Innovative Genomics Institute'] }],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'Genomics Institute',
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0]!.institutionOverlap).toBe(true);
  });

  it('ignores generic org stopwords so unrelated institutions do not falsely overlap (#20)', async () => {
    // "University of California Berkeley" → distinctive tokens are california/berkeley;
    // "university"/"of" are generic stopwords that must not signal overlap on their own.
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 3,
      results: [
        {
          ...baseCandidate,
          orcidId: '0000-0001-9522-8779',
          institutionNames: ['University of Vermont'],
        },
        {
          ...baseCandidate,
          orcidId: '0000-0002-1111-2222',
          institutionNames: ['Pennsylvania State University'],
        },
        {
          ...baseCandidate,
          orcidId: '0000-0003-3333-4444',
          institutionNames: ['University of Washington'],
        },
      ],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Bob Smith',
      affiliation: 'University of California Berkeley',
      rows: 10,
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    for (const candidate of result.candidates) {
      expect(candidate.institutionOverlap).toBe(false);
    }
  });

  it('still reports overlap on a distinctive token match after stopword filtering (#20)', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [{ ...baseCandidate, institutionNames: ['University of California Berkeley'] }],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Bob Smith',
      affiliation: 'University of California Berkeley',
      rows: 10,
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    // 'california'/'berkeley' are distinctive and present in the candidate institution.
    expect(result.candidates[0]!.institutionOverlap).toBe(true);
  });
});

describe('orcidResolveResearcher — Solr value escaping (#18)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('escapes embedded quotes in the name phrase clause', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Jean "Bob" Smith' });
    await orcidResolveResearcher.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    // Embedded quotes are escaped so they cannot break out of the phrase into a raw clause.
    expect(callParams.q).toBe('given-and-family-names:"Jean \\"Bob\\" Smith"');
  });

  it('escapes reserved characters in the affiliation phrase clause', async () => {
    // Primary (with affiliation) returns nothing, so a relaxed pass fires — two responses.
    mockExpandedSearch
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jane Roe',
      affiliation: 'Foo & Bar (Institute)',
    });
    await orcidResolveResearcher.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toContain('affiliation-org-name:"Foo \\& Bar \\(Institute\\)"');
  });

  it('escapes the slash in a DOI anchor clause', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 1, results: [baseCandidate] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      doi: '10.1126/science.1225829',
    });
    await orcidResolveResearcher.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toContain('doi-self:"10.1126\\/science.1225829"');
  });
});

describe('orcidResolveResearcher — empty-result notice content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('notice for doi anchor references DOI in message', async () => {
    mockExpandedSearch.mockResolvedValue({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      doi: '10.1126/science.9999999',
    });
    await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('DOI');
  });

  it('notice for pmid anchor references PMID in message', async () => {
    mockExpandedSearch.mockResolvedValue({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      pmid: '00000000',
    });
    await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('PMID');
  });
});

describe('orcidResolveResearcher — sorting with institution overlap tiebreak', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('within exact-match tier, institution overlap comes first', async () => {
    const exactNoOverlap = {
      orcidId: '0000-0009-8888-7777',
      givenNames: 'Jennifer',
      familyNames: 'Doudna',
      creditName: undefined,
      otherNames: [],
      emails: [],
      institutionNames: ['MIT'],
    };
    const exactWithOverlap = {
      ...baseCandidate,
      institutionNames: ['UC Berkeley'],
    };
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 2,
      results: [exactNoOverlap, exactWithOverlap], // overlap candidate second in response
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'Berkeley',
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    // Both are exact matches; overlap one should sort first
    expect(result.candidates[0]!.orcidId).toBe('0000-0001-9522-8779'); // UC Berkeley match
    expect(result.candidates[0]!.institutionOverlap).toBe(true);
    expect(result.candidates[1]!.institutionOverlap).toBe(false);
  });
});

describe('orcidResolveResearcher — format edge cases', () => {
  it('shows creditName in formatted output when present', () => {
    const output = orcidResolveResearcher.output.parse({
      candidates: [
        {
          orcidId: '0000-0001-9522-8779',
          orcidUri: 'https://orcid.org/0000-0001-9522-8779',
          givenNames: 'Jennifer',
          familyNames: 'Doudna',
          creditName: 'Jennifer A. Doudna',
          institutionNames: ['UC Berkeley'],
          nameMatchType: 'exact',
          institutionOverlap: true,
          anchorType: 'none',
        },
      ],
    });

    const blocks = orcidResolveResearcher.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Jennifer A. Doudna');
    expect(text).toContain('Credit Name');
  });

  it('shows No when institutionOverlap is false', () => {
    const output = orcidResolveResearcher.output.parse({
      candidates: [
        {
          orcidId: '0000-0001-9522-8779',
          orcidUri: 'https://orcid.org/0000-0001-9522-8779',
          institutionNames: [],
          nameMatchType: 'exact',
          institutionOverlap: false,
          anchorType: 'none',
        },
      ],
    });

    const blocks = orcidResolveResearcher.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No'); // institutionOverlap: No
  });

  it('shows candidate count in header', () => {
    const output = orcidResolveResearcher.output.parse({
      candidates: [
        {
          orcidId: '0000-0001-9522-8779',
          orcidUri: 'https://orcid.org/0000-0001-9522-8779',
          institutionNames: [],
          nameMatchType: 'exact',
          institutionOverlap: false,
          anchorType: 'doi',
        },
      ],
    });

    const blocks = orcidResolveResearcher.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Candidates (1)');
  });
});

describe('orcidResolveResearcher — institution overlap needs a whole shared name (#27)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function overlapFor(affiliation: string, institution: string): Promise<boolean> {
    // numFound: 1 keeps the handler on the primary query — no relaxed fallback call.
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [{ ...baseCandidate, institutionNames: [institution] }],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna', affiliation });
    const result = await orcidResolveResearcher.handler(input, ctx);
    return result.candidates[0]!.institutionOverlap;
  }

  it.each([
    ['University of Washington', 'George Washington University'],
    ['University of Washington', 'Washington State University'],
    ['University of Washington', 'Washington University in St. Louis'],
    ['Miami University', 'University of Miami'],
  ])('does not report overlap for "%s" against "%s"', async (affiliation, institution) => {
    expect(await overlapFor(affiliation, institution)).toBe(false);
  });

  it.each([
    ['University of Washington', 'University of Washington'],
    ['Washington University in St. Louis', 'Washington University'],
    ['Innovative Genomics Institute', 'Innovative Genomics Institute'],
    ['UC Berkeley', 'University of California, Berkeley'],
    // Punctuation splits words, so a hyphenated rendering matches its spaced form.
    ['Max Planck Institute', 'Max-Planck-Institute of Biology'],
  ])('still reports overlap for "%s" against "%s"', async (affiliation, institution) => {
    expect(await overlapFor(affiliation, institution)).toBe(true);
  });

  it('clears the reported case: Howard Eisner at George Washington University', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [
        {
          ...baseCandidate,
          orcidId: '0000-0002-5176-5500',
          givenNames: 'Howard',
          familyNames: 'Eisner',
          institutionNames: ['George Washington University', 'The George Washington University'],
        },
      ],
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Howard Eisner',
      affiliation: 'University of Washington',
      rows: 5,
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0]!.institutionOverlap).toBe(false);
  });

  it('documents the residual: a shorter name that is a whole run of a longer one matches', async () => {
    // "Washington University" is a contiguous run of "George Washington University".
    // Anchoring the run would close this, but would also reject "UC Berkeley" against
    // "University of California, Berkeley" — see sharesWholeRun for the reasoning.
    expect(await overlapFor('Washington University', 'George Washington University')).toBe(true);
  });
});

describe('orcidResolveResearcher — query_failed contract (#31)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries reason and a recovery hint naming the input fields on a non-transient failure', async () => {
    // The service's classification of ORCID's 500 Solr query rejection.
    mockExpandedSearch.mockRejectedValueOnce(
      new McpError(
        JsonRpcErrorCode.InvalidParams,
        'ORCID returned HTTP 500 Internal Server Error.',
      ),
    );

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    const err = (await Promise.resolve(orcidResolveResearcher.handler(input, ctx)).catch(
      (e: unknown) => e,
    )) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    const data = err.data as Record<string, unknown>;
    expect(data.reason).toBe('query_failed');
    // This tool has no raw query field — the hint points at the inputs it does have.
    const hint = (data.recovery as { hint: string }).hint;
    expect(hint).toContain('name');
    expect(hint).toContain('doi');
    expect(hint).toContain('pmid');
    expect(hint).toContain('affiliation');
    expect(JSON.stringify(data)).not.toContain('orcid.org');
  });

  it('covers a failure in the anchor-only fallback, not just the primary search', async () => {
    mockExpandedSearch
      .mockResolvedValueOnce({ numFound: 0, results: [] }) // primary: name + doi + affiliation
      .mockResolvedValueOnce({ numFound: 0, results: [] }) // relaxed: affiliation dropped
      .mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.InvalidParams, 'ORCID returned HTTP 400 Bad Request.'),
      ); // anchor-only

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'UC Berkeley',
      doi: '10.1126/science.1225829',
    });
    const err = (await Promise.resolve(orcidResolveResearcher.handler(input, ctx)).catch(
      (e: unknown) => e,
    )) as McpError;

    expect(mockExpandedSearch).toHaveBeenCalledTimes(3);
    expect(err.data?.reason).toBe('query_failed');
    expect(err.message).toContain('doi-self:');
  });

  it('rethrows a transient upstream failure unchanged so the retryable signal survives', async () => {
    const upstream = new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      'ORCID returned HTTP 503 Service Unavailable.',
      { status: 503, retryAfter: '30' },
    );
    mockExpandedSearch.mockRejectedValueOnce(upstream);

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    const err = await Promise.resolve(orcidResolveResearcher.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toBe(upstream);
  });
});

describe('orcidResolveResearcher — accent-insensitive name matching (#35)', () => {
  async function matchTypeFor(
    name: string,
    candidate: Partial<ExpandedSearchResult>,
  ): Promise<string> {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [{ ...baseCandidate, ...candidate }],
    });
    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const result = await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({ name }),
      ctx,
    );
    return result.candidates[0]!.nameMatchType;
  }

  it.each([
    ['José Baselga', { givenNames: 'Jose', familyNames: 'Baselga' }],
    ['Jose Baselga', { givenNames: 'José', familyNames: 'Baselga' }],
    ['JOSÉ BASELGA', { givenNames: 'josé', familyNames: 'baselga' }],
    // Decomposed input (e + U+0301) folds the same as the precomposed record.
    ['Jose\u0301 Baselga', { givenNames: 'José', familyNames: 'Baselga' }],
  ])('"%s" is an exact match for the equivalent given/family pair', async (name, candidate) => {
    expect(await matchTypeFor(name, candidate)).toBe('exact');
  });

  it('folds the credit name the same way', async () => {
    expect(
      await matchTypeFor('Jose Baselga', {
        givenNames: 'J.',
        familyNames: 'Baselga-Torres',
        creditName: 'José Baselga',
      }),
    ).toBe('exact');
  });

  it('folds every other-name entry the same way', async () => {
    expect(
      await matchTypeFor('Zoe Muller', {
        givenNames: 'Z.',
        familyNames: 'Mueller-Smith',
        otherNames: ['Z. M. Smith', 'Zoë Müller'],
      }),
    ).toBe('other-name');
  });

  it('counts folded tokens toward a partial match', async () => {
    expect(
      await matchTypeFor('José María Baselga', { givenNames: 'Jose', familyNames: 'Baselga' }),
    ).toBe('partial');
  });

  it('keeps the two-token threshold: one shared folded token is still none', async () => {
    expect(await matchTypeFor('José Baselga', { givenNames: 'Jose', familyNames: 'Smith' })).toBe(
      'none',
    );
  });

  it('keeps unrelated accented names at none', async () => {
    expect(
      await matchTypeFor('François Müller', { givenNames: 'Robert', familyNames: 'Smith' }),
    ).toBe('none');
  });

  it.each([
    ['山中 伸弥', { givenNames: 'Robert', familyNames: 'Smith' }, 'none'],
    ['山中 伸弥', { givenNames: 'Robert', familyNames: 'Smith', creditName: '山中 伸弥' }, 'exact'],
    ['김 철수', { givenNames: '철수', familyNames: '김' }, 'partial'],
    ['Ива\u0301нов Пётр', { givenNames: 'Иванов', familyNames: 'Петр' }, 'exact'],
  ])(
    'matches non-Latin "%s" on its own letters rather than folding it to nothing',
    async (name, candidate, expected) => {
      expect(await matchTypeFor(name, candidate)).toBe(expected);
    },
  );

  it('never calls a name with no letters or digits an exact match', async () => {
    expect(await matchTypeFor('—', { givenNames: 'Robert', familyNames: 'Smith' })).toBe('none');
  });

  it('keeps exact-before-partial ordering after folding', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 2,
      results: [
        {
          ...baseCandidate,
          orcidId: '0000-0002-1111-2222',
          givenNames: 'José María',
          familyNames: 'Baselga',
        },
        {
          ...baseCandidate,
          orcidId: '0000-0001-9522-8779',
          givenNames: 'Jose',
          familyNames: 'Baselga',
        },
      ],
    });
    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const result = await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({ name: 'José Baselga' }),
      ctx,
    );

    expect(result.candidates.map((c) => [c.orcidId, c.nameMatchType])).toEqual([
      ['0000-0001-9522-8779', 'exact'],
      ['0000-0002-1111-2222', 'partial'],
    ]);
  });
});

describe('orcidResolveResearcher — accent-insensitive institution overlap (#35)', () => {
  async function overlapFor(affiliation: string, institution: string): Promise<boolean> {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [{ ...baseCandidate, institutionNames: [institution] }],
    });
    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const result = await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna', affiliation }),
      ctx,
    );
    return result.candidates[0]!.institutionOverlap;
  }

  it.each([
    ['Université de Montréal', 'Universite de Montreal'],
    ['Universite de Montreal', 'Université de Montréal'],
    ['Universität Zürich', 'Universitat Zurich'],
    ['Montréal', 'Université de Montréal'],
  ])('reports overlap for "%s" against "%s"', async (affiliation, institution) => {
    expect(await overlapFor(affiliation, institution)).toBe(true);
  });

  it.each([
    // Generic-word rejection still holds.
    ['University', 'University of Zürich'],
    // Contiguous-run requirement still holds after folding.
    ['Montréal Université', 'Université de Montréal'],
  ])('does not report overlap for "%s" against "%s"', async (affiliation, institution) => {
    expect(await overlapFor(affiliation, institution)).toBe(false);
  });
});

describe('orcidResolveResearcher — folding cost stays linear in name length (#35)', () => {
  /**
   * Best-of-three wall-clock for classifying one candidate whose every name field is `size`
   * characters of distinct accented, punctuated tokens — the shape that would expose both a
   * backtracking fold and a quadratic token-overlap scan.
   */
  async function timeFor(size: number): Promise<number> {
    const tokens: string[] = [];
    for (let i = 0, length = 0; length < size; i++) {
      const token = `Jé${i.toString(36)}-ö\u0301`;
      tokens.push(token);
      length += token.length + 1;
    }
    const long = tokens.join(' ').slice(0, size);
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      mockExpandedSearch.mockResolvedValueOnce({
        numFound: 1,
        results: [
          {
            ...baseCandidate,
            givenNames: long,
            familyNames: long,
            creditName: long,
            otherNames: [long],
            institutionNames: [long],
          },
        ],
      });
      const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
      const input = orcidResolveResearcher.input.parse({ name: long, affiliation: long });
      const start = performance.now();
      await orcidResolveResearcher.handler(input, ctx);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  it('classifies 5k and 80k character names in linear time', async () => {
    const [t5, t80] = [await timeFor(5_000), await timeFor(80_000)];

    // 16x the input may cost ~16x the time; quadratic growth would be ~256x, so a 64x bound
    // leaves room for load noise while still failing a quadratic scan. The 2 ms floor keeps
    // timer noise on the small case from inflating the ratio.
    expect(t80 / Math.max(t5, 2)).toBeLessThan(64);
    expect(t80).toBeLessThan(1_000);
  });
});

describe('orcidResolveResearcher — generic institution words in other languages (#46)', () => {
  async function overlapFor(affiliation: string, institution: string): Promise<boolean> {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [{ ...baseCandidate, institutionNames: [institution] }],
    });
    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const result = await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna', affiliation }),
      ctx,
    );
    return result.candidates[0]!.institutionOverlap;
  }

  // Institution names below are real ORCID affiliation-org-name values.
  it.each([
    ['Universidad de', 'Universidad de Buenos Aires'],
    ['Université', 'Université Laval'],
    ['Universität', 'Universität Bielefeld'],
    ['Institut', 'Institut Pasteur'],
    ['Universidade', 'Universidade Paulista'],
    ['Università degli Studi', 'Università degli Studi di Palermo'],
    ['Universiteit', 'Universiteit Utrecht'],
    ['Instituut voor', 'Instituut voor Tropische Geneeskunde'],
    ['Universitetet', 'Universitetet i Bergen Kjemisk institutt'],
    ['Högskolan', 'Högskolan i Borås'],
    ['Hôpital Universitaire', 'Hôpital Universitaire de Bruxelles'],
    ['Hochschule', 'Hochschule Bochum'],
    ['Ospedale', 'Ospedale Antonio Cardarelli'],
    ['Centro Universitário', 'Centro Universitário FacUnicamps'],
    ['Instituto Nacional', 'Instituto Nacional de Cancerologia'],
  ])('a generic-only "%s" establishes no overlap with "%s"', async (affiliation, institution) => {
    expect(await overlapFor(affiliation, institution)).toBe(false);
  });

  it.each([
    ['Universidad de Chile', 'Universidad de Chile'],
    ['Karolinska Institutet', 'Karolinska Institutet'],
    ['Institut Pasteur', 'Institut Pasteur'],
    ['Universität Zürich', 'Universitat Zurich'],
    // "Pará" is a Brazilian state — a distinguishing name, so it is not a stopword.
    ['Pará', 'Universidade Federal do Pará'],
    // "Dell" folds like the Italian "dell'", but here it names the institution.
    ['Dell', 'University of Texas at Austin Dell Medical School'],
  ])('a distinctive "%s" still overlaps "%s"', async (affiliation, institution) => {
    expect(await overlapFor(affiliation, institution)).toBe(true);
  });

  it('keeps the contiguous-run rule: "Universidad de Chile" does not overlap "Universidad de Buenos Aires"', async () => {
    expect(await overlapFor('Universidad de Chile', 'Universidad de Buenos Aires')).toBe(false);
  });
});
