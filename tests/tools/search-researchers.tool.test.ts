/**
 * @fileoverview Tests for orcidSearchResearchers tool.
 * @module tests/tools/search-researchers.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';

// Mock the ORCID service module so tests don't make real HTTP calls.
const mockExpandedSearch = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ expandedSearch: mockExpandedSearch }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

describe('orcidSearchResearchers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns matching researchers for a name search', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 2,
      results: [
        {
          orcidId: '0000-0001-9522-8779',
          givenNames: 'Jennifer',
          familyNames: 'Doudna',
          creditName: undefined,
          otherNames: [],
          emails: [],
          institutionNames: ['UC Berkeley'],
        },
        {
          orcidId: '0000-0002-1825-0097',
          givenNames: 'Josiah',
          familyNames: 'Carberry',
          creditName: undefined,
          otherNames: [],
          emails: [],
          institutionNames: [],
        },
      ],
    });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({
      family_name: 'Doudna',
      rows: 10,
      start: 0,
    });
    const result = await orcidSearchResearchers.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.numFound).toBe(2);
    expect(result.rows).toBe(2);
    expect(result.start).toBe(0);
    expect(enrichment.effectiveQuery).toBe('family-name:Doudna');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].orcidId).toBe('0000-0001-9522-8779');
    expect(result.results[0].orcidUri).toBe('https://orcid.org/0000-0001-9522-8779');
    expect(result.results[0].givenNames).toBe('Jennifer');
    expect(result.results[0].familyNames).toBe('Doudna');
    expect(result.results[0].institutionNames).toEqual(['UC Berkeley']);
    expect(enrichment.notice).toBeUndefined();
  });

  it('builds an ANDed query from multiple structured params', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 1, results: [] });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({
      given_name: 'Jennifer',
      family_name: 'Doudna',
      affiliation: 'UC Berkeley',
      keyword: 'CRISPR',
    });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0];
    expect(callParams.q).toContain('given-names:Jennifer');
    expect(callParams.q).toContain('family-name:Doudna');
    expect(callParams.q).toContain('affiliation-org-name:"UC Berkeley"');
    expect(callParams.q).toContain('keyword:"CRISPR"');
  });

  it('enriches with wildcard query when no params provided', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 100, results: [] });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({});
    await orcidSearchResearchers.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.effectiveQuery).toBe('*:*');
  });

  it('adds notice enrichment when no results found', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({ family_name: 'XyzNoMatch' });
    await orcidSearchResearchers.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No results found');
  });

  it('adds notice enrichment when pagination overshoots numFound', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 5, results: [] });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({ family_name: 'Smith', start: 100 });
    await orcidSearchResearchers.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('Offset 100 exceeds numFound');
  });

  it('propagates service errors', async () => {
    mockExpandedSearch.mockRejectedValueOnce(new Error('Service unavailable'));

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({ family_name: 'Smith' });
    await expect(orcidSearchResearchers.handler(input, ctx)).rejects.toThrow('Service unavailable');
  });

  it('formats output with ORCID IDs and institution info', () => {
    const output = orcidSearchResearchers.output.parse({
      results: [
        {
          orcidId: '0000-0001-9522-8779',
          orcidUri: 'https://orcid.org/0000-0001-9522-8779',
          givenNames: 'Jennifer',
          familyNames: 'Doudna',
          otherNames: ['J. Doudna'],
          institutionNames: ['UC Berkeley'],
        },
      ],
      rows: 1,
      start: 0,
    });

    const blocks = orcidSearchResearchers.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0001-9522-8779');
    expect(text).toContain('https://orcid.org/0000-0001-9522-8779');
    expect(text).toContain('Jennifer Doudna');
    expect(text).toContain('UC Berkeley');
  });

  it('formats empty results', () => {
    const output = orcidSearchResearchers.output.parse({
      results: [],
      rows: 0,
      start: 0,
    });

    const blocks = orcidSearchResearchers.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No results');
  });
});
