/**
 * @fileoverview Complete-surface pagination and bounded request contracts.
 * @module tests/tools/pagination-caps.tool.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetPeerReviews } from '@/mcp-server/tools/definitions/get-peer-reviews.tool.js';
import { orcidGetWorkDetail } from '@/mcp-server/tools/definitions/get-work-detail.tool.js';
import { orcidGetWorks } from '@/mcp-server/tools/definitions/get-works.tool.js';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';

const api = vi.hoisted(() => ({
  getPeerReviews: vi.fn(),
  getWorks: vi.fn(),
  getWorkDetails: vi.fn(),
  expandedSearch: vi.fn(),
}));
vi.mock('@/services/orcid/orcid-service.js', async () => {
  const { served } = await import('../helpers/served-record.js');
  const normalizeOrcidId = (id: string) => id;
  return {
    getOrcidService: () => ({
      expandedSearch: api.expandedSearch,
      getPeerReviews: served(api.getPeerReviews, normalizeOrcidId),
      getWorks: served(api.getWorks, normalizeOrcidId),
      getWorkDetails: served(api.getWorkDetails, normalizeOrcidId),
      // The zero-resolved-works deprecation probe; a served iD never differs here.
      getPerson: served(async () => ({}), normalizeOrcidId),
    }),
    normalizeOrcidId,
  };
});
const ID = '0000-0002-1825-0097';
const text = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((b) => b.text ?? '').join('');
const work = (putCode: number) => ({ putCode, externalIds: [], contributors: [], sources: [] });

describe('pagination caps', () => {
  beforeEach(() => vi.resetAllMocks());
  it('characterizes upstream review order, ISSN headings, and provenance on both surfaces', async () => {
    const reviews = [2, 1].map((i) => ({
      groupIssn: `ISSN-${i}`,
      sources: [{ name: `Source ${i}`, selfAsserted: false }],
    }));
    api.getPeerReviews.mockResolvedValue(reviews);
    const result = await runToolContract(orcidGetPeerReviews, { orcid_id: ID });
    expect(result.structuredContent).toMatchObject({ reviewCount: 2, peerReviews: reviews });
    expect(text(result)).toContain('### Journal ISSN ISSN-2\n**Sources:** Source 2');
    expect(text(result).indexOf('ISSN-2')).toBeLessThan(text(result).indexOf('ISSN-1'));
  });
  it('pages a clamped peer history in full 1,000-review pages through every slice', async () => {
    const reviews = Array.from({ length: 2500 }, (_, i) => ({
      groupIssn: `ISSN-${i}`,
      conveningOrganization: { name: '山'.repeat(200) },
      sources: [{ name: 'Import service', selfAsserted: false }],
    }));
    api.getPeerReviews.mockResolvedValue(reviews);
    const seen: unknown[] = [];
    const sizes: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const result = await runToolContract(orcidGetPeerReviews, {
        orcid_id: ID,
        limit: 10000,
        offset,
      });
      expect(result.isError).toBeFalsy();
      const page = result.structuredContent as {
        peerReviews: unknown[];
        reviewCount: number;
        totalCount: number;
        offset: number;
        nextOffset?: number;
        truncated: boolean;
        notice?: string;
      };
      expect(page.totalCount).toBe(2500);
      expect(page.offset).toBe(offset);
      expect(page.reviewCount).toBe(page.peerReviews.length);
      expect(page.notice).toBe('Requested limit 10000; effective cap 1000 reviews.');
      expect(text(result)).toContain(page.notice!);
      sizes.push(page.reviewCount);
      seen.push(...page.peerReviews);
      offset = page.nextOffset;
      expect(page.truncated).toBe(offset !== undefined);
    }
    expect(sizes).toEqual([1000, 1000, 500]);
    expect(seen).toEqual(reviews);
  });
  it.each([1001, 10000])(
    'clamps supported search and works sizes %i before I/O and reports the cap',
    async (size) => {
      api.expandedSearch.mockResolvedValue({ numFound: 2, results: [] });
      api.getWorks.mockResolvedValue([]);
      const search = await runToolContract(orcidSearchResearchers, {
        family_name: 'Smith',
        rows: size,
      });
      const works = await runToolContract(orcidGetWorks, { orcid_id: ID, limit: size });
      for (const result of [search, works]) {
        expect(result.isError).toBeFalsy();
        expect((result.structuredContent as { notice: string }).notice).toContain(`${size}`);
        expect(text(result)).toContain('1000');
      }
      expect(api.expandedSearch.mock.calls[0]?.[0]).toMatchObject({ rows: 1000 });
      expect(search.structuredContent).toMatchObject({ truncated: false });
    },
  );
  it('defers absent upstream work results', async () => {
    api.getWorkDetails.mockResolvedValue([
      { type: 'work', detail: work(2) },
      { type: 'error', putCode: 1, message: 'Not found' },
    ]);
    const result = await runToolContract(orcidGetWorkDetail, {
      orcid_id: ID,
      put_codes: [1, 3, 2, 3],
    });
    expect(result.structuredContent).toMatchObject({ deferredPutCodes: [3] });
    expect(text(result)).toContain('**Deferred put-codes:** 3');
  });
  it('caps compact works and peer reviews at 1000', async () => {
    api.getWorks.mockResolvedValue(
      Array.from({ length: 1001 }, (_, putCode) => ({ putCode, sources: [], externalIds: [] })),
    );
    api.getPeerReviews.mockResolvedValue(Array.from({ length: 1001 }, () => ({ sources: [] })));
    for (const tool of [orcidGetWorks, orcidGetPeerReviews]) {
      const result = await runToolContract(tool, { orcid_id: ID, limit: 10000 });
      expect(result.isError).toBeFalsy();
      const page = result.structuredContent as {
        nextOffset: number;
        truncated: boolean;
        returnedCount?: number;
        reviewCount?: number;
      };
      expect(page.returnedCount ?? page.reviewCount).toBe(1000);
      expect(page.nextOffset).toBe(1000);
      expect(page.truncated).toBe(true);
    }
  });
  it('deduplicates before the distinct cap and fetches once', async () => {
    api.getWorkDetails.mockImplementation(async (_id: string, codes: number[]) =>
      codes.map((putCode) => ({ type: 'work', detail: work(putCode) })),
    );
    const result = await runToolContract(orcidGetWorkDetail, {
      orcid_id: ID,
      put_codes: Array.from({ length: 1000 }, (_, i) => (i % 100) + 1),
    });
    expect(result.isError).toBeFalsy();
    expect(api.getWorkDetails).toHaveBeenCalledTimes(1);
    expect(api.getWorkDetails.mock.calls[0]?.[1]).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
    expect(result.structuredContent).not.toHaveProperty('deferredPutCodes');
  });
  it('combines cap and missing-result deferrals in request order and returns every fetched record', async () => {
    const requested = Array.from({ length: 1000 }, (_, i) => Number.MAX_SAFE_INTEGER - i);
    api.getWorkDetails.mockImplementation(async (_id: string, codes: number[]) => [
      { type: 'work', detail: { ...work(codes[2]!), abstract: '山'.repeat(5000) } },
      { type: 'error', putCode: codes[0], message: 'Not found' },
      ...codes
        .slice(3)
        .toReversed()
        .map((putCode) => ({
          type: 'work',
          detail: { ...work(putCode), abstract: 'é'.repeat(5000) },
        })),
    ]);
    const result = await runToolContract(orcidGetWorkDetail, {
      orcid_id: ID,
      put_codes: requested,
    });
    expect(result.isError).toBeFalsy();
    const page = result.structuredContent as {
      works: { putCode: number }[];
      errors: { putCode?: number }[];
      deferredPutCodes: number[];
      notice: string;
    };
    // Every work the endpoint returned is kept, in its order; only codes[1] went unanswered.
    expect(page.works.map((w) => w.putCode)).toEqual([
      requested[2],
      ...requested.slice(3, 100).toReversed(),
    ]);
    expect(page.errors).toEqual([{ putCode: requested[0], message: 'Not found' }]);
    expect(page.deferredPutCodes).toEqual([requested[1], ...requested.slice(100)]);
    expect(page.notice).toBe(
      'Requested 1000 raw put-codes (1000 distinct); effective fetch cap 100 distinct put-codes in one request; 900 put-codes deferred by the input cap. ORCID returned no identified result for 1 requested put-codes; they remain deferred. Call orcid_get_work_detail again with deferredPutCodes as put_codes.',
    );
    expect(text(result)).toContain(page.notice);
    expect(text(result)).toContain(page.deferredPutCodes.join(', '));
    expect(api.getWorkDetails).toHaveBeenCalledTimes(1);
    expect(api.getWorkDetails.mock.calls[0]?.[1]).toEqual(requested.slice(0, 100));
  });
  it.each([{ reviews: [] }, { reviews: [{ sources: [] }] }])(
    'peer empty/past-end pages retain total and have no continuation',
    async ({ reviews }) => {
      api.getPeerReviews.mockResolvedValue(reviews);
      const result = await runToolContract(orcidGetPeerReviews, {
        orcid_id: ID,
        offset: 5000,
        limit: 1001,
      });
      expect(result.structuredContent).toMatchObject({
        reviewCount: 0,
        totalCount: reviews.length,
        offset: 5000,
        truncated: false,
        peerReviews: [],
      });
      expect(result.structuredContent).not.toHaveProperty('nextOffset');
      expect(text(result)).toContain('**Returned:** 0 (offset 5000)');
    },
  );
  it('peer default page is 25 and an oversized review shares its page', async () => {
    api.getPeerReviews.mockResolvedValue(Array.from({ length: 51 }, () => ({ sources: [] })));
    const first = await runToolContract(orcidGetPeerReviews, { orcid_id: ID });
    expect(first.structuredContent).toMatchObject({
      reviewCount: 25,
      totalCount: 51,
      nextOffset: 25,
      truncated: true,
    });
    api.getPeerReviews.mockResolvedValue([
      { groupIssn: 'x'.repeat(70000), sources: [] },
      { sources: [] },
    ]);
    const over = await runToolContract(orcidGetPeerReviews, { orcid_id: ID });
    expect(over.structuredContent).toMatchObject({ reviewCount: 2, truncated: false });
    expect(over.structuredContent).not.toHaveProperty('nextOffset');
    expect(over.structuredContent).not.toHaveProperty('notice');
  });
  it.each([0, -1, 1.5, 10001])(
    'rejects invalid page size %s without upstream I/O',
    async (size) => {
      for (const [tool, input] of [
        [orcidGetPeerReviews, { orcid_id: ID, limit: size }],
        [orcidGetWorks, { orcid_id: ID, limit: size }],
        [orcidSearchResearchers, { family_name: 'Smith', rows: size }],
      ] as const) {
        const result = await runToolContract(tool, input);
        expect(result.isError).toBe(true);
        expect(text(result)).not.toBe('');
      }
      expect(Object.values(api).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    },
  );
  it.each([
    { put_codes: [] },
    { put_codes: [0] },
    { put_codes: [-1] },
    { put_codes: [1.5] },
    { put_codes: Array.from({ length: 1001 }, () => 1) },
  ])('rejects invalid raw work batches before I/O', async ({ put_codes }) => {
    const result = await runToolContract(orcidGetWorkDetail, { orcid_id: ID, put_codes });
    expect(result.isError).toBe(true);
    expect(api.getWorkDetails).not.toHaveBeenCalled();
  });
  it('clamped search keeps actual-returned continuation and retrieval-boundary semantics', async () => {
    const results = Array.from({ length: 1000 }, (_, i) => ({
      orcidId: `${ID}-${i}`,
      otherNames: ['山'.repeat(200)],
      institutionNames: [],
    }));
    api.expandedSearch.mockResolvedValue({ numFound: 10001, results });
    const result = await runToolContract(orcidSearchResearchers, {
      family_name: 'Smith',
      rows: 10000,
      start: 9000,
    });
    const page = result.structuredContent as {
      rows: number;
      nextStart: number;
      truncated: boolean;
      notice: string;
    };
    expect(page.rows).toBe(1000);
    expect(page.nextStart).toBe(10000);
    expect(page.truncated).toBe(true);
    expect(page.notice).toContain('Requested rows 10000; effective cap 1000 results.');
    expect(page.notice).toContain('offset 10,000');
    expect(text(result)).toContain(page.notice);
  });
  it('advertises one default and one cap per count input, the 10,000 ceilings, and no byte budget', () => {
    const counts = [
      [
        orcidSearchResearchers,
        'rows',
        20,
        'Results per page. Default 20; a larger value returns at most 1,000 (the most ORCID serves per request) and says so.',
      ],
      [
        orcidResolveResearcher,
        'rows',
        5,
        'Candidates to return. Default 5; a larger value returns at most 20 per search stage and says so.',
      ],
      [
        orcidGetWorks,
        'limit',
        25,
        'Works per page. Default 25; a larger value returns at most 1,000 and says so.',
      ],
      [
        orcidGetPeerReviews,
        'limit',
        25,
        'Reviews per page. Default 25; a larger value returns at most 1,000 and says so.',
      ],
    ] as const;
    for (const [definition, key, defaultValue, description] of counts) {
      const input = z.toJSONSchema(definition.input, { io: 'input' }) as {
        properties: Record<string, { default?: number; maximum?: number; description?: string }>;
      };
      expect(input.properties[key]).toMatchObject({
        default: defaultValue,
        maximum: 10000,
        description,
      });
      const advertised = JSON.stringify([
        definition.description,
        input,
        z.toJSONSchema(definition.output),
        definition.enrichment && z.toJSONSchema(z.object(definition.enrichment)),
      ]);
      expect(advertised, definition.name).not.toMatch(/budget|\bbytes?\b|64,000/i);
    }
  });
  it('bounds fastest-path scan CPU for empty peer histories and missing detail responses', async () => {
    api.getPeerReviews.mockResolvedValue([]);
    api.getWorkDetails.mockResolvedValue([]);
    const peerInput = orcidGetPeerReviews.input.parse({ orcid_id: ID });
    const samples: Record<string, number> = {};
    for (const count of [1, 1000]) {
      const input = orcidGetWorkDetail.input.parse({
        orcid_id: ID,
        put_codes: Array.from({ length: count }, (_, i) => i + 1),
      });
      const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
      for (let i = 0; i < 10; i++) await orcidGetWorkDetail.handler(input, ctx);
      const start = process.threadCpuUsage();
      for (let i = 0; i < 200; i++) await orcidGetWorkDetail.handler(input, ctx);
      const elapsed = process.threadCpuUsage(start);
      samples[`detail${count}UsPerCall`] = (elapsed.user + elapsed.system) / 200;
      expect(elapsed.user + elapsed.system).toBeLessThan(500_000);
    }
    const ctx = createMockContext({ errors: orcidGetPeerReviews.errors });
    const start = process.threadCpuUsage();
    for (let i = 0; i < 200; i++) await orcidGetPeerReviews.handler(peerInput, ctx);
    const elapsed = process.threadCpuUsage(start);
    samples.emptyPeerUsPerCall = (elapsed.user + elapsed.system) / 200;
    expect(elapsed.user + elapsed.system).toBeLessThan(500_000);
    console.info('fastest-path scan CPU', samples);
  });
});
