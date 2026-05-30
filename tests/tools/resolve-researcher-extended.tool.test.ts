/**
 * @fileoverview Extended coverage for orcidResolveResearcher: pmid anchor, credit name
 * matching, other-name matching, institution overlap token filtering, edge cases.
 * @module tests/tools/resolve-researcher-extended.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';

const mockExpandedSearch = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ expandedSearch: mockExpandedSearch }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

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

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      pmid: '22745249',
    });
    const result = await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.candidates[0].anchorType).toBe('pmid');
    expect(enrichment.queryUsed).toContain('pmid-self:22745249');
  });

  it('falls back to pmid-only query when name+pmid returns nothing', async () => {
    mockExpandedSearch
      .mockResolvedValueOnce({ numFound: 0, results: [] }) // name + pmid returns nothing
      .mockResolvedValueOnce({ numFound: 1, results: [baseCandidate] }); // pmid-only fallback

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      pmid: '22745249',
    });
    await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.relaxedQuery).toBe('pmid-self:22745249');
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

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer A. Doudna' });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0].nameMatchType).toBe('exact');
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

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0].nameMatchType).toBe('other-name');
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

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0].nameMatchType).toBe('none');
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

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'UC', // all tokens <= 3 chars — no overlap possible
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0].institutionOverlap).toBe(false);
  });

  it('returns false overlap when affiliation is empty', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [baseCandidate],
    });

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      // no affiliation
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0].institutionOverlap).toBe(false);
  });

  it('returns true overlap for partial institution name match', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [{ ...baseCandidate, institutionNames: ['Innovative Genomics Institute'] }],
    });

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'Genomics Institute',
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0].institutionOverlap).toBe(true);
  });
});

describe('orcidResolveResearcher — empty-result notice content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('notice for doi anchor references DOI in message', async () => {
    mockExpandedSearch.mockResolvedValue({ numFound: 0, results: [] });

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'Berkeley',
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    // Both are exact matches; overlap one should sort first
    expect(result.candidates[0].orcidId).toBe('0000-0001-9522-8779'); // UC Berkeley match
    expect(result.candidates[0].institutionOverlap).toBe(true);
    expect(result.candidates[1].institutionOverlap).toBe(false);
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
