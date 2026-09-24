/**
 * @fileoverview Security tests: injection attempts, oversized inputs, assertion that no
 * secrets/env values or upstream transport details leak into tool output or error messages,
 * and that upstream markup is stripped before it reaches either result surface.
 * @module tests/tools/security.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetAffiliations } from '@/mcp-server/tools/definitions/get-affiliations.tool.js';
import { orcidGetFunding } from '@/mcp-server/tools/definitions/get-funding.tool.js';
import { orcidGetPeerReviews } from '@/mcp-server/tools/definitions/get-peer-reviews.tool.js';
import { orcidGetProfile } from '@/mcp-server/tools/definitions/get-profile.tool.js';
import { orcidGetWorkDetail } from '@/mcp-server/tools/definitions/get-work-detail.tool.js';
import { orcidGetWorks } from '@/mcp-server/tools/definitions/get-works.tool.js';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';
import { normalizeBulkWorks, normalizeWorks } from '@/services/orcid/normalizers.js';

const mockExpandedSearch = vi.fn();
const mockGetPerson = vi.fn();
const mockGetWorks = vi.fn();
const mockGetWorkDetails = vi.fn();
const mockGetAffiliations = vi.fn();
const mockGetFundings = vi.fn();
const mockGetPeerReviews = vi.fn();

vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({
    expandedSearch: mockExpandedSearch,
    getPerson: mockGetPerson,
    getWorks: mockGetWorks,
    getWorkDetails: mockGetWorkDetails,
    getAffiliations: mockGetAffiliations,
    getFundings: mockGetFundings,
    getPeerReviews: mockGetPeerReviews,
  }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

// An unrouted service call fails loudly; each test layers the responses it expects.
beforeEach(() => {
  for (const mock of [
    mockExpandedSearch,
    mockGetPerson,
    mockGetWorks,
    mockGetWorkDetails,
    mockGetAffiliations,
    mockGetFundings,
    mockGetPeerReviews,
  ]) {
    mock.mockReset();
    mock.mockRejectedValue(new Error('unmocked fetch'));
  }
});

describe('security: injection attempts are forwarded as query strings, not executed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('search_researchers: Solr injection in family_name is phrase-quoted, not structurally expanded', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      family_name: 'Smith OR 1=1',
    });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    // The injection is phrase-quoted in the field clause — the OR token is not a
    // structural boolean operator from our side; it is part of the quoted literal.
    expect(callParams.q).toContain('family-name:"Smith OR 1=1"');
  });

  it('search_researchers: raw query field with boolean injection is forwarded unchanged', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      query: 'given-names:Jennifer AND (family-name:Doudna OR family-name:*)',
    });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toContain(
      'given-names:Jennifer AND (family-name:Doudna OR family-name:*)',
    );
  });

  it('resolve_researcher: injection in name is forwarded as-is to expandedSearch', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna"; DELETE FROM records --',
    });
    await orcidResolveResearcher.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
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

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'UC Berkeley" OR *:*',
    });
    await orcidResolveResearcher.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    // The injected quote and operator chars are backslash-escaped inside the phrase, so the
    // value cannot break out of its quotes into a structural `OR *:*` clause.
    expect(callParams.q).toContain('affiliation-org-name:"UC Berkeley\\" OR \\*\\:\\*"');
    expect(callParams.q).not.toContain('affiliation-org-name:"UC Berkeley" OR *:*"');
  });

  it('search_researchers: grant_number with reserved chars is escaped inside its phrase clause', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ grant_number: 'R01" OR *:* (x)' });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('grant-numbers:"R01\\" OR \\*\\:\\* \\(x\\)"');
  });

  it('search_researchers: a DOI with inner whitespace stays one phrase clause, no live OR (#47)', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      doi: 'https://doi.org/10.1000/x OR *:*',
    });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('doi-self:"10.1000\\/x OR \\*\\:\\*"');
  });

  it('search_researchers: a PMID with inner whitespace stays one phrase clause, no live OR (#47)', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ pmid: '123 OR smith' });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('pmid-self:"123 OR smith"');
  });

  it('resolve_researcher: a PMID URL has only its prefix stripped; the body stays escaped', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jane Roe',
      pmid: 'https://pubmed.ncbi.nlm.nih.gov/123:*/',
    });
    await orcidResolveResearcher.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('given-and-family-names:"Jane Roe" AND pmid-self:"123\\:\\*"');
  });

  it('resolve_researcher: a DOI anchor with inner whitespace stays one phrase clause (#47)', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jane Roe',
      doi: '10.1000/x OR smith',
    });
    await orcidResolveResearcher.handler(input, ctx);

    const [primary] = mockExpandedSearch.mock.calls[0]!;
    const [anchorOnly] = mockExpandedSearch.mock.calls[1]!;
    expect(primary.q).toBe('given-and-family-names:"Jane Roe" AND doi-self:"10.1000\\/x OR smith"');
    expect(anchorOnly.q).toBe('doi-self:"10.1000\\/x OR smith"');
  });
});

describe('security: oversized inputs are rejected by input validation', () => {
  it('resolve_researcher: name with very long string still passes validation (no max length)', () => {
    const longName = 'A'.repeat(10000);
    // No max length on name — the tool accepts it (the API will handle limits)
    expect(() => orcidResolveResearcher.input.parse({ name: longName })).not.toThrow();
  });

  it('resolve_researcher: empty name is rejected', () => {
    expect(() => orcidResolveResearcher.input.parse({ name: '' })).toThrow();
  });

  it('resolve_researcher: whitespace-only name is rejected', () => {
    expect(() => orcidResolveResearcher.input.parse({ name: '   ' })).toThrow();
    expect(() => orcidResolveResearcher.input.parse({ name: '\t' })).toThrow();
  });

  // Each case carries one search field so only the bound under test decides the outcome.
  it('search_researchers: rows above 1000 is rejected', () => {
    expect(() =>
      orcidSearchResearchers.input.parse({ family_name: 'Smith', rows: 1001 }),
    ).toThrow();
  });

  it('search_researchers: rows below 1 is rejected', () => {
    expect(() => orcidSearchResearchers.input.parse({ family_name: 'Smith', rows: 0 })).toThrow();
  });

  it('search_researchers: start below 0 is rejected', () => {
    expect(() => orcidSearchResearchers.input.parse({ family_name: 'Smith', start: -1 })).toThrow();
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

    const ctx = createMockContext({ errors: orcidGetProfile.errors });
    const input = orcidGetProfile.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const err = await Promise.resolve(orcidGetProfile.handler(input, ctx)).catch((e: unknown) => e);
    if (!(err instanceof Error)) throw new Error('Expected the handler to reject.');

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

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
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

  it('get_work_detail: an exhausted rate limit reaches the client without upstream URL or body', async () => {
    mockGetWorkDetails.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.RateLimited, 'ORCID returned HTTP 429 Too Many Requests.', {
        url: 'https://pub.orcid.org/v3.0/0000-0002-1825-0097/works/1?token=SECRET_TOKEN',
        status: 429,
        body: 'quota for client 203.0.113.7 exceeded',
        retryAfter: '30',
      }),
    );

    const result = await runToolContract(orcidGetWorkDetail, {
      orcid_id: '0000-0002-1825-0097',
      put_codes: [1],
    });
    const wire = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(wire).toContain('rate-limited');
    expect(wire).not.toContain('pub.orcid.org');
    expect(wire).not.toContain('203.0.113.7');
    expect(wire).not.toMatch(/SECRET|TOKEN/);
  });
});

describe('security: upstream markup never reaches either surface as markup (#37)', () => {
  const hostile =
    'Genome <script>alert(1)</script> editing <img src=x onerror="alert(2)"> in <a href="javascript:alert(3)">vivo</a>';

  it('get_works: script, image, and link tags in a deposited title are stripped', async () => {
    mockGetWorks.mockResolvedValueOnce(
      normalizeWorks({
        group: [{ 'work-summary': [{ 'put-code': 1, title: { title: { value: hostile } } }] }],
      }),
    );

    const result = await runToolContract(orcidGetWorks, { orcid_id: '0000-0002-1825-0097' });
    const wire = JSON.stringify(result);

    expect((result.structuredContent as { works: { title?: string }[] }).works[0]?.title).toBe(
      'Genome alert(1) editing in vivo',
    );
    expect(wire).not.toMatch(/<(script|img|a)\b/);
    expect(wire).not.toContain('onerror');
    expect(wire).not.toContain('javascript:');
  });

  it('get_work_detail: the same tags in a deposited abstract are stripped', async () => {
    mockGetWorkDetails.mockResolvedValueOnce(
      normalizeBulkWorks({ bulk: [{ work: { 'put-code': 1, 'short-description': hostile } }] }),
    );

    const result = await runToolContract(orcidGetWorkDetail, {
      orcid_id: '0000-0002-1825-0097',
      put_codes: [1],
    });
    const wire = JSON.stringify(result);

    expect(wire).not.toMatch(/<(script|img|a)\b/);
    expect(wire).not.toContain('onerror');
  });
});
