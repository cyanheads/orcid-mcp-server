/**
 * @fileoverview Security tests: injection attempts, oversized inputs, and assertion
 * that no secrets/env values leak into tool output or error messages.
 * @module tests/tools/security.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetAffiliations } from '@/mcp-server/tools/definitions/get-affiliations.tool.js';
import { orcidGetFunding } from '@/mcp-server/tools/definitions/get-funding.tool.js';
import { orcidGetPeerReviews } from '@/mcp-server/tools/definitions/get-peer-reviews.tool.js';
import { orcidGetProfile } from '@/mcp-server/tools/definitions/get-profile.tool.js';
import { orcidGetWorks } from '@/mcp-server/tools/definitions/get-works.tool.js';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';

const mockExpandedSearch = vi.fn();
const mockGetPerson = vi.fn();
const mockGetWorks = vi.fn();
const mockGetAffiliations = vi.fn();
const mockGetFundings = vi.fn();
const mockGetPeerReviews = vi.fn();

vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({
    expandedSearch: mockExpandedSearch,
    getPerson: mockGetPerson,
    getWorks: mockGetWorks,
    getAffiliations: mockGetAffiliations,
    getFundings: mockGetFundings,
    getPeerReviews: mockGetPeerReviews,
  }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

describe('security: injection attempts are forwarded as query strings, not executed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('search_researchers: Solr injection in family_name is phrase-quoted, not structurally expanded', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({
      family_name: 'Smith OR 1=1',
    });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0];
    // The injection is phrase-quoted in the field clause — the OR token is not a
    // structural boolean operator from our side; it is part of the quoted literal.
    expect(callParams.q).toContain('family-name:"Smith OR 1=1"');
  });

  it('search_researchers: raw query field with boolean injection is forwarded unchanged', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({
      query: 'given-names:Jennifer AND (family-name:Doudna OR family-name:*)',
    });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0];
    expect(callParams.q).toContain(
      'given-names:Jennifer AND (family-name:Doudna OR family-name:*)',
    );
  });

  it('resolve_researcher: injection in name is forwarded as-is to expandedSearch', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna"; DELETE FROM records --',
    });
    await orcidResolveResearcher.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0];
    // The injected string is wrapped in a Solr field clause, and its embedded quote is
    // escaped, so the DELETE suffix stays inside the phrase literal rather than breaking out.
    expect(callParams.q).toContain('given-and-family-names:');
    expect(callParams.q).toContain('given-and-family-names:"Jennifer Doudna\\";');
    expect(typeof callParams.q).toBe('string');
  });

  it('resolve_researcher: injection in affiliation is escaped inside the Solr phrase clause', async () => {
    // Primary returns nothing, so a relaxed pass fires — provide two responses.
    mockExpandedSearch
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext();
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'UC Berkeley" OR *:*',
    });
    await orcidResolveResearcher.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0];
    // The injected quote and operator chars are backslash-escaped inside the phrase, so the
    // value cannot break out of its quotes into a structural `OR *:*` clause.
    expect(callParams.q).toContain('affiliation-org-name:"UC Berkeley\\" OR \\*\\:\\*"');
    expect(callParams.q).not.toContain('affiliation-org-name:"UC Berkeley" OR *:*"');
  });
});

describe('security: oversized inputs are rejected by input validation', () => {
  it('resolve_researcher: name with very long string still passes validation (min-length only)', () => {
    const longName = 'A'.repeat(10000);
    // No max length on name — the tool accepts it (the API will handle limits)
    expect(() => orcidResolveResearcher.input.parse({ name: longName })).not.toThrow();
  });

  it('resolve_researcher: empty name is rejected', () => {
    expect(() => orcidResolveResearcher.input.parse({ name: '' })).toThrow();
  });

  it('search_researchers: rows above 1000 is rejected', () => {
    expect(() => orcidSearchResearchers.input.parse({ rows: 1001 })).toThrow();
  });

  it('search_researchers: rows below 1 is rejected', () => {
    expect(() => orcidSearchResearchers.input.parse({ rows: 0 })).toThrow();
  });

  it('search_researchers: start below 0 is rejected', () => {
    expect(() => orcidSearchResearchers.input.parse({ start: -1 })).toThrow();
  });

  it('resolve_researcher: rows above 20 is rejected', () => {
    expect(() => orcidResolveResearcher.input.parse({ name: 'Test', rows: 21 })).toThrow();
  });

  it('resolve_researcher: rows below 1 is rejected', () => {
    expect(() => orcidResolveResearcher.input.parse({ name: 'Test', rows: 0 })).toThrow();
  });
});

describe('security: no secrets or env values appear in tool output or error messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('get_profile: service error message does not expose process.env entries', async () => {
    // Simulate a service error whose message might reference internal config
    mockGetPerson.mockRejectedValueOnce(
      new Error('Connection failed to https://sandbox.orcid.org'),
    );

    const ctx = createMockContext();
    const input = orcidGetProfile.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const err = await orcidGetProfile.handler(input, ctx).catch((e: unknown) => e as Error);

    // The error message is the service's, propagated as-is — but no env-var keys appear
    expect(err.message).not.toMatch(/process\.env\./);
    expect(err.message).not.toMatch(/API_KEY|SECRET|TOKEN|PASSWORD/i);
  });

  it('search_researchers: format output never contains env-var-style strings', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 1,
      results: [
        {
          orcidId: '0000-0002-1825-0097',
          givenNames: 'Jennifer',
          familyNames: 'Doudna',
          otherNames: [],
          emails: [],
          institutionNames: ['UC Berkeley'],
        },
      ],
    });

    const ctx = createMockContext();
    const input = orcidSearchResearchers.input.parse({ family_name: 'Doudna' });
    const result = await orcidSearchResearchers.handler(input, ctx);
    const blocks = orcidSearchResearchers.format!(result);
    const text = (blocks[0] as { text: string }).text;

    expect(text).not.toMatch(/process\.env\./);
    expect(text).not.toMatch(/API_KEY|SECRET|TOKEN|PASSWORD/i);
  });

  it('get_works: format output does not include env-var-style strings', () => {
    const output = orcidGetWorks.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      workCount: 1,
      returnedCount: 1,
      offset: 0,
      truncated: false,
      works: [
        {
          title: 'A Paper',
          externalIds: [{ type: 'doi', value: '10.1/test' }],
        },
      ],
    });
    const blocks = orcidGetWorks.format!(output);
    const text = (blocks[0] as { text: string }).text;

    expect(text).not.toMatch(/process\.env\./);
    expect(text).not.toMatch(/API_KEY|SECRET|TOKEN|PASSWORD/i);
  });

  it('get_affiliations: format output does not include env-var-style strings', () => {
    const output = orcidGetAffiliations.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      affiliationCount: 1,
      affiliations: [
        {
          type: 'employment',
          organization: { name: 'UC Berkeley', country: 'US' },
          role: 'Professor',
          startDate: '2002',
        },
      ],
      requestedTypes: ['employment'],
    });
    const blocks = orcidGetAffiliations.format!(output);
    const text = (blocks[0] as { text: string }).text;

    expect(text).not.toMatch(/API_KEY|SECRET|TOKEN|PASSWORD/i);
  });

  it('get_funding: format output does not include env-var-style strings', () => {
    const output = orcidGetFunding.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      fundingCount: 0,
      funding: [],
    });
    const blocks = orcidGetFunding.format!(output);
    const text = (blocks[0] as { text: string }).text;

    expect(text).not.toMatch(/API_KEY|SECRET|TOKEN|PASSWORD/i);
  });

  it('get_peer_reviews: format output does not include env-var-style strings', () => {
    const output = orcidGetPeerReviews.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      reviewCount: 0,
      peerReviews: [],
    });
    const blocks = orcidGetPeerReviews.format!(output);
    const text = (blocks[0] as { text: string }).text;

    expect(text).not.toMatch(/API_KEY|SECRET|TOKEN|PASSWORD/i);
  });
});
