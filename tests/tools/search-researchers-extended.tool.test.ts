/**
 * @fileoverview Extended coverage for orcidSearchResearchers: additional Solr query
 * clause building, creditName rendering, ror_id/doi/pmid fields, and edge cases.
 * @module tests/tools/search-researchers-extended.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';

const mockExpandedSearch = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ expandedSearch: mockExpandedSearch }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

describe('orcidSearchResearchers — Solr clause building', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds ror-org-id clause with quotes for ror_id param', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({
      ror_id: 'https://ror.org/01an7q238',
    });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0];
    expect(callParams.q).toBe('ror-org-id:"https://ror.org/01an7q238"');
  });

  it('builds doi-self clause for doi param', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({
      doi: '10.1126/science.1225829',
    });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0];
    expect(callParams.q).toBe('doi-self:10.1126/science.1225829');
  });

  it('builds pmid-self clause for pmid param', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({
      pmid: '22745249',
    });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0];
    expect(callParams.q).toBe('pmid-self:22745249');
  });

  it('appends raw query field with AND to structured clauses', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({
      family_name: 'Doudna',
      query: 'email:*berkeley.edu',
    });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0];
    expect(callParams.q).toContain('family-name:Doudna');
    expect(callParams.q).toContain('AND');
    expect(callParams.q).toContain('email:*berkeley.edu');
  });

  it('uses *:* when only whitespace-only params are provided', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({
      given_name: '   ',
      family_name: '  ',
    });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0];
    expect(callParams.q).toBe('*:*');
  });

  it('passes rows and start to the service call', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 50, results: [] });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({
      family_name: 'Smith',
      rows: 50,
      start: 100,
    });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0];
    expect(callParams.rows).toBe(50);
    expect(callParams.start).toBe(100);
  });
});

describe('orcidSearchResearchers — format output', () => {
  it('shows creditName as display name when set, prioritized over given+family', () => {
    const output = orcidSearchResearchers.output.parse({
      results: [
        {
          orcidId: '0000-0001-9522-8779',
          orcidUri: 'https://orcid.org/0000-0001-9522-8779',
          givenNames: 'Jennifer',
          familyNames: 'Doudna',
          creditName: 'Jennifer A. Doudna',
          otherNames: [],
          institutionNames: [],
        },
      ],
      rows: 1,
      start: 0,
    });

    const blocks = orcidSearchResearchers.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // The section heading should use creditName
    expect(text).toContain('Jennifer A. Doudna');
    // Credit name also in its own line
    expect(text).toContain('Credit Name');
  });

  it('shows orcidId as display name when no name fields set', () => {
    const output = orcidSearchResearchers.output.parse({
      results: [
        {
          orcidId: '0000-0002-1825-0097',
          orcidUri: 'https://orcid.org/0000-0002-1825-0097',
          otherNames: [],
          institutionNames: [],
        },
      ],
      rows: 1,
      start: 0,
    });

    const blocks = orcidSearchResearchers.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // Fallback: orcidId used as heading
    expect(text).toContain('0000-0002-1825-0097');
  });

  it('shows otherNames when present', () => {
    const output = orcidSearchResearchers.output.parse({
      results: [
        {
          orcidId: '0000-0001-9522-8779',
          orcidUri: 'https://orcid.org/0000-0001-9522-8779',
          givenNames: 'Jennifer',
          familyNames: 'Doudna',
          otherNames: ['J. Doudna', 'J.A. Doudna'],
          institutionNames: [],
        },
      ],
      rows: 1,
      start: 0,
    });

    const blocks = orcidSearchResearchers.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('J. Doudna');
    expect(text).toContain('J.A. Doudna');
  });

  it('shows pagination offset in header', () => {
    const output = orcidSearchResearchers.output.parse({
      results: [],
      rows: 0,
      start: 200,
    });

    const blocks = orcidSearchResearchers.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('200');
  });
});

describe('orcidSearchResearchers — input validation bounds', () => {
  it('accepts rows at minimum boundary (1)', () => {
    expect(() => orcidSearchResearchers.input.parse({ rows: 1 })).not.toThrow();
  });

  it('accepts rows at maximum boundary (1000)', () => {
    expect(() => orcidSearchResearchers.input.parse({ rows: 1000 })).not.toThrow();
  });

  it('accepts start at minimum boundary (0)', () => {
    expect(() => orcidSearchResearchers.input.parse({ start: 0 })).not.toThrow();
  });

  it('defaults rows to 20 when not provided', () => {
    const input = orcidSearchResearchers.input.parse({});
    expect(input.rows).toBe(20);
  });

  it('defaults start to 0 when not provided', () => {
    const input = orcidSearchResearchers.input.parse({});
    expect(input.start).toBe(0);
  });
});
