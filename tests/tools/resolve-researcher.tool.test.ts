/**
 * @fileoverview Tests for orcidResolveResearcher tool.
 * @module tests/tools/resolve-researcher.tool.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';

const mockExpandedSearch = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ expandedSearch: mockExpandedSearch }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

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
    // DOI slash is Solr-reserved, so the executed clause carries the escaped form.
    expect(enrichment.queryUsed).toContain('doi-self:10.1126\\/science.1225829');
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
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });
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

    expect(enrichment.relaxedQuery).toBe('doi-self:10.1126\\/science.1225829');
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
    // "Jennifer Doudna-Smith" — tokens ['jennifer', 'doudnasmith'] — 1 overlap with 'Jennifer Doudna'
    // Use a name that shares 2 tokens to trigger partial: "Jennifer Doudna Lopez" → tokens overlap with "Jennifer Doudna"
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

  it('keeps queryUsed/totalFound paired through both relaxed stages in sequence', async () => {
    // Stage 0 primary (name + doi + affiliation) → 0
    // Stage 1 drop-affiliation (name + doi) → 0
    // Stage 2 anchor-only (doi) → 4
    mockExpandedSearch
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

    // Three upstream calls: primary, drop-affiliation, anchor-only.
    expect(mockExpandedSearch).toHaveBeenCalledTimes(3);

    // Effective query is the anchor-only stage that finally matched (DOI slash escaped).
    expect(enrichment.queryUsed).toBe('doi-self:10.1126\\/science.1225829');
    expect(enrichment.queryUsed).toBe(enrichment.relaxedQuery);
    expect(enrichment.totalFound).toBe(4); // from the anchor-only response

    // primaryQuery still describes the fully-constrained first attempt.
    expect(enrichment.primaryQuery).toContain('affiliation-org-name:');
    expect(enrichment.primaryQuery).toContain('doi-self:10.1126\\/science.1225829');
    expect(enrichment.primaryTotalFound).toBe(0);
  });
});

describe('orcidResolveResearcher — dual DOI+PMID anchor fallback (#19)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recovers via the PMID anchor when a wrong DOI zeroes the combined query', async () => {
    // Stage 0 combined (name AND doi AND pmid) → 0 because the DOI is wrong.
    // Stage 1 anchor-only DOI → 0 (still the wrong DOI).
    // Stage 2 anchor-only PMID → 1 (the valid PMID) — must NOT be discarded.
    mockExpandedSearch
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

    // Three upstream calls: combined primary, DOI-only, PMID-only.
    expect(mockExpandedSearch).toHaveBeenCalledTimes(3);
    // The valid PMID anchor produced the candidate and is reported as the anchor used.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.anchorType).toBe('pmid');
    expect(enrichment.queryUsed).toBe('pmid-self:41961593');
    expect(enrichment.relaxedQuery).toBe('pmid-self:41961593');
  });

  it('prefers the DOI anchor and never tries PMID when the DOI matches', async () => {
    // Stage 0 combined (name AND doi AND pmid) → 0 because the PMID is wrong.
    // Stage 1 anchor-only DOI → matches, so the PMID clause is never queried.
    mockExpandedSearch
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

    expect(mockExpandedSearch).toHaveBeenCalledTimes(2); // combined, DOI-only (PMID skipped)
    expect(result.candidates[0]!.anchorType).toBe('doi');
    expect(enrichment.relaxedQuery).toBe('doi-self:10.1126\\/science.1225829');
  });
});
