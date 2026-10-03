/**
 * @fileoverview Extended coverage for orcidSearchResearchers: additional Solr query
 * clause building, creditName rendering, ror_id/doi/pmid/grant_number fields, DOI/PMID
 * URL forms, and edge cases.
 * @module tests/tools/search-researchers-extended.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';

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

/** Run the handler for `raw` input against an empty upstream and return the compiled query. */
async function compiledQuery(raw: Record<string, unknown>): Promise<string> {
  mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });
  const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
  await orcidSearchResearchers.handler(orcidSearchResearchers.input.parse(raw), ctx);
  const [callParams] = mockExpandedSearch.mock.calls.at(-1)!;
  return callParams.q;
}

describe('orcidSearchResearchers — Solr clause building', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds ror-org-id clause with quotes for ror_id param', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      ror_id: 'https://ror.org/01an7q238',
    });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    // ROR colons and slashes are Solr-reserved — escaped inside the phrase quote.
    expect(callParams.q).toBe('ror-org-id:"https\\:\\/\\/ror.org\\/01an7q238"');
  });

  it('builds doi-self clause for doi param', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      doi: '10.1126/science.1225829',
    });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    // DOI slash is Solr-reserved — escaped so the value stays a literal, not a regex.
    expect(callParams.q).toBe('doi-self:"10.1126\\/science.1225829"');
  });

  it('builds pmid-self clause for pmid param', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      pmid: '22745249',
    });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('pmid-self:"22745249"');
  });

  it('appends raw query field with AND, as one group, to structured clauses', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      family_name: 'Doudna',
      query: 'email:*berkeley.edu',
    });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('family-name:"Doudna" AND (email:*berkeley.edu)');
  });

  it('phrase-quotes given_name so multi-word names phrase-match (#9)', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ given_name: 'Mary Ann' });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('given-names:"Mary Ann"');
  });

  it('phrase-quotes family_name so compound surnames phrase-match (#9)', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ family_name: 'Van Damme' });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('family-name:"Van Damme"');
  });

  it('rejects a call whose only params are whitespace-only instead of searching *:* (#34)', () => {
    expect(() =>
      orcidSearchResearchers.input.parse({
        given_name: '   ',
        family_name: '  ',
      }),
    ).toThrow(/at least one/i);
  });

  it('compiles every structured field, in a fixed order, ANDed ahead of the raw query', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      query: 'email:*berkeley.edu',
      pmid: '22745249',
      doi: '10.1126/science.1225829',
      ror_id: 'https://ror.org/01an7q238',
      keyword: 'CRISPR',
      affiliation: 'UC Berkeley',
      family_name: 'Doudna',
      given_name: 'Jennifer',
    });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe(
      'given-names:"Jennifer" AND family-name:"Doudna" AND affiliation-org-name:"UC Berkeley" AND keyword:"CRISPR" AND ror-org-id:"https\\:\\/\\/ror.org\\/01an7q238" AND doi-self:"10.1126\\/science.1225829" AND pmid-self:"22745249" AND (email:*berkeley.edu)',
    );
  });

  it('skips a blank field supplied alongside a non-blank one (form-client payload)', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      given_name: '',
      family_name: '  Doudna  ',
      affiliation: '   ',
      doi: '',
      pmid: '',
      query: '',
    });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('family-name:"Doudna"');
  });

  it('forwards a DOI with its case intact', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ doi: '10.1371/journal.PMED.0020124' });
    await orcidSearchResearchers.handler(input, ctx);

    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('doi-self:"10.1371\\/journal.PMED.0020124"');
  });

  it('passes rows and start to the service call', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 50, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      family_name: 'Smith',
      rows: 50,
      start: 100,
    });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
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
  // Every case carries one search field so only the bound under test decides the outcome.
  const field = { family_name: 'Smith' };

  it('accepts rows at minimum boundary (1)', () => {
    expect(() => orcidSearchResearchers.input.parse({ ...field, rows: 1 })).not.toThrow();
  });

  it('accepts rows at maximum boundary (1000)', () => {
    expect(() => orcidSearchResearchers.input.parse({ ...field, rows: 1000 })).not.toThrow();
  });

  it('accepts start at minimum boundary (0)', () => {
    expect(() => orcidSearchResearchers.input.parse({ ...field, start: 0 })).not.toThrow();
  });

  it('defaults rows to 20 when not provided', () => {
    const input = orcidSearchResearchers.input.parse(field);
    expect(input.rows).toBe(20);
  });

  it('defaults start to 0 when not provided', () => {
    const input = orcidSearchResearchers.input.parse(field);
    expect(input.start).toBe(0);
  });
});

describe('orcidSearchResearchers — grant_number filter (#42)', () => {
  it('compiles a phrase-quoted, escaped grant-numbers clause', async () => {
    expect(await compiledQuery({ grant_number: '5F31MH010500-03' })).toBe(
      'grant-numbers:"5F31MH010500\\-03"',
    );
  });

  it('escapes a slash-bearing grant number inside the phrase, never emitting the unquoted form', async () => {
    const q = await compiledQuery({ grant_number: ' NE/000393/1 ' });
    expect(q).toBe('grant-numbers:"NE\\/000393\\/1"');
    expect(q).not.toMatch(/grant-numbers:[^"]/);
  });

  it('ANDs after the identifier anchors and ahead of the raw query', async () => {
    expect(
      await compiledQuery({
        query: 'email:*berkeley.edu',
        grant_number: 'R01GM123456',
        pmid: '22745249',
        family_name: 'Doudna',
      }),
    ).toBe(
      'family-name:"Doudna" AND pmid-self:"22745249" AND grant-numbers:"R01GM123456" AND (email:*berkeley.edu)',
    );
  });

  it('skips a blank grant_number supplied alongside another field', async () => {
    expect(await compiledQuery({ grant_number: '   ', family_name: 'Doudna' })).toBe(
      'family-name:"Doudna"',
    );
  });

  it('returns a structured success with the empty-result notice when no record carries the grant', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });
    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const result = await orcidSearchResearchers.handler(
      orcidSearchResearchers.input.parse({ grant_number: 'NO-SUCH-GRANT-0' }),
      ctx,
    );

    expect(result.results).toEqual([]);
    expect(getEnrichment(ctx).notice).toContain('No results found');
  });

  it('describes phrase-match, case-insensitive semantics rather than an exact lookup', () => {
    const description = orcidSearchResearchers.input.shape.grant_number.description ?? '';
    expect(description).toMatch(/phrase/i);
    expect(description).toMatch(/case-insensitive/i);
  });
});

describe('orcidSearchResearchers — DOI/PMID URL forms (#44)', () => {
  it.each([
    'https://doi.org/10.5555/12345680',
    'http://doi.org/10.5555/12345680',
    'https://dx.doi.org/10.5555/12345680',
    'doi:10.5555/12345680',
    'DOI:10.5555/12345680',
    'HTTPS://DOI.ORG/10.5555/12345680',
    'doi.org/10.5555/12345680',
    'doi: 10.5555/12345680',
    '  https://doi.org/10.5555/12345680  ',
  ])('compiles %s to the same doi-self clause as the bare DOI', async (doi) => {
    expect(await compiledQuery({ doi })).toBe(await compiledQuery({ doi: '10.5555/12345680' }));
  });

  it('keeps the case of the DOI body when stripping an uppercase prefix', async () => {
    expect(await compiledQuery({ doi: 'HTTPS://DOI.ORG/10.1371/journal.PMED.0020124' })).toBe(
      'doi-self:"10.1371\\/journal.PMED.0020124"',
    );
  });

  it.each([
    'https://pubmed.ncbi.nlm.nih.gov/22745249/',
    'https://pubmed.ncbi.nlm.nih.gov/22745249',
    'http://www.ncbi.nlm.nih.gov/pubmed/22745249',
    'https://ncbi.nlm.nih.gov/pubmed/22745249/',
    'HTTPS://PUBMED.NCBI.NLM.NIH.GOV/22745249/',
    'pubmed.ncbi.nlm.nih.gov/22745249/',
    // Copied from a PubMed results page: the URL carries a query string or fragment.
    'https://pubmed.ncbi.nlm.nih.gov/22745249/?from_single_result=22745249',
    'https://pubmed.ncbi.nlm.nih.gov/22745249/#affiliation-1',
    // A citation label, which would otherwise be searched as part of the identifier.
    'PMID: 22745249',
    'pmid:22745249',
  ])('compiles %s to the same pmid-self clause as the bare PMID', async (pmid) => {
    expect(await compiledQuery({ pmid })).toBe('pmid-self:"22745249"');
  });

  it('drops a prefix-only DOI supplied alongside another field rather than emitting an empty clause', async () => {
    expect(await compiledQuery({ doi: 'https://doi.org/', family_name: 'Carberry' })).toBe(
      'family-name:"Carberry"',
    );
  });

  it('keeps a DOI or PMID with inner whitespace inside its own phrase clause (#47)', async () => {
    expect(await compiledQuery({ doi: '10.1000/x OR smith', family_name: 'Carberry' })).toBe(
      'family-name:"Carberry" AND doi-self:"10.1000\\/x OR smith"',
    );
    expect(await compiledQuery({ pmid: '22745249 AND smith' })).toBe(
      'pmid-self:"22745249 AND smith"',
    );
  });
});

describe('orcidSearchResearchers — ror_id forms (#55)', () => {
  const CANONICAL_CLAUSE = 'ror-org-id:"https\\:\\/\\/ror.org\\/00cvxb145"';

  /** The messages of every issue a parse reports, in order. */
  function issueMessages(raw: Record<string, unknown>): string[] {
    const result = orcidSearchResearchers.input.safeParse(raw);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  }

  it.each([
    '00cvxb145',
    'ror.org/00cvxb145',
    'http://ror.org/00cvxb145',
    'https://www.ror.org/00cvxb145/',
    'https://ror.org/00CVXB145',
    ' 00cvxb145 ',
    'https://ror.org/00cvxb145',
  ])('compiles %j to the canonical ror-org-id clause', async (rorId) => {
    expect(await compiledQuery({ ror_id: rorId })).toBe(CANONICAL_CLAUSE);
  });

  it('rejects a shape-valid ID with wrong check digits with only the check-digit message', () => {
    expect(issueMessages({ ror_id: 'https://ror.org/00cvxb146' })).toEqual([
      'The ROR ID is invalid — its check digits do not match. Verify the ID and try again.',
    ]);
  });

  it.each([
    'Stanford University',
    'grid.168010.e',
    'https://ror.org/',
    'HTTPS://ROR.ORG/00cvxb145',
  ])('rejects %j with only the shape message', (rorId) => {
    expect(issueMessages({ ror_id: rorId })).toEqual([
      'Must be a ROR ID: 00cvxb145, ror.org/00cvxb145, or https://ror.org/00cvxb145.',
    ]);
  });

  it.each(['', '   '])('treats ror_id %j beside another field as unset', async (rorId) => {
    expect(await compiledQuery({ ror_id: rorId, family_name: 'Doudna' })).toBe(
      'family-name:"Doudna"',
    );
  });

  it('still rejects a blank ror_id supplied alone with the non-blank-field message', () => {
    expect(issueMessages({ ror_id: '' })).toEqual([
      'Provide at least one non-blank search field: given_name, family_name, affiliation, keyword, ror_id, doi, pmid, grant_number, or query.',
    ]);
  });

  it('advertises a ror_id JSON Schema that admits exactly what the server accepts', () => {
    const inputSchema = z.toJSONSchema(orcidSearchResearchers.input) as unknown as {
      properties: { ror_id: { type: string; pattern: string; anyOf?: unknown } };
    };
    const { ror_id: advertised } = inputSchema.properties;
    expect(advertised.type).toBe('string');
    expect(advertised.anyOf).toBeUndefined();
    const pattern = new RegExp(advertised.pattern);

    // Blank, whitespace-only, and padded values are accepted (blank is unset), so the schema
    // a form-based client validates against must admit them too.
    for (const value of ['', '   ', ' 05gq02987 ', '00cvxb145', 'https://www.ror.org/00CVXB145/']) {
      expect(pattern.test(value), value).toBe(true);
      expect(
        orcidSearchResearchers.input.safeParse({ ror_id: value, family_name: 'Doudna' }).success,
      ).toBe(true);
    }
    // The shape rejections stay in the advertised grammar.
    for (const value of [
      'Stanford University',
      'grid.168010.e',
      'https://ror.org/',
      'HTTPS://ROR.ORG/00cvxb145',
    ]) {
      expect(pattern.test(value), value).toBe(false);
    }
  });

  it('runs no upstream search for a rejected ror_id', async () => {
    const result = await runToolContract(orcidSearchResearchers, {
      ror_id: 'https://ror.org/00cvxb146',
    });
    expect(result.isError).toBe(true);
    expect(mockExpandedSearch).not.toHaveBeenCalled();
  });
});

describe('orcidSearchResearchers — raw query grouping (#61)', () => {
  it('groups a top-level OR so its alternatives survive the structured AND', async () => {
    expect(
      await compiledQuery({
        family_name: 'Doudna',
        query: 'given-names:Jennifer OR given-names:John',
      }),
    ).toBe('family-name:"Doudna" AND (given-names:Jennifer OR given-names:John)');
  });

  it('groups an already-parenthesized query again', async () => {
    expect(
      await compiledQuery({
        family_name: 'Doudna',
        query: '(given-names:Jennifer OR given-names:John)',
      }),
    ).toBe('family-name:"Doudna" AND ((given-names:Jennifer OR given-names:John))');
  });

  it.each([
    ['-given-names:John', 'family-name:"Doudna" AND -given-names:John'],
    ['NOT given-names:John', 'family-name:"Doudna" AND NOT given-names:John'],
    ['!given-names:John', 'family-name:"Doudna" AND !given-names:John'],
    [
      '-given-names:John -given-names:"Mary Ann"',
      'family-name:"Doudna" AND -given-names:John -given-names:"Mary Ann"',
    ],
    [
      'NOT (given-names:John OR given-names:Jo*)',
      'family-name:"Doudna" AND NOT (given-names:John OR given-names:Jo*)',
    ],
  ])('leaves the exclusion-only query %j ungrouped', async (query, expected) => {
    expect(await compiledQuery({ family_name: 'Doudna', query })).toBe(expected);
  });

  it('groups a query that mixes an exclusion with a positive clause', async () => {
    expect(
      await compiledQuery({ family_name: 'Doudna', query: '-given-names:John keyword:crispr' }),
    ).toBe('family-name:"Doudna" AND (-given-names:John keyword:crispr)');
  });

  it('forwards a query supplied alone byte-for-byte', async () => {
    expect(await compiledQuery({ query: 'given-names:Jennifer OR given-names:John' })).toBe(
      'given-names:Jennifer OR given-names:John',
    );
    expect(await compiledQuery({ query: '  -given-names:John  ' })).toBe('-given-names:John');
  });
});

describe('orcidSearchResearchers — initials-only given_name (#53)', () => {
  it.each([
    ['J.', 'given-names:J*'],
    ['J', 'given-names:J*'],
    ['j.', 'given-names:j*'],
    [' J. ', 'given-names:J*'],
    ['J. A.', 'given-names:J* AND given-names:A*'],
    ['J.A.', 'given-names:J* AND given-names:A*'],
    // A decomposed accented initial is sent in its composed form.
    ['É.', 'given-names:É*'],
  ])('compiles %j to one prefix term per initial', async (givenName, expected) => {
    expect(await compiledQuery({ given_name: givenName })).toBe(expected);
  });

  it.each([
    ['Mary Ann', 'given-names:"Mary Ann"'],
    ['J. Ann', 'given-names:"J. Ann"'],
    ['Jo', 'given-names:"Jo"'],
    ['伸', 'given-names:"伸"'],
    ['.', 'given-names:"."'],
    ['J*', 'given-names:"J\\*"'],
  ])('keeps any other value %j as a phrase (#9)', async (givenName, expected) => {
    expect(await compiledQuery({ given_name: givenName })).toBe(expected);
  });

  it('ANDs the prefix terms ahead of the other structured clauses', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 2,
      results: [
        {
          orcidId: '0000-0001-9161-999X',
          givenNames: 'Jennifer',
          familyNames: 'Doudna',
          otherNames: [],
          emails: [],
          institutionNames: [],
        },
        {
          orcidId: '0000-0003-0697-2030',
          givenNames: 'John',
          familyNames: 'Doudna',
          otherNames: [],
          emails: [],
          institutionNames: [],
        },
      ],
    });

    const result = await runToolContract(orcidSearchResearchers, {
      given_name: 'J.',
      family_name: 'Doudna',
    });
    const structured = result.structuredContent as {
      results: { orcidId: string }[];
      effectiveQuery: string;
    };
    const text = result.content
      .flatMap((block) => ('text' in block && typeof block.text === 'string' ? [block.text] : []))
      .join('\n');

    expect(mockExpandedSearch.mock.calls[0]![0].q).toBe('given-names:J* AND family-name:"Doudna"');
    expect(structured.effectiveQuery).toBe('given-names:J* AND family-name:"Doudna"');
    expect(structured.results.map((r) => r.orcidId)).toEqual([
      '0000-0001-9161-999X',
      '0000-0003-0697-2030',
    ]);
    expect(text).toContain('**Effective Query:** given-names:J* AND family-name:"Doudna"');
  });

  it('counts an initials-only given_name as a non-blank search field', () => {
    expect(orcidSearchResearchers.input.safeParse({ given_name: 'J.' }).success).toBe(true);
  });
});

describe('orcidSearchResearchers — Solr value escaping (#18)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('escapes an embedded quote in family_name so it cannot break the phrase', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ family_name: 'O"Connor' });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('family-name:"O\\"Connor"');
  });

  it('escapes a backslash in a structured value', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ keyword: 'a\\b' });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    expect(callParams.q).toBe('keyword:"a\\\\b"');
  });

  it('escapes punctuation-heavy DOI reserved chars, leaving non-reserved chars intact', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      doi: '10.1002/(SICI)1099-0844(199912)17:4<290::AID-CBF849>3.0.CO;2-P',
    });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    // Reserved chars (/ ( ) - :) escaped; non-reserved (< > ;) left literal.
    expect(callParams.q).toBe(
      'doi-self:"10.1002\\/\\(SICI\\)1099\\-0844\\(199912\\)17\\:4<290\\:\\:AID\\-CBF849>3.0.CO;2\\-P"',
    );
  });

  it('leaves the raw query passthrough unescaped', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({
      query: 'given-names:Jennifer AND (family-name:Doudna OR family-name:*)',
    });
    await orcidSearchResearchers.handler(input, ctx);

    expect(mockExpandedSearch).toHaveBeenCalled();
    const [callParams] = mockExpandedSearch.mock.calls[0]!;
    // The raw query field is forwarded verbatim — its Solr operators are intentional.
    expect(callParams.q).toBe('given-names:Jennifer AND (family-name:Doudna OR family-name:*)');
  });
});

describe('orcidSearchResearchers — query_failed contract (#31)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries reason and a recovery hint naming the query field on a non-transient failure', async () => {
    // ORCID answers malformed raw Solr with a 500 naming a Solr exception, which the service
    // classifies as InvalidParams rather than a retryable outage.
    mockExpandedSearch.mockRejectedValueOnce(
      new McpError(
        JsonRpcErrorCode.InvalidParams,
        'ORCID returned HTTP 500 Internal Server Error.',
      ),
    );

    const result = await runToolContract(orcidSearchResearchers, {
      query: 'family-name:[unclosed',
    });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: {
        code: number;
        message: string;
        data: { reason: string; recovery: { hint: string } };
      };
    };
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    const { data } = error;
    expect(data.reason).toBe('query_failed');
    expect(data.recovery.hint).toContain('query');
    // The submitted query is echoed so the agent can see what it sent.
    expect(error.message).toContain('family-name:[unclosed');
    // Never the upstream endpoint.
    expect(JSON.stringify(data)).not.toContain('orcid.org');
  });

  it.each([
    [
      'an outage',
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'ORCID returned HTTP 503.', {
        retryAfter: '30',
      }),
    ],
    [
      'the request deadline',
      new McpError(JsonRpcErrorCode.Timeout, 'ORCID request exceeded its 25000ms retry deadline.', {
        reason: 'retry_deadline_exceeded',
      }),
    ],
    [
      'a rate limit',
      new McpError(JsonRpcErrorCode.RateLimited, 'ORCID returned HTTP 429.', { retryAfter: '5' }),
    ],
  ])('rethrows %s unchanged so the retryable signal survives', async (_, upstream) => {
    mockExpandedSearch.mockRejectedValueOnce(upstream);

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ family_name: 'Doudna' });
    const err = await Promise.resolve(orcidSearchResearchers.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toBe(upstream);
  });
});
