/**
 * @fileoverview Tests for orcidSearchResearchers tool.
 * @module tests/tools/search-researchers.tool.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
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

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
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
    expect(enrichment.effectiveQuery).toBe('family-name:"Doudna"');
    expect(result.results).toHaveLength(2);
    const researcher = result.results[0]!;
    expect(researcher.orcidId).toBe('0000-0001-9522-8779');
    expect(researcher.orcidUri).toBe('https://orcid.org/0000-0001-9522-8779');
    expect(researcher.givenNames).toBe('Jennifer');
    expect(researcher.familyNames).toBe('Doudna');
    expect(researcher.institutionNames).toEqual(['UC Berkeley']);
    expect(enrichment.notice).toBeUndefined();
  });

  it('builds an ANDed query from multiple structured params', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 1, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      given_name: 'Jennifer',
      family_name: 'Doudna',
      affiliation: 'UC Berkeley',
      keyword: 'CRISPR',
    });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toContain('given-names:"Jennifer"');
    expect(callParams.q).toContain('family-name:"Doudna"');
    expect(callParams.q).toContain('affiliation-org-name:"UC Berkeley"');
    expect(callParams.q).toContain('keyword:"CRISPR"');
  });

  it('enriches with wildcard query when no params provided', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 100, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({});
    await orcidSearchResearchers.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.effectiveQuery).toBe('*:*');
  });

  it('adds notice enrichment when no results found', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ family_name: 'XyzNoMatch' });
    await orcidSearchResearchers.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No results found');
  });

  it('adds notice enrichment when pagination overshoots numFound', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 5, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ family_name: 'Smith', start: 100 });
    await orcidSearchResearchers.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('Offset 100 exceeds numFound');
  });

  it('surfaces a service error as the query_failed contract, keeping the original as cause', async () => {
    const upstream = new Error('Connection refused');
    mockExpandedSearch.mockRejectedValueOnce(upstream);

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ family_name: 'Smith' });
    const err = (await Promise.resolve(orcidSearchResearchers.handler(input, ctx)).catch(
      (e: unknown) => e,
    )) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.data?.reason).toBe('query_failed');
    expect(err.cause).toBe(upstream);
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
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0001-9522-8779');
    expect(text).toContain('https://orcid.org/0000-0001-9522-8779');
    expect(text).toContain('Jennifer Doudna');
    expect(text).toContain('UC Berkeley');
  });

  it('rejects start above the ORCID Public API cap of 10,000', () => {
    expect(() =>
      orcidSearchResearchers.input.parse({ family_name: 'Smith', start: 10001 }),
    ).toThrow();
  });

  it('accepts start at the inclusive 10,000 boundary', () => {
    const input = orcidSearchResearchers.input.parse({ family_name: 'Smith', start: 10000 });
    expect(input.start).toBe(10000);
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

  // #23 — disclosure of the ORCID Public API 10,000-offset retrieval ceiling.
  const stubResults = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      orcidId: `0000-0000-0000-${String(i).padStart(4, '0')}`,
      otherNames: [] as string[],
      emails: [] as string[],
      institutionNames: [] as string[],
    }));

  it('sets truncated false and omits nextStart when all matches fit below the cap', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 2, results: stubResults(2) });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ family_name: 'Doudna', rows: 20, start: 0 });
    const result = await orcidSearchResearchers.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.truncated).toBe(false);
    expect(result.nextStart).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('emits nextStart when more matches remain below the cap', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 100, results: stubResults(20) });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ family_name: 'Smith', rows: 20, start: 0 });
    const result = await orcidSearchResearchers.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.nextStart).toBe(20);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.notice).toBeUndefined();
  });

  it('flags truncated with a ceiling notice and a still-reachable nextStart when numFound exceeds 10,000', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 24043, results: stubResults(20) });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ family_name: 'Smith', rows: 20, start: 0 });
    const result = await orcidSearchResearchers.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('10,000');
    expect(enrichment.notice).toMatch(/narrow|partition/i);
    // Below the ceiling, the next page is still reachable.
    expect(result.nextStart).toBe(20);
  });

  it('keeps truncated true but omits nextStart on the final reachable page at start 10,000', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 24043, results: stubResults(20) });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      family_name: 'Smith',
      rows: 20,
      start: 10000,
    });
    const result = await orcidSearchResearchers.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.truncated).toBe(true);
    expect(result.start).toBe(10000);
    expect(result.nextStart).toBeUndefined();
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('10,000');
  });

  it('offers nextStart at the inclusive 10,000 boundary when it is the last legal page', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 24043, results: stubResults(20) });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      family_name: 'Smith',
      rows: 20,
      start: 9980,
    });
    const result = await orcidSearchResearchers.handler(input, ctx);

    // endStart = 9980 + 20 = 10000 → inclusive boundary, still the last reachable page.
    expect(result.nextStart).toBe(10000);
  });

  it('renders Next Start in the content trailer when nextStart is present', () => {
    const output = orcidSearchResearchers.output.parse({
      results: [],
      rows: 20,
      start: 0,
      nextStart: 20,
    });

    const blocks = orcidSearchResearchers.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Next Start');
    expect(text).toContain('20');
  });
});
