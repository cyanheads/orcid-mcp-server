/**
 * @fileoverview Tests for orcidSearchResearchers tool.
 * @module tests/tools/search-researchers.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';

// Mock the ORCID service module so tests don't make real HTTP calls.
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

/** Text of every content block the contract runner rendered. */
function contentText(result: { content: readonly { type: string }[] }): string {
  return result.content
    .flatMap((block) => ('text' in block && typeof block.text === 'string' ? [block.text] : []))
    .join('\n');
}

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

  it('rejects a call with no search field at input validation instead of searching *:* (#34)', () => {
    const parsed = orcidSearchResearchers.input.safeParse({});

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual([]);
    expect(parsed.error?.issues[0]?.message).toMatch(/at least one/i);
  });

  it('accepts `query` on its own and compiles it as the single clause', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 3, results: [] });

    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ query: 'grant-numbers:"NE/000393/1"' });
    await orcidSearchResearchers.handler(input, ctx);

    expect(getEnrichment(ctx).effectiveQuery).toBe('grant-numbers:"NE/000393/1"');
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

describe('orcidSearchResearchers — rendered page shape (characterization)', () => {
  it('renders the header and every record block exactly', () => {
    const output = orcidSearchResearchers.output.parse({
      results: [
        {
          orcidId: '0000-0001-9161-999X',
          orcidUri: 'https://orcid.org/0000-0001-9161-999X',
          givenNames: 'Jennifer',
          familyNames: 'Doudna',
          creditName: 'Jennifer A. Doudna',
          otherNames: ['J. A. Doudna', 'Jennifer Anne Doudna'],
          institutionNames: ['University of California, Berkeley', 'Gladstone Institutes'],
        },
        {
          orcidId: '0000-0002-1825-0097',
          orcidUri: 'https://orcid.org/0000-0002-1825-0097',
          otherNames: [],
          institutionNames: [],
        },
      ],
      rows: 2,
      start: 40,
      nextStart: 42,
    });

    const blocks = orcidSearchResearchers.format!(output);
    expect(blocks).toEqual([
      {
        type: 'text',
        text: [
          '## ORCID Search Results',
          '**Returned:** 2 | **Offset:** 40',
          '**Next Start:** 42',
          '',
          '### Jennifer A. Doudna',
          '**ORCID iD:** 0000-0001-9161-999X',
          '**ORCID URI:** https://orcid.org/0000-0001-9161-999X',
          '**Name:** Jennifer Doudna',
          '**Credit Name:** Jennifer A. Doudna',
          '**Other Names:** J. A. Doudna, Jennifer Anne Doudna',
          '**Institutions:** University of California, Berkeley; Gladstone Institutes',
          '',
          '### 0000-0002-1825-0097',
          '**ORCID iD:** 0000-0002-1825-0097',
          '**ORCID URI:** https://orcid.org/0000-0002-1825-0097',
          '',
        ].join('\n'),
      },
    ]);
  });

  it('returns an uncut default page with both surfaces intact', async () => {
    mockExpandedSearch.mockResolvedValueOnce({
      numFound: 24,
      results: Array.from({ length: 20 }, (_, i) => ({
        orcidId: `0000-0000-0001-${String(i).padStart(4, '0')}`,
        givenNames: 'Jane',
        familyNames: 'Smith',
        otherNames: [],
        emails: [],
        institutionNames: ['Example University'],
      })),
    });

    const result = await runToolContract(orcidSearchResearchers, { family_name: 'Smith' });
    const structured = result.structuredContent as {
      results: unknown[];
      rows: number;
      start: number;
      nextStart?: number;
      numFound: number;
      truncated: boolean;
      notice?: string;
    };

    expect(structured.results).toHaveLength(20);
    expect(structured).toMatchObject({
      rows: 20,
      start: 0,
      nextStart: 20,
      numFound: 24,
      truncated: false,
    });
    expect(structured.notice).toBeUndefined();
    expect(contentText(result)).toContain('**Returned:** 20 | **Offset:** 0\n**Next Start:** 20');
    expect(contentText(result)).toContain('**Total Found:** 24');
  });
});

describe('orcidSearchResearchers — response byte budget (#54)', () => {
  const BUDGET = 64_000;
  const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const textBytes = (result: { content: readonly { type: string }[] }) =>
    Buffer.byteLength(
      result.content
        .flatMap((block) => ('text' in block && typeof block.text === 'string' ? [block.text] : []))
        .join(''),
    );

  type Researcher = {
    orcidId: string;
    givenNames?: string;
    familyNames?: string;
    creditName?: string;
    otherNames: string[];
    emails: string[];
    institutionNames: string[];
  };

  /** A registry of `total` researchers whose record size varies with the index. */
  function registry(total: number, nameless = false): Researcher[] {
    return Array.from({ length: total }, (_, i) => ({
      orcidId: `0000-0000-${String(Math.floor(i / 10_000)).padStart(4, '0')}-${String(i % 10_000).padStart(4, '0')}`,
      ...(!nameless && i % 7 !== 0 && { givenNames: `Given${i}` }),
      ...(!nameless && { familyNames: 'Smith' }),
      ...(!nameless && i % 5 === 0 && { creditName: `G. Smith ${i}` }),
      otherNames: !nameless && i % 3 === 0 ? [`Alias ${i}`] : [],
      emails: [],
      institutionNames: nameless
        ? []
        : Array.from({ length: i % 6 }, (_, k) => `Institution ${k} of record ${i}`),
    }));
  }

  /** Serve `records` the way ORCID pages them: a slice at `start` of at most `rows`. */
  function serve(records: Researcher[], numFound = records.length) {
    mockExpandedSearch.mockImplementation(
      async ({ rows, start }: { rows: number; start: number }) => ({
        numFound,
        results: records.slice(start, start + rows),
      }),
    );
  }

  type Page = {
    results: { orcidId: string }[];
    rows: number;
    start: number;
    nextStart?: number;
    numFound: number;
    truncated: boolean;
    notice?: string;
  };

  it('cuts a 1,000-row page to fit both surfaces and continues exactly where it stopped', async () => {
    const records = registry(2_500);
    serve(records);

    const first = await runToolContract(orcidSearchResearchers, {
      family_name: 'Smith',
      rows: 1000,
    });
    const page1 = first.structuredContent as Page;

    expect(first.isError).toBeFalsy();
    expect(bytesOf(first.structuredContent)).toBeLessThanOrEqual(BUDGET);
    expect(textBytes(first)).toBeLessThanOrEqual(BUDGET);
    expect(page1.rows).toBe(page1.results.length);
    expect(page1.rows).toBeGreaterThan(0);
    expect(page1.rows).toBeLessThan(1000);
    expect(page1.nextStart).toBe(page1.start + page1.rows);
    expect(page1.numFound).toBe(2_500);
    expect(page1.truncated).toBe(false);
    expect(contentText(first)).toContain(`**Returned:** ${page1.rows} | **Offset:** 0`);

    const second = await runToolContract(orcidSearchResearchers, {
      family_name: 'Smith',
      rows: 1000,
      start: page1.nextStart,
    });
    const page2 = second.structuredContent as Page;

    expect(bytesOf(second.structuredContent)).toBeLessThanOrEqual(BUDGET);
    expect(textBytes(second)).toBeLessThanOrEqual(BUDGET);
    const ids1 = page1.results.map((r) => r.orcidId);
    const ids2 = page2.results.map((r) => r.orcidId);
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
    // Together the two pages are one contiguous read of the upstream order.
    expect([...ids1, ...ids2]).toEqual(
      records.slice(0, page1.rows + page2.rows).map((r) => r.orcidId),
    );
    expect(page2.nextStart).toBe(page2.start + page2.rows);
  });

  it('holds the text surface to the budget when records render as large as their JSON', async () => {
    // Name-less records render their iD as the heading, so text and JSON run neck and neck.
    serve(registry(1_000, true), 24_632);

    const result = await runToolContract(orcidSearchResearchers, {
      query: 'email:*example.edu',
      rows: 1000,
    });
    const page = result.structuredContent as Page;

    expect(bytesOf(result.structuredContent)).toBeLessThanOrEqual(BUDGET);
    expect(textBytes(result)).toBeLessThanOrEqual(BUDGET);
    expect(page.rows).toBeLessThan(1000);
    expect(page.nextStart).toBe(page.rows);
    // The ceiling notice still rides the cut page, and truncated keeps its ceiling meaning.
    expect(page.truncated).toBe(true);
    expect(page.notice).toContain('10,000');
  });

  it('always returns the first record, however large', async () => {
    serve([
      {
        orcidId: '0000-0000-0000-0001',
        familyNames: 'Smith',
        otherNames: [],
        emails: [],
        // ~100 KB on its own — past the budget before any other record is considered.
        institutionNames: Array.from(
          { length: 2_500 },
          (_, k) => `Institution number ${k} of many`,
        ),
      },
      ...registry(5),
    ]);

    const result = await runToolContract(orcidSearchResearchers, { family_name: 'Smith' });
    const page = result.structuredContent as Page;

    expect(bytesOf(result.structuredContent)).toBeGreaterThan(BUDGET);
    expect(page.rows).toBe(1);
    expect(page.results[0]?.orcidId).toBe('0000-0000-0000-0001');
    expect(page.nextStart).toBe(1);
  });

  it('omits nextStart when a cut page reaches neither more matches nor a legal offset', async () => {
    // A cut at start 9,990 still continues at most to the 10,000 ceiling.
    const records = registry(11_000);
    serve(records, 24_632);

    const result = await runToolContract(orcidSearchResearchers, {
      family_name: 'Smith',
      rows: 1000,
      start: 9_990,
    });
    const page = result.structuredContent as Page;

    expect(page.rows).toBeLessThan(1000);
    expect(page.rows).toBeGreaterThan(10);
    expect(page.nextStart).toBeUndefined();
  });
});

describe('orcidSearchResearchers — blank input is rejected at the schema (#34)', () => {
  it.each([
    ['no field at all', {}],
    ['only whitespace-only structured fields', { given_name: '   ', family_name: '\t' }],
    ['only a whitespace-only raw query', { query: '  ' }],
    ['only a whitespace-only grant number', { grant_number: ' ' }],
    ['a DOI that is only a URL prefix', { doi: 'https://doi.org/' }],
    ['a PMID that is only a URL prefix', { pmid: 'https://pubmed.ncbi.nlm.nih.gov/' }],
  ])(
    'rejects %s with invalid_arguments and a recovery hint naming the fields',
    async (_, input) => {
      const result = await runToolContract(orcidSearchResearchers, input);

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as {
          error: { code: number; data: { reason: string; recovery: { hint: string } } };
        }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data.reason).toBe('invalid_arguments');
      for (const field of ['given_name', 'family_name', 'doi', 'pmid', 'grant_number', 'query']) {
        expect(error.data.recovery.hint).toContain(field);
      }
      expect(contentText(result)).toContain(error.data.recovery.hint);
      expect(contentText(result)).toContain('(reason invalid_arguments)');
      expect(mockExpandedSearch).not.toHaveBeenCalled();
    },
  );

  it('still succeeds for a meaningful query that matches nothing, carrying the empty-result notice', async () => {
    mockExpandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });

    const result = await runToolContract(orcidSearchResearchers, { family_name: 'Xyzzyqx' });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { notice?: string; numFound: number };
    expect(structured.numFound).toBe(0);
    expect(structured.notice).toContain('No results found');
    expect(contentText(result)).toContain('No results found');
  });
});
