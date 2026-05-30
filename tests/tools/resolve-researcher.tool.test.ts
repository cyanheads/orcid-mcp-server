/**
 * @fileoverview Tests for orcidResolveResearcher tool.
 * @module tests/tools/resolve-researcher.tool.test
 */

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

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    const result = await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].orcidId).toBe('0000-0001-9522-8779');
    expect(result.candidates[0].orcidUri).toBe('https://orcid.org/0000-0001-9522-8779');
    expect(result.candidates[0].nameMatchType).toBe('exact');
    expect(result.candidates[0].institutionOverlap).toBe(false); // no affiliation provided
    expect(result.candidates[0].anchorType).toBe('none');
    expect(enrichment.totalFound).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('scores institution overlap correctly', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [doudnaResult],
    });

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'UC Berkeley',
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0].institutionOverlap).toBe(true);
  });

  it('sets anchorType to doi when doi is provided', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [doudnaResult],
    });

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      doi: '10.1126/science.1225829',
    });
    const result = await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.candidates[0].anchorType).toBe('doi');
    expect(enrichment.queryUsed).toContain('doi-self:10.1126/science.1225829');
  });

  it('falls back to relaxed query when primary returns nothing and affiliation provided', async () => {
    // Primary (with affiliation) returns 0
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });
    // Relaxed (without affiliation) returns 1
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 1, results: [doudnaResult] });

    const ctx = createMockContext();
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

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      doi: '10.1126/science.1225829',
    });
    await orcidResolveResearcher.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.relaxedQuery).toBe('doi-self:10.1126/science.1225829');
  });

  it('adds notice enrichment when no candidates found and returns empty list', async () => {
    mockExpandedSearch.mockResolvedValue({ numFound: 0, results: [] });

    const ctx = createMockContext();
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

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result.candidates[0].orcidId).toBe('0000-0001-9522-8779'); // exact match first
    expect(result.candidates[0].nameMatchType).toBe('exact');
    expect(result.candidates[1].nameMatchType).toBe('partial');
  });

  it('propagates service errors', async () => {
    mockExpandedSearch.mockRejectedValueOnce(new Error('Connection refused'));

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({ name: 'Jennifer Doudna' });
    await expect(orcidResolveResearcher.handler(input, ctx)).rejects.toThrow('Connection refused');
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
    expect(blocks[0].type).toBe('text');
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
