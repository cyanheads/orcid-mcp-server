/**
 * @fileoverview Security tests: injection attempts, oversized inputs, assertion that no
 * secrets/env values or upstream transport details leak into tool output or error messages,
 * that upstream markup is stripped before it reaches either result surface, and that line
 * breaks in third-party record text cannot open a heading or label in `content[]`.
 * @module tests/tools/security.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetAffiliations } from '@/mcp-server/tools/definitions/get-affiliations.tool.js';
import { orcidGetFunding } from '@/mcp-server/tools/definitions/get-funding.tool.js';
import { orcidGetPeerReviews } from '@/mcp-server/tools/definitions/get-peer-reviews.tool.js';
import { orcidGetProfile } from '@/mcp-server/tools/definitions/get-profile.tool.js';
import { orcidGetResearchResources } from '@/mcp-server/tools/definitions/get-research-resources.tool.js';
import { orcidGetWorkDetail } from '@/mcp-server/tools/definitions/get-work-detail.tool.js';
import { orcidGetWorks } from '@/mcp-server/tools/definitions/get-works.tool.js';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';
import {
  normalizeActivities,
  normalizeBulkWorks,
  normalizeExpandedSearch,
  normalizeFundings,
  normalizePeerReviews,
  normalizePerson,
  normalizeResearchResources,
  normalizeWorks,
} from '@/services/orcid/normalizers.js';

const mockExpandedSearch = vi.fn();
const mockGetPerson = vi.fn();
const mockGetWorks = vi.fn();
const mockGetWorkDetails = vi.fn();
const mockGetAffiliations = vi.fn();
const mockGetFundings = vi.fn();
const mockGetPeerReviews = vi.fn();
const mockGetResearchResources = vi.fn();

vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({
    expandedSearch: mockExpandedSearch,
    getPerson: mockGetPerson,
    getWorks: mockGetWorks,
    getWorkDetails: mockGetWorkDetails,
    getAffiliations: mockGetAffiliations,
    getFundings: mockGetFundings,
    getPeerReviews: mockGetPeerReviews,
    getResearchResources: mockGetResearchResources,
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
    mockGetResearchResources,
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
    expect(callParams.q).toBe('given-names:Jennifer AND (family-name:Doudna OR family-name:*)');
  });

  it('search_researchers: a raw query beside structured fields joins as one group (#61)', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      family_name: 'Doudna',
      query: 'given-names:Jennifer OR *:*',
    });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    // The raw operators stay live, but only inside the group the structured filter scopes.
    expect(callParams.q).toBe('family-name:"Doudna" AND (given-names:Jennifer OR *:*)');
  });

  it('resolve_researcher: injection in name is forwarded as-is to expandedSearch', async () => {
    // The phrase finds nothing, so the other-names stage follows — two responses.
    mockExpandedSearch
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna"; DELETE FROM records --',
    });
    await orcidResolveResearcher.handler(input, ctx);

    // The injected string is wrapped in a Solr field clause on every stage, and its embedded
    // quote is escaped, so the DELETE suffix stays inside the phrase literal.
    expect(mockExpandedSearch.mock.calls.map(([params]) => params.q)).toEqual([
      'given-and-family-names:"Jennifer Doudna\\"; DELETE FROM records \\-\\-"',
      'other-names:"Jennifer Doudna\\"; DELETE FROM records \\-\\-"',
    ]);
  });

  it.each([
    ['J. Smith" OR *:*', 'given-and-family-names:"Smith\\" OR \\*\\:\\*"~1'],
    ['J. Smith" OR (x:*)', 'given-and-family-names:"Smith\\" OR \\(x\\:\\*\\)"~1'],
    ['J. Smith"', 'given-and-family-names:("Smith\\"" AND J*)'],
  ])(
    'resolve_researcher: injection in byline words %j is escaped inside the byline phrase (#53)',
    async (name, byline) => {
      mockExpandedSearch.mockResolvedValue({ numFound: 0, results: [] });

      const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
      await orcidResolveResearcher.handler(orcidResolveResearcher.input.parse({ name }), ctx);

      // Phrase, byline, then other names; only the bare initial letter is left unescaped.
      const queries = mockExpandedSearch.mock.calls.map(([params]) => params.q);
      expect(queries).toHaveLength(3);
      expect(queries[1]).toBe(byline);
    },
  );

  it('resolve_researcher: injection in affiliation is escaped inside the Solr phrase clause', async () => {
    // Primary returns nothing, so the drop-affiliation and other-names stages fire.
    mockExpandedSearch
      .mockResolvedValueOnce({ numFound: 0, results: [] })
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
    mockExpandedSearch.mockResolvedValue({ numFound: 0, results: [] });

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
    mockExpandedSearch.mockResolvedValue({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jane Roe',
      doi: '10.1000/x OR smith',
    });
    await orcidResolveResearcher.handler(input, ctx);

    expect(mockExpandedSearch.mock.calls.map(([params]) => params.q)).toEqual([
      'given-and-family-names:"Jane Roe" AND doi-self:"10.1000\\/x OR smith"',
      'other-names:"Jane Roe" AND doi-self:"10.1000\\/x OR smith"',
      'doi-self:"10.1000\\/x OR smith"',
    ]);
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
          sources: [],
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
          sources: [],
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
      normalizeWorks(
        {
          group: [{ 'work-summary': [{ 'put-code': 1, title: { title: { value: hostile } } }] }],
        },
        '0000-0002-1825-0097',
      ),
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
      normalizeBulkWorks(
        { bulk: [{ work: { 'put-code': 1, 'short-description': hostile } }] },
        '0000-0002-1825-0097',
      ),
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

/**
 * Every third-party text field a tool renders carries `\r\n## Forged` through the real
 * normalizer. In `content[]` no line may open with it: inline slots fold the break to a space
 * (` ## Forged`), and blockquoted prose keeps it inside the quote (`> ## Forged`). The counts
 * pin that every injected field actually reached the text, so a field dropped by a fixture
 * typo cannot pass vacuously. `structuredContent` keeps every value verbatim, CR/LF included.
 */
describe('security: third-party text cannot forge structure in content[] (#63)', () => {
  const ID = '0000-0002-1825-0097';
  const FORGED = '\r\n## Forged';
  const forged = (value: string) => `${value}${FORGED}`;

  /** A member-system source asserting on the researcher's behalf, both names forged. */
  const forgedSource = () => ({
    'source-client-id': { uri: 'https://orcid.org/client/APP-1', path: 'APP-1', host: 'orcid.org' },
    'source-name': { value: forged('Member System') },
    'assertion-origin-orcid': { uri: `https://orcid.org/${ID}`, path: ID, host: 'orcid.org' },
    'assertion-origin-name': { value: forged('Josiah Carberry') },
  });

  /** An organization's disambiguated identifier and its source, both forged. */
  const forgedOrgId = () => ({
    'disambiguated-organization-identifier': forged('https://ror.org/05gq02987'),
    'disambiguation-source': forged('ROR'),
  });

  const textOf = (result: { content: { type: string; text?: string }[] }) =>
    result.content.map((block) => block.text ?? '').join('\n');

  /** Occurrences of the raw forged suffix in the serialized structured result. */
  const verbatimCount = (structured: unknown) =>
    JSON.stringify(structured).split(JSON.stringify(FORGED).slice(1, -1)).length - 1;

  function expectContained(text: string, counts: { inline: number; quoted: number }) {
    expect(text).not.toMatch(/^[ \t]*#+ Forged/m);
    expect(text.match(/^> ## Forged$/gm)?.length ?? 0).toBe(counts.quoted);
    expect(text.match(/ ## Forged/g)?.length ?? 0).toBe(counts.inline + counts.quoted);
  }

  it('orcid_get_profile quotes the biography and flattens names, keywords, and identifiers', async () => {
    mockGetPerson.mockResolvedValueOnce(
      normalizePerson({
        name: {
          'given-names': { value: forged('Josiah') },
          'family-name': { value: forged('Carberry') },
          'credit-name': { value: forged('J. S. Carberry') },
        },
        'other-names': {
          'other-name': [{ content: forged('Josiah Stinkney Carberry') }, { content: 'J. C.' }],
        },
        biography: { content: forged('Josiah Carberry is a fictitious person.') },
        keywords: { keyword: [{ content: forged('psychoceramics') }, { content: 'ionics' }] },
        'researcher-urls': {
          'researcher-url': [
            { 'url-name': forged('Lab'), url: { value: forged('https://example.org') } },
          ],
        },
        'external-identifiers': {
          'external-identifier': [
            {
              'external-id-type': forged('Scopus Author ID'),
              'external-id-value': forged('6603342255'),
              'external-id-url': { value: forged('https://www.scopus.com/a/6603342255') },
              'external-id-relationship': 'self',
            },
          ],
        },
      }),
    );

    const result = await runToolContract(orcidGetProfile, { orcid_id: ID });
    const text = textOf(result);

    // given, family, credit, one other name, one keyword, url name and url, identifier type,
    // value, and url
    expectContained(text, { inline: 10, quoted: 1 });
    expect(text).toContain(
      '### Biography\n> Josiah Carberry is a fictitious person.\n> ## Forged\n',
    );
    expect(text).toContain('**Name:** Josiah ## Forged Carberry ## Forged\n');
    expect(text).toContain('**Other Names:** Josiah Stinkney Carberry ## Forged, J. C.\n');
    expect(text).toContain('- **Lab ## Forged:** https://example.org ## Forged\n');
    expect(verbatimCount(result.structuredContent)).toBe(11);
    expect((result.structuredContent as { familyName?: string }).familyName).toBe(
      'Carberry\r\n## Forged',
    );
  });

  it('orcid_get_works flattens the title, journal, identifier, and source names', async () => {
    mockGetWorks.mockResolvedValueOnce(
      normalizeWorks(
        {
          group: [
            {
              'work-summary': [
                {
                  'put-code': 1,
                  title: { title: { value: forged('A title') } },
                  'journal-title': { value: forged('Journal') },
                  url: { value: forged('https://example.org/work') },
                  'external-ids': {
                    'external-id': [
                      {
                        'external-id-type': 'doi',
                        'external-id-value': forged('10.1/x'),
                        'external-id-url': { value: forged('https://doi.org/10.1/x') },
                        'external-id-relationship': 'self',
                      },
                    ],
                  },
                  source: forgedSource(),
                },
              ],
            },
          ],
        },
        ID,
      ),
    );

    const result = await runToolContract(orcidGetWorks, { orcid_id: ID });
    const text = textOf(result);

    // title, journal, url, identifier value and url, source and origin names
    expectContained(text, { inline: 7, quoted: 0 });
    expect(text).toContain('### A title ## Forged\n');
    expect(text).toContain('**URL:** https://example.org/work ## Forged\n');
    expect(text).toContain(
      '**Sources:** Josiah Carberry ## Forged via Member System ## Forged (self-asserted)',
    );
    expect(verbatimCount(result.structuredContent)).toBe(7);
  });

  it('orcid_get_work_detail quotes the abstract, flattens inline fields, and fences the citation', async () => {
    const citation = '@article{x,\n```\n## Escaped the fence\n}';
    mockGetWorkDetails.mockResolvedValueOnce(
      normalizeBulkWorks(
        {
          bulk: [
            {
              work: {
                'put-code': 1,
                title: { title: { value: forged('Title') }, subtitle: { value: forged('Sub') } },
                'journal-title': { value: forged('Journal') },
                'short-description': forged('Abstract text.'),
                citation: { 'citation-type': 'bibtex', 'citation-value': citation },
                url: { value: forged('https://example.org/work') },
                'external-ids': {
                  'external-id': [
                    {
                      'external-id-type': 'doi',
                      'external-id-value': forged('10.1/x'),
                      'external-id-url': { value: forged('https://doi.org/10.1/x') },
                    },
                  ],
                },
                contributors: {
                  contributor: [
                    {
                      'credit-name': { value: forged('Josiah Carberry') },
                      'contributor-attributes': { 'contributor-role': 'author' },
                    },
                    { 'credit-name': { value: forged('Second Author') } },
                  ],
                },
                source: forgedSource(),
              },
            },
          ],
        },
        ID,
      ),
    );

    const result = await runToolContract(orcidGetWorkDetail, { orcid_id: ID, put_codes: [1] });
    const text = textOf(result);

    // title, subtitle, journal, url, identifier value and url, two contributors, source and
    // origin names
    expectContained(text, { inline: 10, quoted: 1 });
    expect(text).toContain('## Title ## Forged\n');
    expect(text).toContain('**URL:** https://example.org/work ## Forged\n');
    expect(text).toContain('**Abstract:**\n> Abstract text.\n> ## Forged\n');
    expect(text).toContain('- Josiah Carberry ## Forged — author\n');
    expect(text).toContain(`\n\`\`\`\`\n${citation}\n\`\`\`\``);
    expect(text.split('\n').filter((line) => line === '````')).toHaveLength(2);
    expect(verbatimCount(result.structuredContent)).toBe(11);
  });

  it('orcid_get_affiliations flattens organization, city, department, role, and sources', async () => {
    mockGetAffiliations.mockResolvedValueOnce(
      normalizeActivities(
        {
          employments: {
            'affiliation-group': [
              {
                summaries: [
                  {
                    'employment-summary': {
                      organization: {
                        name: forged('Brown University'),
                        address: { city: forged('Providence'), country: 'US' },
                        'disambiguated-organization': forgedOrgId(),
                      },
                      'department-name': forged('Psychoceramics'),
                      'role-title': forged('Professor'),
                      url: { value: forged('https://example.org/appointment') },
                      source: forgedSource(),
                    },
                  },
                ],
              },
            ],
          },
        },
        ['employment'],
        ID,
      ),
    );

    const result = await runToolContract(orcidGetAffiliations, { orcid_id: ID });
    const text = textOf(result);

    // organization, city, department, role, org ID and its source, url, source and origin names
    expectContained(text, { inline: 9, quoted: 0 });
    expect(text).toContain('**Brown University ## Forged**\n');
    expect(text).toContain('  Org ID: https://ror.org/05gq02987 ## Forged (ROR ## Forged)\n');
    expect(text).toContain('  URL: https://example.org/appointment ## Forged\n');
    expect(verbatimCount(result.structuredContent)).toBe(9);
  });

  it('orcid_get_funding flattens the title, funder, city, grant number, and sources', async () => {
    mockGetFundings.mockResolvedValueOnce(
      normalizeFundings(
        {
          group: [
            {
              'funding-summary': [
                {
                  title: { title: { value: forged('Grant title') } },
                  type: 'grant',
                  organization: {
                    name: forged('Funder'),
                    address: { city: forged('Bethesda'), country: 'US' },
                    'disambiguated-organization': forgedOrgId(),
                  },
                  'external-ids': {
                    'external-id': [
                      { 'external-id-type': 'grant_number', 'external-id-value': forged('R01') },
                    ],
                  },
                  url: { value: forged('https://example.org/grant') },
                  source: forgedSource(),
                },
              ],
            },
          ],
        },
        ID,
      ),
    );

    const result = await runToolContract(orcidGetFunding, { orcid_id: ID });
    const text = textOf(result);

    // title, funder, city, funder ID and its source, grant number, url, source and origin names
    expectContained(text, { inline: 9, quoted: 0 });
    expect(text).toContain('### Grant title ## Forged\n');
    expect(text).toContain('**Funder ID:** https://ror.org/05gq02987 ## Forged (ROR ## Forged)\n');
    expect(text).toContain('**URL:** https://example.org/grant ## Forged\n');
    expect(verbatimCount(result.structuredContent)).toBe(9);
  });

  it('orcid_get_peer_reviews flattens both heading forms, the convening organization, and sources', async () => {
    mockGetPeerReviews.mockResolvedValueOnce(
      normalizePeerReviews(
        {
          group: [
            {
              'external-ids': {
                'external-id': [{ 'external-id-value': forged('issn:1476-4687') }],
              },
              'peer-review-group': [
                {
                  'peer-review-summary': [
                    {
                      'convening-organization': {
                        name: forged('Nature'),
                        address: { city: forged('London'), country: 'GB' },
                        'disambiguated-organization': forgedOrgId(),
                      },
                      'review-url': { value: forged('https://example.org/review') },
                      source: forgedSource(),
                    },
                  ],
                },
              ],
            },
            {
              'peer-review-group': [
                {
                  'peer-review-summary': [
                    { 'convening-organization': { name: forged('Review Service') } },
                  ],
                },
              ],
            },
          ],
        },
        ID,
      ),
    );

    const result = await runToolContract(orcidGetPeerReviews, { orcid_id: ID });
    const text = textOf(result);

    // ISSN heading, convening organization, city, org ID and its source, url, source and
    // origin names; then the organization heading of the review with no ISSN
    expectContained(text, { inline: 9, quoted: 0 });
    expect(text).toContain('### Journal ISSN 1476-4687 ## Forged\n');
    expect(text).toContain('**Convening organization:** Nature ## Forged\n');
    expect(text).toContain('**URL:** https://example.org/review ## Forged\n');
    expect(text).toContain('**Org ID:** https://ror.org/05gq02987 ## Forged (ROR ## Forged)\n');
    expect(text).toContain('### Review Service ## Forged\n');
    expect(verbatimCount(result.structuredContent)).toBe(9);
  });

  it('orcid_get_research_resources flattens the title, host, identifier, and sources', async () => {
    mockGetResearchResources.mockResolvedValueOnce(
      normalizeResearchResources(
        {
          group: [
            {
              'research-resource-summary': [
                {
                  'put-code': 7001,
                  source: forgedSource(),
                  proposal: {
                    title: { title: { value: forged('Allocation') } },
                    hosts: {
                      organization: [
                        {
                          name: forged('Supercomputing Center'),
                          address: { city: forged('Pittsburgh'), country: 'US' },
                          'disambiguated-organization': forgedOrgId(),
                        },
                      ],
                    },
                    'external-ids': {
                      'external-id': [
                        {
                          'external-id-type': 'uri',
                          'external-id-value': forged('alloc-1'),
                          'external-id-url': { value: forged('https://example.org/alloc-1') },
                        },
                      ],
                    },
                    url: { value: forged('https://example.org/allocation') },
                  },
                },
              ],
            },
          ],
        },
        ID,
      ),
    );

    const result = await runToolContract(orcidGetResearchResources, { orcid_id: ID });
    const text = textOf(result);

    // title, host name and city, host ID and its source, url, identifier value and url, source
    // and origin names
    expectContained(text, { inline: 10, quoted: 0 });
    expect(text).toContain('**Host:** Supercomputing Center ## Forged, Pittsburgh ## Forged, US\n');
    expect(text).toContain('**Host ID:** https://ror.org/05gq02987 ## Forged (ROR ## Forged)\n');
    expect(text).toContain('**URL:** https://example.org/allocation ## Forged\n');
    expect(verbatimCount(result.structuredContent)).toBe(10);
  });

  /** One expanded-search record with every name field and institution forged. */
  const forgedSearch = () =>
    normalizeExpandedSearch({
      'expanded-result': [
        {
          'orcid-id': ID,
          'given-names': forged('Josiah'),
          'family-names': forged('Carberry'),
          'credit-name': forged('J. S. Carberry'),
          'other-name': [forged('Josiah Stinkney Carberry')],
          email: [],
          'institution-name': [forged('Brown University')],
        },
      ],
      'num-found': 1,
    });

  it('orcid_search_researchers flattens the heading, names, other names, and institutions', async () => {
    mockExpandedSearch.mockResolvedValueOnce(forgedSearch());

    const result = await runToolContract(orcidSearchResearchers, { family_name: 'Carberry' });
    const text = textOf(result);

    // credit name twice (heading and its own line), given, family, other name, institution
    expectContained(text, { inline: 6, quoted: 0 });
    expect(text).toContain('### J. S. Carberry ## Forged\n');
    expect(verbatimCount(result.structuredContent)).toBe(5);
  });

  it('orcid_resolve_researcher flattens the heading, names, and institutions', async () => {
    mockExpandedSearch.mockResolvedValueOnce(forgedSearch());

    const result = await runToolContract(orcidResolveResearcher, { name: 'Josiah Carberry' });
    const text = textOf(result);

    // credit name twice (heading and its own line), given, family, institution
    expectContained(text, { inline: 5, quoted: 0 });
    expect(text).toContain('### 1. J. S. Carberry ## Forged\n');
    expect(verbatimCount(result.structuredContent)).toBe(4);
  });
});
