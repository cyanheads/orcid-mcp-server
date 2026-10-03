/**
 * @fileoverview orcidResolveResearcher name forms (#53): the exact phrase stays the first
 * query, a "Family, Given" name is reordered before any clause is built, and byline initials
 * and other-names aliases are reached through later stages that run only when every earlier
 * stage found nothing. Also pins how an initial counts toward nameMatchType.
 * @module tests/tools/resolve-researcher-name-forms.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';
import type { ExpandedSearchResult } from '@/services/orcid/types.js';

const mockExpandedSearch = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ expandedSearch: mockExpandedSearch }),
}));

type Response = { numFound: number; results: ExpandedSearchResult[] };

const NONE: Response = { numFound: 0, results: [] };
const found = (...results: ExpandedSearchResult[]): Response => ({
  numFound: results.length,
  results,
});

/** Answer each query from `responses`; a query the test did not list fails loudly. */
function route(responses: Record<string, Response>) {
  mockExpandedSearch.mockImplementation(async ({ q }: { q: string }) => {
    const response = responses[q];
    if (!response) throw new Error(`unmocked query: ${q}`);
    return response;
  });
}

/** Every query sent upstream, in order. */
const queriesSent = () => mockExpandedSearch.mock.calls.map(([params]) => params.q as string);

function researcher(
  orcidId: string,
  givenNames: string,
  familyNames: string,
  extra: Partial<ExpandedSearchResult> = {},
): ExpandedSearchResult {
  return {
    orcidId,
    givenNames,
    familyNames,
    otherNames: [],
    emails: [],
    institutionNames: [],
    ...extra,
  };
}

const jenniferDoudna = researcher('0000-0001-9161-999X', 'Jennifer', 'Doudna', {
  institutionNames: ['University of California, Berkeley'],
});
const johnDoudna = researcher('0000-0003-0697-2030', 'John', 'Doudna');
const carberry = researcher('0000-0002-1825-0097', 'Josiah', 'Carberry', {
  otherNames: ['Josiah Stinkney Carberry', 'J. Carberry', 'J. S. Carberry'],
});

function contentText(result: { content: readonly { type: string }[] }): string {
  return result.content
    .flatMap((block) => ('text' in block && typeof block.text === 'string' ? [block.text] : []))
    .join('\n');
}

beforeEach(() => {
  mockExpandedSearch.mockReset();
  mockExpandedSearch.mockRejectedValue(new Error('unmocked fetch'));
});

describe('orcidResolveResearcher — names that resolve as a phrase are unchanged (#4, #53)', () => {
  it.each([
    ['Jennifer Doudna', [jenniferDoudna]],
    [
      'John Smith',
      [
        researcher('0000-0002-0000-0001', 'John', 'Smith'),
        researcher('0000-0002-0000-0002', 'John', 'Smith'),
      ],
    ],
    [
      'Wei Wang',
      [
        researcher('0000-0003-0000-0001', 'Wei', 'Wang'),
        researcher('0000-0003-0000-0002', 'Wei', 'Wang'),
      ],
    ],
  ])(
    '"%s" sends one query, the exact phrase, and returns its candidates',
    async (name, records) => {
      const phrase = `given-and-family-names:"${name}"`;
      route({ [phrase]: found(...records) });

      const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
      const result = await orcidResolveResearcher.handler(
        orcidResolveResearcher.input.parse({ name, rows: 20 }),
        ctx,
      );
      const enrichment = getEnrichment(ctx);

      expect(queriesSent()).toEqual([phrase]);
      expect(result.candidates.map((c) => [c.orcidId, c.nameMatchType])).toEqual(
        records.map((r) => [r.orcidId, 'exact']),
      );
      expect(enrichment.queryUsed).toBe(phrase);
      expect(enrichment.primaryQuery).toBe(phrase);
      expect(enrichment.relaxedQuery).toBeUndefined();
    },
  );
});

describe('orcidResolveResearcher — byline initials (#53)', () => {
  it('"J. Doudna" falls through the phrase to the one-word byline clause', async () => {
    const byline = 'given-and-family-names:("Doudna" AND J*)';
    route({
      'given-and-family-names:"J. Doudna"': NONE,
      [byline]: found(jenniferDoudna, johnDoudna),
    });

    const result = await runToolContract(orcidResolveResearcher, { name: 'J. Doudna' });
    const structured = result.structuredContent as {
      candidates: { orcidId: string; nameMatchType: string }[];
      queryUsed: string;
      relaxedQuery?: string;
      totalFound: number;
      primaryQuery: string;
      primaryTotalFound: number;
    };

    expect(result.isError).toBeFalsy();
    expect(queriesSent()).toEqual(['given-and-family-names:"J. Doudna"', byline]);
    expect(structured.candidates.map((c) => [c.orcidId, c.nameMatchType])).toEqual([
      ['0000-0001-9161-999X', 'partial'],
      ['0000-0003-0697-2030', 'partial'],
    ]);
    expect(structured).toMatchObject({
      queryUsed: byline,
      relaxedQuery: byline,
      totalFound: 2,
      primaryQuery: 'given-and-family-names:"J. Doudna"',
      primaryTotalFound: 0,
    });
    const text = contentText(result);
    expect(text).toContain(`**Query Used:** ${byline}`);
    expect(text).toContain('**Primary Query:** given-and-family-names:"J. Doudna"');
    expect(text).toContain('**Name Match:** partial');
    expect(text).not.toContain('**Name Match:** exact');
  });

  it('"Jennifer A. Doudna" drops the initial into the phrase slop', async () => {
    const byline = 'given-and-family-names:"Jennifer Doudna"~1';
    route({ 'given-and-family-names:"Jennifer A. Doudna"': NONE, [byline]: found(jenniferDoudna) });

    const result = await runToolContract(orcidResolveResearcher, { name: 'Jennifer A. Doudna' });
    const structured = result.structuredContent as {
      candidates: { orcidId: string; nameMatchType: string }[];
      queryUsed: string;
    };

    expect(queriesSent()).toEqual(['given-and-family-names:"Jennifer A. Doudna"', byline]);
    expect(structured.candidates.map((c) => [c.orcidId, c.nameMatchType])).toEqual([
      ['0000-0001-9161-999X', 'partial'],
    ]);
    expect(structured.queryUsed).toBe(byline);
    expect(contentText(result)).toContain(`**Query Used:** ${byline}`);
  });

  it.each([
    ['Jennifer A. B. Doudna', 'given-and-family-names:"Jennifer Doudna"~2'],
    ['J. A. Doudna', 'given-and-family-names:("Doudna" AND J*)'],
    ['J.A. Doudna', 'given-and-family-names:("Doudna" AND J*)'],
    ['J Doudna', 'given-and-family-names:("Doudna" AND J*)'],
    ['j. doudna', 'given-and-family-names:("doudna" AND j*)'],
    ['Doudna J.', 'given-and-family-names:("Doudna" AND J*)'],
    ['Mary A. Ann Smith', 'given-and-family-names:"Mary Ann Smith"~1'],
    // A decomposed accented initial is sent in its composed form.
    ['É. Durand', 'given-and-family-names:("Durand" AND É*)'],
  ])('"%s" compiles the byline stage %s', async (name, byline) => {
    route({ [`given-and-family-names:"${name}"`]: NONE, [byline]: found(jenniferDoudna) });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    await orcidResolveResearcher.handler(orcidResolveResearcher.input.parse({ name }), ctx);

    expect(queriesSent()).toEqual([`given-and-family-names:"${name}"`, byline]);
  });

  it('runs the byline with the affiliation before dropping the affiliation', async () => {
    const affiliation = 'affiliation-org-name:"University of Cambridge"';
    const bylineWithAffiliation = `given-and-family-names:("Smith" AND J*) AND ${affiliation}`;
    const smith = researcher('0000-0002-0000-0003', 'John', 'Smith', {
      institutionNames: ['University of Cambridge'],
    });
    route({
      [`given-and-family-names:"J. Smith" AND ${affiliation}`]: NONE,
      [bylineWithAffiliation]: found(smith),
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const result = await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({
        name: 'J. Smith',
        affiliation: 'University of Cambridge',
      }),
      ctx,
    );
    const enrichment = getEnrichment(ctx);

    expect(queriesSent()).toEqual([
      `given-and-family-names:"J. Smith" AND ${affiliation}`,
      bylineWithAffiliation,
    ]);
    expect(result.candidates[0]).toMatchObject({
      orcidId: '0000-0002-0000-0003',
      nameMatchType: 'partial',
      institutionOverlap: true,
    });
    expect(enrichment.queryUsed).toBe(bylineWithAffiliation);
  });

  it('builds no byline when every word is an initial or none is', async () => {
    route({
      'given-and-family-names:"J. D."': NONE,
      'other-names:"J. D."': NONE,
      'given-and-family-names:"Jennifer Doudna Smith"': NONE,
      'other-names:"Jennifer Doudna Smith"': NONE,
    });

    for (const name of ['J. D.', 'Jennifer Doudna Smith']) {
      const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
      await orcidResolveResearcher.handler(orcidResolveResearcher.input.parse({ name }), ctx);
    }

    expect(queriesSent()).toEqual([
      'given-and-family-names:"J. D."',
      'other-names:"J. D."',
      'given-and-family-names:"Jennifer Doudna Smith"',
      'other-names:"Jennifer Doudna Smith"',
    ]);
  });

  it('treats a one-character CJK given name as a word, not an initial', async () => {
    route({ 'given-and-family-names:"山中 伸"': NONE, 'other-names:"山中 伸"': NONE });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({ name: '山中 伸' }),
      ctx,
    );

    expect(queriesSent()).toEqual(['given-and-family-names:"山中 伸"', 'other-names:"山中 伸"']);
  });
});

describe('orcidResolveResearcher — "Family, Given" names (#53)', () => {
  it('reorders "Doudna, Jennifer" before the first query and matches it exactly', async () => {
    route({ 'given-and-family-names:"Jennifer Doudna"': found(jenniferDoudna) });

    const result = await runToolContract(orcidResolveResearcher, { name: 'Doudna, Jennifer' });
    const structured = result.structuredContent as {
      candidates: { orcidId: string; nameMatchType: string }[];
      queryUsed: string;
      primaryQuery: string;
    };

    expect(queriesSent()).toEqual(['given-and-family-names:"Jennifer Doudna"']);
    expect(structured.candidates.map((c) => [c.orcidId, c.nameMatchType])).toEqual([
      ['0000-0001-9161-999X', 'exact'],
    ]);
    expect(structured.primaryQuery).toBe('given-and-family-names:"Jennifer Doudna"');
    expect(contentText(result)).toContain('**Name Match:** exact');
  });

  it('reorders a byline comma form before building the byline clause', async () => {
    route({
      'given-and-family-names:"J. Doudna"': NONE,
      'given-and-family-names:("Doudna" AND J*)': found(jenniferDoudna),
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const result = await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({ name: 'Doudna, J.' }),
      ctx,
    );

    expect(queriesSent()).toEqual([
      'given-and-family-names:"J. Doudna"',
      'given-and-family-names:("Doudna" AND J*)',
    ]);
    expect(result.candidates[0]!.nameMatchType).toBe('partial');
  });

  it.each([
    ['  Doudna ,  Jennifer  ', 'given-and-family-names:"Jennifer Doudna"'],
    ['Smith, John, Jr.', 'given-and-family-names:"Smith, John, Jr."'],
    [', Jennifer', 'given-and-family-names:", Jennifer"'],
    ['Doudna,', 'given-and-family-names:"Doudna,"'],
  ])('compiles %j to the first query %s', async (name, phrase) => {
    route({ [phrase]: found(jenniferDoudna) });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    await orcidResolveResearcher.handler(orcidResolveResearcher.input.parse({ name }), ctx);

    expect(queriesSent()).toEqual([phrase]);
  });

  it('echoes the name as the caller wrote it in the empty-result notice', async () => {
    route({
      'given-and-family-names:"Jennifer Doudna"': NONE,
      'other-names:"Jennifer Doudna"': NONE,
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({ name: 'Doudna, Jennifer' }),
      ctx,
    );

    expect(getEnrichment(ctx).notice).toBe(
      'No ORCID records found matching "Doudna, Jennifer". Try a different spelling or use orcid_search_researchers with a broader query.',
    );
  });
});

describe('orcidResolveResearcher — other-names aliases (#53)', () => {
  it('"Josiah Stinkney Carberry" resolves through the other-names stage', async () => {
    const alias = 'other-names:"Josiah Stinkney Carberry"';
    route({ 'given-and-family-names:"Josiah Stinkney Carberry"': NONE, [alias]: found(carberry) });

    const result = await runToolContract(orcidResolveResearcher, {
      name: 'Josiah Stinkney Carberry',
    });
    const structured = result.structuredContent as {
      candidates: { orcidId: string; nameMatchType: string }[];
      queryUsed: string;
      relaxedQuery?: string;
      totalFound: number;
    };

    expect(queriesSent()).toEqual(['given-and-family-names:"Josiah Stinkney Carberry"', alias]);
    // Given and family names overlap two input words, so the tier is partial, not other-name.
    expect(structured.candidates.map((c) => [c.orcidId, c.nameMatchType])).toEqual([
      ['0000-0002-1825-0097', 'partial'],
    ]);
    expect(structured).toMatchObject({ queryUsed: alias, relaxedQuery: alias, totalFound: 1 });
    expect(contentText(result)).toContain(`**Query Used:** ${alias}`);
  });

  it('keeps every anchor on the other-names stage but no affiliation', async () => {
    const anchors = 'doi-self:"10.1\\/x" AND pmid-self:"123"';
    const affiliation = 'affiliation-org-name:"Wesleyan University"';
    route({
      [`given-and-family-names:"Josiah Stinkney Carberry" AND ${anchors} AND ${affiliation}`]: NONE,
      [`given-and-family-names:"Josiah Stinkney Carberry" AND ${anchors}`]: NONE,
      [`other-names:"Josiah Stinkney Carberry" AND ${anchors}`]: found(carberry),
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const result = await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({
        name: 'Josiah Stinkney Carberry',
        affiliation: 'Wesleyan University',
        doi: '10.1/x',
        pmid: '123',
      }),
      ctx,
    );

    expect(queriesSent()).toHaveLength(3);
    expect(queriesSent()[2]).toBe(`other-names:"Josiah Stinkney Carberry" AND ${anchors}`);
    expect(result.candidates[0]!.anchorType).toBe('doi');
  });

  it('escapes the name inside the other-names phrase', async () => {
    route({
      'given-and-family-names:"Jean \\"Bob\\" Smith"': NONE,
      'other-names:"Jean \\"Bob\\" Smith"': NONE,
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({ name: 'Jean "Bob" Smith' }),
      ctx,
    );

    expect(queriesSent()).toEqual([
      'given-and-family-names:"Jean \\"Bob\\" Smith"',
      'other-names:"Jean \\"Bob\\" Smith"',
    ]);
  });
});

describe('orcidResolveResearcher — the full stage chain (#53)', () => {
  it('runs every stage in order, each only after the earlier ones found nothing', async () => {
    const anchors = 'doi-self:"10.1\\/x" AND pmid-self:"123"';
    const affiliation = 'affiliation-org-name:"MIT"';
    const stages = [
      `given-and-family-names:"J. Smith" AND ${anchors} AND ${affiliation}`,
      `given-and-family-names:("Smith" AND J*) AND ${anchors} AND ${affiliation}`,
      `given-and-family-names:"J. Smith" AND ${anchors}`,
      `given-and-family-names:("Smith" AND J*) AND ${anchors}`,
      `other-names:"J. Smith" AND ${anchors}`,
      'doi-self:"10.1\\/x"',
      'pmid-self:"123"',
    ];
    const smith = researcher('0000-0002-0000-0004', 'Jane', 'Smith');
    route({
      ...Object.fromEntries(stages.slice(0, -1).map((q) => [q, NONE])),
      'pmid-self:"123"': { numFound: 7, results: [smith] },
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const result = await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({
        name: 'J. Smith',
        affiliation: 'MIT',
        doi: '10.1/x',
        pmid: '123',
      }),
      ctx,
    );
    const enrichment = getEnrichment(ctx);

    expect(queriesSent()).toEqual(stages);
    expect(result.candidates[0]).toMatchObject({ anchorType: 'pmid', nameMatchType: 'partial' });
    expect(enrichment).toMatchObject({
      queryUsed: 'pmid-self:"123"',
      relaxedQuery: 'pmid-self:"123"',
      totalFound: 7,
      primaryQuery: stages[0],
      primaryTotalFound: 0,
    });
  });

  it('stops at the first stage that finds a record', async () => {
    const affiliation = 'affiliation-org-name:"MIT"';
    route({
      [`given-and-family-names:"J. Smith" AND ${affiliation}`]: NONE,
      [`given-and-family-names:("Smith" AND J*) AND ${affiliation}`]: NONE,
      'given-and-family-names:"J. Smith"': { numFound: 87, results: [johnDoudna] },
    });

    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({ name: 'J. Smith', affiliation: 'MIT' }),
      ctx,
    );
    const enrichment = getEnrichment(ctx);

    expect(queriesSent()).toHaveLength(3);
    expect(enrichment).toMatchObject({
      queryUsed: 'given-and-family-names:"J. Smith"',
      relaxedQuery: 'given-and-family-names:"J. Smith"',
      totalFound: 87,
    });
  });

  it('reports the other-names stage as the last query when nothing matches anywhere', async () => {
    route({
      'given-and-family-names:"Extremely Rare Name"': NONE,
      'other-names:"Extremely Rare Name"': NONE,
    });

    const result = await runToolContract(orcidResolveResearcher, { name: 'Extremely Rare Name' });
    const structured = result.structuredContent as {
      candidates: unknown[];
      queryUsed: string;
      relaxedQuery?: string;
      totalFound: number;
      primaryTotalFound: number;
      notice?: string;
    };

    expect(queriesSent()).toEqual([
      'given-and-family-names:"Extremely Rare Name"',
      'other-names:"Extremely Rare Name"',
    ]);
    expect(structured.candidates).toEqual([]);
    expect(structured).toMatchObject({
      queryUsed: 'other-names:"Extremely Rare Name"',
      relaxedQuery: 'other-names:"Extremely Rare Name"',
      totalFound: 0,
      primaryTotalFound: 0,
    });
    expect(structured.notice).toContain('Extremely Rare Name');
    expect(contentText(result)).toContain('No candidates found.');
  });
});

describe('orcidResolveResearcher — an initial in nameMatchType (#53)', () => {
  async function matchTypeFor(name: string, candidate: ExpandedSearchResult): Promise<string> {
    mockExpandedSearch.mockResolvedValueOnce(found(candidate));
    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const result = await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({ name }),
      ctx,
    );
    return result.candidates[0]!.nameMatchType;
  }

  it.each([
    // The first initial matches a first given name it starts with — at most partial.
    ['J. Doudna', researcher('0000-0001-0000-0001', 'Jennifer', 'Doudna'), 'partial'],
    ['J. Doudna', researcher('0000-0001-0000-0002', 'John Michael', 'Doudna'), 'partial'],
    ['j. doudna', researcher('0000-0001-0000-0003', 'Jennifer', 'Doudna'), 'partial'],
    ['J. A. Doudna', researcher('0000-0001-0000-0004', 'Jennifer', 'Doudna'), 'partial'],
    ['Doudna, J.', researcher('0000-0001-0000-0005', 'Jennifer', 'Doudna'), 'partial'],
    // Accent-insensitive on both sides.
    ['É. Durand', researcher('0000-0001-0000-0006', 'Etienne', 'Durand'), 'partial'],
    ['E. Durand', researcher('0000-0001-0000-0007', 'Étienne', 'Durand'), 'partial'],
    // A first initial is keyed to the first given name, never a middle initial.
    ['J. Smith', researcher('0000-0001-0000-0008', 'Carolyn J', 'Smith'), 'none'],
    ['J. Smith', researcher('0000-0001-0000-0009', 'Anna', 'Smith'), 'none'],
    // A record that stores the initial itself still matches exactly.
    ['J. Doudna', researcher('0000-0001-0000-0010', 'J', 'Doudna'), 'exact'],
    // The comma form compares as Given Family.
    ['Doudna, Jennifer', researcher('0000-0001-0000-0011', 'Jennifer', 'Doudna'), 'exact'],
    // A one-character CJK given name is a whole word, so it needs an exact token.
    ['山中 伸', researcher('0000-0001-0000-0012', '伸弥', '山中'), 'none'],
  ])('"%s" against %o is %s', async (name, candidate, expected) => {
    expect(await matchTypeFor(name, candidate)).toBe(expected);
  });

  it("matches the first initial against an other name's first word in the other-name tier", async () => {
    expect(
      await matchTypeFor(
        'J. Smith',
        researcher('0000-0001-0000-0013', 'Josiah', 'Carberry', { otherNames: ['Joe Smith'] }),
      ),
    ).toBe('other-name');
  });

  it('ranks the byline candidates after an exact match', async () => {
    mockExpandedSearch.mockResolvedValueOnce(
      found(johnDoudna, researcher('0000-0001-0000-0014', 'J', 'Doudna')),
    );
    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const result = await orcidResolveResearcher.handler(
      orcidResolveResearcher.input.parse({ name: 'J. Doudna' }),
      ctx,
    );

    expect(result.candidates.map((c) => [c.orcidId, c.nameMatchType])).toEqual([
      ['0000-0001-0000-0014', 'exact'],
      ['0000-0003-0697-2030', 'partial'],
    ]);
  });
});
