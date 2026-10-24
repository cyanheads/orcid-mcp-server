/**
 * @fileoverview Resolver candidate read bounds and fallback request contracts.
 * @module tests/tools/resolve-researcher-caps.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';

const expandedSearch = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ expandedSearch }),
}));

const candidate = {
  orcidId: '0000-0001-9522-8779',
  givenNames: 'Jennifer',
  familyNames: 'Doudna',
  otherNames: [],
  emails: [],
  institutionNames: [],
};

beforeEach(() => {
  expandedSearch.mockReset();
  expandedSearch.mockRejectedValue(new Error('Unrouted search'));
});

describe('resolver candidate bounds', () => {
  it('bounds every fallback, preserving query order and PMID recovery', async () => {
    expandedSearch.mockResolvedValue({ numFound: 0, results: [] });
    for (let i = 0; i < 6; i++) {
      expandedSearch.mockResolvedValueOnce({ numFound: 0, results: [] });
    }
    expandedSearch.mockResolvedValueOnce({ numFound: 42, results: [candidate] });
    const result = await runToolContract(orcidResolveResearcher, {
      name: 'J. Doudna',
      affiliation: 'Berkeley',
      doi: '10.0000/wrong',
      pmid: '22745249',
      rows: 10000,
    });
    expect(result.isError).not.toBe(true);
    const anchors = 'doi-self:"10.0000\\/wrong" AND pmid-self:"22745249"';
    const phrase = 'given-and-family-names:"J. Doudna"';
    const byline = 'given-and-family-names:("Doudna" AND J*)';
    expect(expandedSearch.mock.calls.map(([request]) => request)).toEqual([
      { q: `${phrase} AND ${anchors} AND affiliation-org-name:"Berkeley"`, rows: 20 },
      { q: `${byline} AND ${anchors} AND affiliation-org-name:"Berkeley"`, rows: 20 },
      { q: `${phrase} AND ${anchors}`, rows: 20 },
      { q: `${byline} AND ${anchors}`, rows: 20 },
      { q: `other-names:"J. Doudna" AND ${anchors}`, rows: 20 },
      { q: 'doi-self:"10.0000\\/wrong"', rows: 20 },
      { q: 'pmid-self:"22745249"', rows: 20 },
    ]);
    expect(result.structuredContent).toMatchObject({
      candidates: [{ anchorType: 'pmid', nameMatchType: 'partial' }],
      queryUsed: 'pmid-self:"22745249"',
      relaxedQuery: 'pmid-self:"22745249"',
      totalFound: 42,
      primaryTotalFound: 0,
      primaryQuery: `${phrase} AND ${anchors} AND affiliation-org-name:"Berkeley"`,
    });
    expect(JSON.stringify(result.content)).toContain('pmid');
    expect(JSON.stringify(result.content)).toContain('42');
  });

  it.each([{}, { doi: '10.0000/wrong' }, { pmid: '22745249' }])(
    'composes cap disclosure with empty and anchor guidance %j',
    async (anchor) => {
      expandedSearch.mockResolvedValue({ numFound: 0, results: [] });
      const result = await runToolContract(orcidResolveResearcher, {
        name: 'Jennifer Doudna',
        rows: 21,
        ...anchor,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ candidates: [], totalFound: 0 });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain('Requested rows 21');
      expect(notice).toContain('maximum of 20');
      expect(notice).toContain('No ORCID records found');
      expect(notice).toContain('orcid_search_researchers');
      if ('doi' in anchor) expect(notice).toContain('Verify the DOI');
      if ('pmid' in anchor) expect(notice).toContain('Verify the PMID');
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(notice);
      expect(expandedSearch).toHaveBeenCalled();
      expect(expandedSearch.mock.calls.every(([request]) => request.rows === 20)).toBe(true);
    },
  );

  it.each([10001, 0, -1, 1.5])('rejects rows %s before upstream I/O', async (rows) => {
    const result = await runToolContract(orcidResolveResearcher, { name: 'Jennifer Doudna', rows });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      },
    });
    expect(JSON.stringify(result.content)).toContain('rows');
    expect(expandedSearch).not.toHaveBeenCalled();
  });

  it.each([21, 10000])('caps requested rows %s and discloses both sizes', async (rows) => {
    expandedSearch.mockResolvedValueOnce({
      numFound: 37,
      results: Array.from({ length: 20 }, () => candidate),
    });
    const result = await runToolContract(orcidResolveResearcher, { name: 'Jennifer Doudna', rows });
    expect(result.isError).not.toBe(true);
    expect(expandedSearch.mock.calls[0]![0].rows).toBe(20);
    expect(result.structuredContent).toMatchObject({
      totalFound: 37,
      primaryTotalFound: 37,
      notice: `Requested rows ${rows}; using the maximum of 20 candidates per search stage.`,
    });
    expect((result.structuredContent as { candidates: unknown[] }).candidates).toHaveLength(20);
    expect(JSON.stringify(result.content)).toContain(`Requested rows ${rows}`);
    expect(JSON.stringify(result.content)).toContain('maximum of 20');
    expect(JSON.stringify(result.content)).toContain('0000-0001-9522-8779');
  });

  it.each([undefined, 1, 5, 20])('preserves request size %s and effective totals', async (rows) => {
    expandedSearch.mockResolvedValueOnce({ numFound: 37, results: [candidate] });
    const result = await runToolContract(orcidResolveResearcher, { name: 'Jennifer Doudna', rows });
    expect(result.isError).not.toBe(true);
    expect(expandedSearch.mock.calls[0]![0]).toEqual({
      q: 'given-and-family-names:"Jennifer Doudna"',
      rows: rows ?? 5,
    });
    expect(result.structuredContent).toMatchObject({ totalFound: 37, primaryTotalFound: 37 });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(JSON.stringify(result.content)).toContain('0000-0001-9522-8779');
  });
});
