/**
 * @fileoverview orcidResolveResearcher notices (#85): the cap, anchor-only, and ranking parts
 * compose into one `notice` in that order, through the production pipeline, so both
 * `structuredContent` and the `content[]` trailer carry it.
 * @module tests/tools/resolve-researcher-notices.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';
import type { ExpandedSearchResult } from '@/services/orcid/types.js';
import { expectLinearCpu } from '../helpers/cpu-growth.js';

const expandedSearch = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ expandedSearch }),
}));

beforeEach(() => {
  expandedSearch.mockReset();
  expandedSearch.mockRejectedValue(new Error('unmocked fetch'));
});

const PHRASE = 'given-and-family-names:"Jennifer Doudna"';
const OTHER_NAMES = 'other-names:"Jennifer Doudna"';
/** The `doi-self` regex clause for 10.1088/1361-648x/aab193, in any letter case (#84). */
const DOI_CLAUSE = String.raw`doi-self:/(([hH][tT][tT][pP][sS]?\:\/\/)?([dD][xX]\.)?[dD][oO][iI]\.[oO][rR][gG]\/|[dD][oO][iI]\:)?10\.1088\/1361\-648[xX]\/[aA][aA][bB]193/`;
/** The `doi-self` regex clause for 10.0000/wrong. */
const WRONG_DOI_CLAUSE = String.raw`doi-self:/(([hH][tT][tT][pP][sS]?\:\/\/)?([dD][xX]\.)?[dD][oO][iI]\.[oO][rR][gG]\/|[dD][oO][iI]\:)?10\.0000\/[wW][rR][oO][nN][gG]/`;
const PMID_CLAUSE = 'pmid-self:"22745249"';

/** `count` distinct records, every one named `given family`, in ORCID's relevance order. */
function records(count: number, given: string, family: string): ExpandedSearchResult[] {
  return Array.from({ length: count }, (_, i) => ({
    orcidId: `0000-0001-0000-${String(i).padStart(4, '0')}`,
    givenNames: given,
    familyNames: family,
    otherNames: [],
    emails: [],
    institutionNames: [],
  }));
}

/**
 * Answer each query with its matching records, `rows` of them from `start`, the way ORCID pages
 * a search; a query the test did not list fails loudly.
 */
function serve(matches: Record<string, ExpandedSearchResult[]>) {
  expandedSearch.mockImplementation(
    async ({ q, rows, start = 0 }: { q: string; rows: number; start?: number }) => {
      const found = matches[q];
      if (!found) throw new Error(`unmocked query: ${q}`);
      return { numFound: found.length, results: found.slice(start, start + rows) };
    },
  );
}

type Structured = {
  candidates: { orcidId: string }[];
  queryUsed: string;
  totalFound: number;
  notice?: string;
};

/** Run the resolver through the production pipeline; returns both surfaces. */
async function resolve(input: z.input<typeof orcidResolveResearcher.input>) {
  const result = await runToolContract(orcidResolveResearcher, input);
  expect(result.isError).not.toBe(true);
  const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  return { structured: result.structuredContent as Structured, text };
}

describe('orcidResolveResearcher — ranking notice (#85)', () => {
  it('names 5 of 18 and rows: 18 for Wei Wang at Tsinghua, with no paging step', async () => {
    serve({
      'given-and-family-names:"Wei Wang" AND affiliation-org-name:"Tsinghua University"': records(
        18,
        'Wei',
        'Wang',
      ),
    });

    const { structured, text } = await resolve({
      name: 'Wei Wang',
      affiliation: 'Tsinghua University',
    });

    expect(structured.candidates).toHaveLength(5);
    expect(structured.totalFound).toBe(18);
    expect(structured.notice).toBe(
      'The ranking covers 5 of 18 records matching queryUsed. Call again with rows: 18 to rank all of them.',
    );
    expect(text).toContain(`\n> ${structured.notice}`);
  });

  it('carries no ranking notice once rows covers every match (rows: 20, 18 returned)', async () => {
    serve({
      'given-and-family-names:"Wei Wang" AND affiliation-org-name:"Tsinghua University"': records(
        18,
        'Wei',
        'Wang',
      ),
    });

    const { structured, text } = await resolve({
      name: 'Wei Wang',
      affiliation: 'Tsinghua University',
      rows: 20,
    });

    expect(structured.candidates).toHaveLength(18);
    expect(structured).not.toHaveProperty('notice');
    expect(text).not.toContain('The ranking covers');
  });

  it.each([
    // Exactly as many matches as one stage can rank: rows reaches them all, so no paging step.
    [
      20,
      undefined,
      5,
      'The ranking covers 5 of 20 records matching queryUsed. Call again with rows: 20 to rank all of them.',
    ],
    [
      40,
      undefined,
      5,
      "The ranking covers 5 of 40 records matching queryUsed. Call again with rows: 20 to rank the first 20. To list the records not ranked here, call orcid_search_researchers with query set to queryUsed and start: 5; it returns them in ORCID's relevance order, without match signals.",
    ],
    [
      40,
      20,
      20,
      "The ranking covers 20 of 40 records matching queryUsed. To list the records not ranked here, call orcid_search_researchers with query set to queryUsed and start: 20; it returns them in ORCID's relevance order, without match signals.",
    ],
    [
      40,
      25,
      20,
      "Requested rows 25; using the maximum of 20 candidates per search stage. The ranking covers 20 of 40 records matching queryUsed. To list the records not ranked here, call orcid_search_researchers with query set to queryUsed and start: 20; it returns them in ORCID's relevance order, without match signals.",
    ],
  ])(
    'with %i matches and rows %s ranks %i and says how to reach the rest',
    async (matches, rows, ranked, notice) => {
      serve({ [PHRASE]: records(matches, 'Jennifer', 'Doudna') });

      const { structured, text } = await resolve({ name: 'Jennifer Doudna', rows });

      expect(structured.candidates).toHaveLength(ranked);
      expect(structured.totalFound).toBe(matches);
      expect(structured.notice).toBe(notice);
      // The notice is the trailer's one blockquote line, so this pins it whole in content[].
      expect(text.split('\n').filter((line) => line.startsWith('> '))).toEqual([`> ${notice}`]);
    },
  );

  it('formats a total above 999 with thousands separators', async () => {
    expandedSearch.mockResolvedValueOnce({
      numFound: 12_345,
      results: records(5, 'Jennifer', 'Doudna'),
    });

    const { structured } = await resolve({ name: 'Jennifer Doudna' });

    expect(structured.notice).toBe(
      "The ranking covers 5 of 12,345 records matching queryUsed. Call again with rows: 20 to rank the first 20. To list the records not ranked here, call orcid_search_researchers with query set to queryUsed and start: 5; it returns them in ORCID's relevance order, without match signals.",
    );
  });

  it('the paging step lists every record not ranked, none repeated', async () => {
    const all = records(40, 'Jennifer', 'Doudna');
    serve({ [PHRASE]: all });

    const { structured } = await resolve({ name: 'Jennifer Doudna' });
    // Page from the start the notice names, as a caller following it would.
    const step = /call orcid_search_researchers with query set to queryUsed and start: (\d+);/.exec(
      structured.notice ?? '',
    );
    assert(step, `no paging step in the notice: ${structured.notice}`);
    const page = await runToolContract(orcidSearchResearchers, {
      query: structured.queryUsed,
      start: Number(step[1]),
      rows: 1000,
    });
    const listed = (page.structuredContent as { results: { orcidId: string }[] }).results.map(
      (r) => r.orcidId,
    );
    const ranked = structured.candidates.map((c) => c.orcidId);

    expect(listed).toHaveLength(35);
    expect(listed.filter((id) => ranked.includes(id))).toEqual([]);
    expect([...ranked, ...listed].sort()).toEqual(all.map((r) => r.orcidId).sort());
  });

  it('adds nothing when totalFound equals the candidates returned', async () => {
    serve({ [PHRASE]: records(3, 'Jennifer', 'Doudna') });

    const { structured, text } = await resolve({ name: 'Jennifer Doudna' });

    expect(structured.candidates).toHaveLength(3);
    expect(structured).not.toHaveProperty('notice');
    expect(text).not.toContain('The ranking covers');
  });

  it('keeps the empty-result notice unchanged when no candidate is returned', async () => {
    // A count with no records is the zero-candidate branch, so no ranking part is added.
    expandedSearch.mockResolvedValue({ numFound: 4, results: [] });

    const { structured } = await resolve({ name: 'Jennifer Doudna' });

    expect(structured.candidates).toEqual([]);
    expect(structured.notice).toBe(
      'No ORCID records found matching "Jennifer Doudna". Try a different spelling or use orcid_search_researchers with a broader query.',
    );
  });
});

describe('orcidResolveResearcher — anchor-only notice (#85)', () => {
  it('names the DOI when the DOI-only stage answers', async () => {
    serve({
      [`${PHRASE} AND ${DOI_CLAUSE}`]: [],
      [`${OTHER_NAMES} AND ${DOI_CLAUSE}`]: [],
      [DOI_CLAUSE]: records(1, 'James', 'Beilsten-Edmands'),
    });

    const { structured, text } = await resolve({
      name: 'Jennifer Doudna',
      doi: '10.1088/1361-648x/aab193',
    });

    expect(structured.candidates).toHaveLength(1);
    expect(structured.notice).toBe(
      'No record matched "Jennifer Doudna" with DOI 10.1088/1361-648x/aab193; these candidates were found by the DOI alone.',
    );
    expect(text).toContain(`\n> ${structured.notice}`);
  });

  it('names the PMID when the PMID-only stage answers', async () => {
    serve({
      [`${PHRASE} AND ${PMID_CLAUSE}`]: [],
      [`${OTHER_NAMES} AND ${PMID_CLAUSE}`]: [],
      [PMID_CLAUSE]: records(2, 'Martin', 'Jinek'),
    });

    const { structured } = await resolve({ name: 'Jennifer Doudna', pmid: '22745249', rows: 2 });

    expect(structured.notice).toBe(
      'No record matched "Jennifer Doudna" with PMID 22745249; these candidates were found by the PMID alone.',
    );
  });

  it.each([
    [[], 'PMID'],
    [records(1, 'Martin', 'Jinek'), 'DOI'],
  ])('names both supplied anchors and the one that answered', async (doiOnly, answered) => {
    const anchors = `${WRONG_DOI_CLAUSE} AND ${PMID_CLAUSE}`;
    serve({
      [`${PHRASE} AND ${anchors}`]: [],
      [`${OTHER_NAMES} AND ${anchors}`]: [],
      [WRONG_DOI_CLAUSE]: doiOnly,
      [PMID_CLAUSE]: records(1, 'Martin', 'Jinek'),
    });

    const { structured } = await resolve({
      name: 'Jennifer Doudna',
      doi: 'https://doi.org/10.0000/wrong',
      pmid: 'PMID:22745249',
    });

    expect(structured.notice).toBe(
      `No record matched "Jennifer Doudna" with DOI 10.0000/wrong and PMID 22745249; these candidates were found by the ${answered} alone.`,
    );
  });

  it.each([
    ['the primary', { [`${PHRASE} AND ${DOI_CLAUSE}`]: records(1, 'Jennifer', 'Doudna') }],
    [
      'the other-names',
      {
        [`${PHRASE} AND ${DOI_CLAUSE}`]: [],
        [`${OTHER_NAMES} AND ${DOI_CLAUSE}`]: records(1, 'Jennifer', 'Doudna'),
      },
    ],
  ])('never carries it when %s stage answers', async (_, matches) => {
    serve(matches);

    const { structured } = await resolve({
      name: 'Jennifer Doudna',
      doi: '10.1088/1361-648x/aab193',
    });

    expect(structured.candidates).toHaveLength(1);
    expect(structured).not.toHaveProperty('notice');
  });

  it('joins the anchor-only and ranking parts', async () => {
    serve({
      [`${PHRASE} AND ${DOI_CLAUSE}`]: [],
      [`${OTHER_NAMES} AND ${DOI_CLAUSE}`]: [],
      [DOI_CLAUSE]: records(7, 'Martin', 'Jinek'),
    });

    const { structured } = await resolve({
      name: 'Jennifer Doudna',
      doi: '10.1088/1361-648x/aab193',
    });

    expect(structured.notice).toBe(
      'No record matched "Jennifer Doudna" with DOI 10.1088/1361-648x/aab193; these candidates were found by the DOI alone. The ranking covers 5 of 7 records matching queryUsed. Call again with rows: 7 to rank all of them.',
    );
  });

  it('joins the cap, anchor-only, and ranking parts in that order', async () => {
    serve({
      [`${PHRASE} AND ${DOI_CLAUSE}`]: [],
      [`${OTHER_NAMES} AND ${DOI_CLAUSE}`]: [],
      [DOI_CLAUSE]: records(40, 'Martin', 'Jinek'),
    });

    const { structured, text } = await resolve({
      name: 'Jennifer Doudna',
      doi: '10.1088/1361-648x/aab193',
      rows: 25,
    });

    expect(structured.notice).toBe(
      'Requested rows 25; using the maximum of 20 candidates per search stage. No record matched "Jennifer Doudna" with DOI 10.1088/1361-648x/aab193; these candidates were found by the DOI alone. The ranking covers 20 of 40 records matching queryUsed. To list the records not ranked here, call orcid_search_researchers with query set to queryUsed and start: 20; it returns them in ORCID\'s relevance order, without match signals.',
    );
    expect(text).toContain(`\n> ${structured.notice}`);
  });
});

describe('orcidResolveResearcher — the notice is escaped only where it renders', () => {
  /** The last `content[]` block — the enrichment trailer — from the notice to its end. */
  function renderedNotice(result: Awaited<ReturnType<typeof runToolContract>>): string {
    const last = result.content.at(-1);
    const trailer = last?.type === 'text' ? last.text : '';
    return trailer.slice(trailer.indexOf('\n> No ') + 1);
  }

  it('carries a hostile name raw in structuredContent and inert in content[]', async () => {
    expandedSearch.mockResolvedValue({ numFound: 0, results: [] });
    const name = '*Jen* [x](https://e.x) <b> &amp;\r\n# Forged';

    const result = await runToolContract(orcidResolveResearcher, { name });

    expect((result.structuredContent as { notice: string }).notice).toBe(
      `No ORCID records found matching "${name}". Try a different spelling or use orcid_search_researchers with a broader query.`,
    );
    expect(renderedNotice(result)).toBe(
      '> No ORCID records found matching "\\*Jen\\* \\[x\\](https://e.x) \\<b> \\&amp;\\\n> \\# Forged". Try a different spelling or use orcid_search_researchers with a broader query.',
    );
  });

  it('carries the name and anchor raw in the anchor-only notice and inert in content[]', async () => {
    expandedSearch
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 0, results: [] })
      .mockResolvedValueOnce({ numFound: 1, results: records(1, 'Martin', 'Jinek') });

    const result = await runToolContract(orcidResolveResearcher, {
      name: 'Jennifer *Doudna*',
      doi: '10.1/<b>_x_',
    });

    expect((result.structuredContent as { notice: string }).notice).toBe(
      'No record matched "Jennifer *Doudna*" with DOI 10.1/<b>_x_; these candidates were found by the DOI alone.',
    );
    expect(renderedNotice(result)).toBe(
      '> No record matched "Jennifer \\*Doudna\\*" with DOI 10.1/\\<b>\\_x\\_; these candidates were found by the DOI alone.',
    );
  });

  const render = (notice: string) =>
    orcidResolveResearcher.enrichmentTrailer!.notice!.render!(notice);

  it.each([
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
    ['repeated openers with no closer', (n: number) => '*[<a&#'.repeat(n / 6)],
    ['nested openers', (n: number) => '<a'.repeat(n / 2)],
  ])('renders a notice in linear CPU time on %s', { timeout: 0 }, (_label, build) => {
    expectLinearCpu(render, build, { microsPerChar: 1 });
  });
});
