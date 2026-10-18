/**
 * @fileoverview Complete-surface pagination and bounded request contracts.
 * @module tests/tools/pagination-caps.tool.test
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetPeerReviews } from '@/mcp-server/tools/definitions/get-peer-reviews.tool.js';
import { orcidGetWorkDetail } from '@/mcp-server/tools/definitions/get-work-detail.tool.js';
import { orcidGetWorks } from '@/mcp-server/tools/definitions/get-works.tool.js';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';

const api = vi.hoisted(() => ({
  getPeerReviews: vi.fn(),
  getWorks: vi.fn(),
  getWorkDetails: vi.fn(),
  expandedSearch: vi.fn(),
}));
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => api,
  normalizeOrcidId: (id: string) => id,
}));
const ID = '0000-0002-1825-0097';
const text = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((b) => b.text ?? '').join('');
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
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
  it('pages peer histories through every slice within both complete surface budgets', async () => {
    const reviews = Array.from({ length: 1000 }, (_, i) => ({
      groupIssn: `ISSN-${i}`,
      conveningOrganization: { name: '山'.repeat(200) },
      sources: [{ name: 'Import service', selfAsserted: false }],
    }));
    api.getPeerReviews.mockResolvedValue(reviews);
    const seen: unknown[] = [];
    let maxJsonBytes = 0;
    let maxTextBytes = 0;
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
      expect(bytes(page)).toBeLessThanOrEqual(64000);
      expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(64000);
      maxJsonBytes = Math.max(maxJsonBytes, bytes(page));
      maxTextBytes = Math.max(maxTextBytes, Buffer.byteLength(text(result)));
      expect(page.totalCount).toBe(1000);
      expect(page.offset).toBe(offset);
      expect(page.reviewCount).toBe(page.peerReviews.length);
      expect(page.reviewCount).toBeGreaterThan(0);
      expect(page.notice).toContain('10000');
      expect(text(result)).toContain(page.notice!);
      seen.push(...page.peerReviews);
      offset = page.nextOffset;
      expect(page.truncated).toBe(offset !== undefined);
    }
    expect(seen).toEqual(reviews);
    console.info('peer max complete surface bytes', maxJsonBytes, maxTextBytes);
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
  it('defers absent upstream work results even without a byte cut', async () => {
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
  it('caps compact works and peer reviews at 1000 before byte admission', async () => {
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
      expect(bytes(page)).toBeLessThanOrEqual(64000);
      expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(64000);
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
  it('combines cap, byte, and missing-result deferrals in request order with widest metadata', async () => {
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
    const settled = new Set([...page.works, ...page.errors].map((r) => r.putCode));
    expect(page.deferredPutCodes).toEqual(requested.filter((code) => !settled.has(code)));
    expect(page.errors).toEqual([{ putCode: requested[0], message: 'Not found' }]);
    expect(page.notice).toContain('effective fetch cap 100');
    expect(page.notice).toContain('900 put-codes deferred by the input cap');
    expect(page.notice).toContain(`so ${99 - settled.size} put-codes were deferred`);
    expect(page.notice).toContain('no identified result for 1 requested put-codes');
    expect(text(result)).toContain(page.notice);
    expect(text(result)).toContain(page.deferredPutCodes.join(', '));
    expect(bytes(page)).toBeLessThanOrEqual(64000);
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(64000);
    expect(api.getWorkDetails).toHaveBeenCalledTimes(1);
    expect(api.getWorkDetails.mock.calls[0]?.[1]).toEqual(requested.slice(0, 100));
    console.info('widest detail bytes', bytes(page), Buffer.byteLength(text(result)));
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
  it('peer default page is 50 and one oversized review is returned alone with an exception', async () => {
    api.getPeerReviews.mockResolvedValue(Array.from({ length: 51 }, () => ({ sources: [] })));
    const first = await runToolContract(orcidGetPeerReviews, { orcid_id: ID });
    expect(first.structuredContent).toMatchObject({
      reviewCount: 50,
      totalCount: 51,
      nextOffset: 50,
      truncated: true,
    });
    api.getPeerReviews.mockResolvedValue([
      { groupIssn: 'x'.repeat(70000), sources: [] },
      { sources: [] },
    ]);
    const over = await runToolContract(orcidGetPeerReviews, { orcid_id: ID });
    expect(over.structuredContent).toMatchObject({ reviewCount: 1, nextOffset: 1 });
    expect((over.structuredContent as { notice: string }).notice).toContain('indivisible');
    expect(text(over)).toContain('indivisible');
    const last = await runToolContract(orcidGetPeerReviews, { orcid_id: ID, offset: 1 });
    expect(last.structuredContent).toMatchObject({ reviewCount: 1, truncated: false });
    expect(last.structuredContent).not.toHaveProperty('nextOffset');
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
    expect(page.rows).toBeLessThan(1000);
    expect(page.nextStart).toBe(9000 + page.rows);
    expect(page.truncated).toBe(true);
    expect(page.notice).toContain('effective cap 1000');
    expect(page.notice).toContain('offset 10,000');
    expect(text(result)).toContain(page.notice);
    expect(bytes(page)).toBeLessThanOrEqual(64000);
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(64000);
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
