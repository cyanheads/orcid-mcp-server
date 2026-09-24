/**
 * @fileoverview Tests for orcidGetWorks tool.
 * @module tests/tools/get-works.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetWorks } from '@/mcp-server/tools/definitions/get-works.tool.js';

const mockGetWorks = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ getWorks: mockGetWorks }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

const sampleWorks = [
  {
    title: 'CRISPR-Cas9 Mechanism',
    workType: 'journal-article',
    publicationDate: '2012-08',
    journalTitle: 'Science',
    url: 'https://doi.org/10.1126/science.1225829',
    externalIds: [{ type: 'doi', value: '10.1126/science.1225829' }],
  },
  {
    title: 'RNA Structure',
    workType: 'journal-article',
    publicationDate: '2014',
    journalTitle: 'Nature',
    externalIds: [
      { type: 'doi', value: '10.1038/nature12345' },
      { type: 'pmid', value: '24567890' },
    ],
  },
];

/** Prolific record fixture (0000-0001-9161-999X returns 500+ works in production). */
const prolificWorks = Array.from({ length: 60 }, (_, i) => ({
  putCode: 1000 + i,
  title: `Work ${i}`,
  workType: 'journal-article',
  publicationDate: '2020',
  externalIds: [{ type: 'doi', value: `10.1/${i}` }],
}));

describe('orcidGetWorks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns works list with counts, offset, and truncation flags', async () => {
    mockGetWorks.mockResolvedValueOnce(sampleWorks);

    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetWorks.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0002-1825-0097');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0002-1825-0097');
    expect(result.workCount).toBe(2);
    expect(result.returnedCount).toBe(2);
    expect(result.offset).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.nextOffset).toBeUndefined();
    expect(result.works).toHaveLength(2);
    expect(result.works[0]!.title).toBe('CRISPR-Cas9 Mechanism');
    expect(result.works[0]!.externalIds?.[0]?.type).toBe('doi');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('strips ORCID URI prefix', async () => {
    mockGetWorks.mockResolvedValueOnce(sampleWorks);

    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    const input = orcidGetWorks.input.parse({
      orcid_id: 'https://orcid.org/0000-0002-1825-0097',
    });
    const result = await orcidGetWorks.handler(input, ctx);
    expect(result.orcidId).toBe('0000-0002-1825-0097');
  });

  it('slices a prolific record to the default limit and reports truncation', async () => {
    mockGetWorks.mockResolvedValueOnce(prolificWorks);

    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    // 0000-0001-9161-999X is the real prolific record (500+ works in production).
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0001-9161-999X' });
    const result = await orcidGetWorks.handler(input, ctx);

    expect(result.workCount).toBe(60);
    expect(result.returnedCount).toBe(50); // default limit
    expect(result.offset).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(50);
    expect(result.works).toHaveLength(50);
    expect(result.works[0]!.title).toBe('Work 0');
    expect(result.works[49]!.title).toBe('Work 49');
  });

  it('pages the tail with offset and clears truncation on the final page', async () => {
    mockGetWorks.mockResolvedValueOnce(prolificWorks);

    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0001-9161-999X', offset: 50 });
    const result = await orcidGetWorks.handler(input, ctx);

    expect(result.workCount).toBe(60);
    expect(result.returnedCount).toBe(10);
    expect(result.offset).toBe(50);
    expect(result.truncated).toBe(false);
    expect(result.nextOffset).toBeUndefined();
    expect(result.works[0]!.title).toBe('Work 50');
  });

  it('respects an explicit limit smaller than the record', async () => {
    mockGetWorks.mockResolvedValueOnce(sampleWorks);

    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0002-1825-0097', limit: 1 });
    const result = await orcidGetWorks.handler(input, ctx);

    expect(result.workCount).toBe(2);
    expect(result.returnedCount).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(1);
    expect(result.works).toHaveLength(1);
  });

  it('includes external identifiers by default', async () => {
    mockGetWorks.mockResolvedValueOnce(sampleWorks);

    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetWorks.handler(input, ctx);

    expect(result.works[0]!.externalIds).toEqual([
      { type: 'doi', value: '10.1126/science.1225829' },
    ]);
  });

  it('omits external identifiers when include_external_ids is false', async () => {
    mockGetWorks.mockResolvedValueOnce(sampleWorks);

    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    const input = orcidGetWorks.input.parse({
      orcid_id: '0000-0002-1825-0097',
      include_external_ids: false,
    });
    const result = await orcidGetWorks.handler(input, ctx);

    expect(result.works[0]!.externalIds).toBeUndefined();
    expect(result.works[0]!.title).toBe('CRISPR-Cas9 Mechanism');
  });

  it('adds notice enrichment when works list is empty', async () => {
    mockGetWorks.mockResolvedValueOnce([]);

    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetWorks.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.workCount).toBe(0);
    expect(result.returnedCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.works).toEqual([]);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No works found');
  });

  it('handles a sparse work entry (no title, no date)', async () => {
    mockGetWorks.mockResolvedValueOnce([{ externalIds: [] }]);

    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetWorks.handler(input, ctx);

    expect(result.workCount).toBe(1);
    expect(result.works[0]!.title).toBeUndefined();
    expect(result.works[0]!.externalIds).toEqual([]);
  });

  it('propagates non-404 service errors', async () => {
    mockGetWorks.mockRejectedValueOnce(new Error('Upstream timeout'));

    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0002-1825-0097' });
    await expect(orcidGetWorks.handler(input, ctx)).rejects.toThrow('Upstream timeout');
  });

  it('rejects malformed ORCID iD at input validation', () => {
    expect(() => orcidGetWorks.input.parse({ orcid_id: 'not-a-valid-orcid' })).toThrow();
    expect(() => orcidGetWorks.input.parse({ orcid_id: '' })).toThrow();
  });

  it('rejects a checksum-invalid ORCID iD before any upstream request', () => {
    // Well-shaped but the ISO 7064 check digit is wrong (correct digit is 1).
    expect(() => orcidGetWorks.input.parse({ orcid_id: '0000-0000-0000-0000' })).toThrow();
    expect(mockGetWorks).not.toHaveBeenCalled();
  });

  it('accepts bare and URI forms of a valid ORCID iD', () => {
    expect(() => orcidGetWorks.input.parse({ orcid_id: '0000-0002-1825-0097' })).not.toThrow();
    expect(() =>
      orcidGetWorks.input.parse({ orcid_id: 'https://orcid.org/0000-0002-1825-0097' }),
    ).not.toThrow();
  });

  it('throws profile_not_found McpError on 404', async () => {
    mockGetWorks.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.'),
    );

    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    // Checksum-valid but unregistered iD — passes local validation, 404s upstream.
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0000-0000-0001' });
    const error = await Promise.resolve(orcidGetWorks.handler(input, ctx)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    const data = (error as McpError).data as { reason?: string; recovery?: { hint?: string } };
    expect(data.reason).toBe('profile_not_found');
    expect(data.recovery?.hint).toBeDefined();
  });

  it('formats works with counts, truncation, and external IDs', () => {
    const output = orcidGetWorks.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      workCount: 60,
      returnedCount: 2,
      offset: 0,
      nextOffset: 2,
      truncated: true,
      works: sampleWorks,
    });

    const blocks = orcidGetWorks.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0002-1825-0097');
    expect(text).toContain('https://orcid.org/0000-0002-1825-0097');
    expect(text).toContain('CRISPR-Cas9 Mechanism');
    expect(text).toContain('journal-article');
    expect(text).toContain('doi:10.1126/science.1225829');
    expect(text).toContain('**Total Works:** 60');
    expect(text).toContain('**Returned:** 2 (offset 0)');
    expect(text).toContain('**Truncated:** Yes');
    expect(text).toContain('**Next Offset:** 2');
  });

  it('formats empty works list', () => {
    const output = orcidGetWorks.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      workCount: 0,
      returnedCount: 0,
      offset: 0,
      truncated: false,
      works: [],
    });

    const blocks = orcidGetWorks.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Total Works:** 0');
    expect(text).toContain('**Truncated:** No');
  });

  describe('responses under the byte budget are unchanged', () => {
    const textOf = (result: { content: { type: string; text?: string }[] }) =>
      result.content.map((block) => block.text ?? '').join('');

    it('returns a small page byte-identical on both surfaces', async () => {
      mockGetWorks.mockResolvedValueOnce(sampleWorks);

      const result = await runToolContract(orcidGetWorks, { orcid_id: '0000-0002-1825-0097' });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toStrictEqual({
        orcidId: '0000-0002-1825-0097',
        orcidUri: 'https://orcid.org/0000-0002-1825-0097',
        workCount: 2,
        returnedCount: 2,
        offset: 0,
        truncated: false,
        works: sampleWorks,
      });
      expect(textOf(result)).toMatchInlineSnapshot(`
        "## Works for ORCID 0000-0002-1825-0097
        **URI:** https://orcid.org/0000-0002-1825-0097
        **Total Works:** 2
        **Returned:** 2 (offset 0)
        **Truncated:** No

        ### CRISPR-Cas9 Mechanism
        **Type:** journal-article
        **Date:** 2012-08
        **Journal:** Science
        **URL:** https://doi.org/10.1126/science.1225829
        **IDs:** doi:10.1126/science.1225829

        ### RNA Structure
        **Type:** journal-article
        **Date:** 2014
        **Journal:** Nature
        **IDs:** doi:10.1038/nature12345, pmid:24567890
        "
      `);
    });

    it('keeps the default page of a prolific record, its counts, and its continuation', async () => {
      mockGetWorks.mockResolvedValueOnce(prolificWorks);

      const result = await runToolContract(orcidGetWorks, {
        orcid_id: '0000-0001-9161-999X',
        include_external_ids: false,
      });
      const structured = result.structuredContent as {
        returnedCount: number;
        nextOffset?: number;
        truncated: boolean;
        works: { externalIds?: unknown }[];
      };

      expect(structured.returnedCount).toBe(50);
      expect(structured.nextOffset).toBe(50);
      expect(structured.truncated).toBe(true);
      expect(structured.works.every((w) => w.externalIds === undefined)).toBe(true);
      expect(JSON.stringify(result.structuredContent).length).toMatchInlineSnapshot(`4612`);
      expect(textOf(result).length).toMatchInlineSnapshot(`3813`);
    });

    it('returns an empty page for an offset past the end, without a continuation', async () => {
      mockGetWorks.mockResolvedValueOnce(prolificWorks);

      const result = await runToolContract(orcidGetWorks, {
        orcid_id: '0000-0001-9161-999X',
        offset: 75,
      });

      expect(result.structuredContent).toMatchObject({
        workCount: 60,
        returnedCount: 0,
        offset: 75,
        truncated: false,
        works: [],
      });
      expect(result.structuredContent).not.toHaveProperty('nextOffset');
    });
  });

  describe('byte budget on structuredContent (#36)', () => {
    const BUDGET = 64_000;
    const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const textOf = (result: { content: { type: string; text?: string }[] }) =>
      result.content.map((block) => block.text ?? '').join('');

    /** Works sized like the live record's heaviest summaries (~1 KB structured each). */
    const heavyWorks = Array.from({ length: 528 }, (_, i) => ({
      putCode: 200_000_000 + i,
      title: `Heavy work ${i} ${'é'.repeat(300)}`,
      workType: 'journal-article',
      publicationDate: '2021-03-04',
      journalTitle: 'Proceedings of the National Academy of Sciences of the United States',
      url: `https://doi.org/10.1073/pnas.${i}`,
      externalIds: [
        {
          type: 'doi',
          value: `10.1073/pnas.${i}`,
          url: `https://doi.org/10.1073/pnas.${i}`,
          relationship: 'self',
        },
        { type: 'pmid', value: `${30_000_000 + i}`, relationship: 'self' },
      ],
    }));

    type Page = {
      workCount: number;
      returnedCount: number;
      offset: number;
      nextOffset?: number;
      truncated: boolean;
      works: { putCode?: number; externalIds?: unknown }[];
    };

    async function page(input: Record<string, unknown>, works: unknown[] = heavyWorks) {
      mockGetWorks.mockResolvedValueOnce(works);
      const result = await runToolContract(orcidGetWorks, {
        orcid_id: '0000-0001-9161-999X',
        ...input,
      });
      expect(result.isError).toBeFalsy();
      return { result, structured: result.structuredContent as Page };
    }

    it('stops the page at the budget and continues through truncated/nextOffset', async () => {
      const { result, structured } = await page({ limit: 1000 });

      expect(bytesOf(result.structuredContent)).toBeLessThanOrEqual(BUDGET);
      expect(structured.workCount).toBe(528);
      expect(structured.returnedCount).toBeGreaterThan(0);
      expect(structured.returnedCount).toBeLessThan(528);
      expect(structured.works).toHaveLength(structured.returnedCount);
      expect(structured.truncated).toBe(true);
      expect(structured.nextOffset).toBe(structured.returnedCount);
      // The budget packs the page: one more record would not have fit (the reservation for
      // the page's own counters is a few bytes conservative).
      const next = heavyWorks[structured.returnedCount];
      expect(bytesOf(result.structuredContent) + bytesOf(next) + 1).toBeGreaterThan(BUDGET - 32);

      const text = textOf(result);
      expect(text).toContain('**Truncated:** Yes');
      expect(text).toContain(`**Next Offset:** ${structured.nextOffset}`);
      expect(text).toContain(`**Returned:** ${structured.returnedCount} (offset 0)`);
    });

    it('pages from offset 0 to the end, yielding every work exactly once and in order', async () => {
      const seen: number[] = [];
      let offset: number | undefined = 0;
      let calls = 0;
      while (offset !== undefined) {
        const { result, structured } = await page({ limit: 1000, offset });
        expect(bytesOf(result.structuredContent)).toBeLessThanOrEqual(BUDGET);
        expect(structured.offset).toBe(offset);
        seen.push(...structured.works.map((w) => w.putCode!));
        if (structured.nextOffset === undefined) expect(structured.truncated).toBe(false);
        offset = structured.nextOffset;
        calls++;
      }

      expect(seen).toEqual(heavyWorks.map((w) => w.putCode));
      expect(calls).toBeGreaterThan(1);
    });

    it('fits more works when external identifiers are omitted', async () => {
      const withIds = await page({ limit: 1000 });
      const withoutIds = await page({ limit: 1000, include_external_ids: false });

      expect(bytesOf(withoutIds.result.structuredContent)).toBeLessThanOrEqual(BUDGET);
      expect(withoutIds.structured.returnedCount).toBeGreaterThan(withIds.structured.returnedCount);
      expect(withoutIds.structured.works.every((w) => w.externalIds === undefined)).toBe(true);
    });

    it('lets limit cut the page before the budget does', async () => {
      const { structured } = await page({ limit: 10 });

      expect(structured.returnedCount).toBe(10);
      expect(structured.nextOffset).toBe(10);
    });

    it('returns a single record that alone exceeds the budget, then continues past it', async () => {
      const oversized = { putCode: 1, title: 'x'.repeat(70_000), externalIds: [] };
      const works = [oversized, ...heavyWorks.slice(0, 3)];

      const first = await page({ limit: 1000 }, works);
      expect(first.structured.returnedCount).toBe(1);
      expect(first.structured.works[0]!.putCode).toBe(1);
      expect(first.structured.truncated).toBe(true);
      expect(first.structured.nextOffset).toBe(1);
      expect(bytesOf(first.result.structuredContent)).toBeGreaterThan(BUDGET);

      const second = await page({ limit: 1000, offset: 1 }, works);
      expect(second.structured.returnedCount).toBe(3);
      expect(second.structured.truncated).toBe(false);
      expect(second.structured).not.toHaveProperty('nextOffset');
    });

    it('stops before an oversized record that follows others, and serves it alone next', async () => {
      const oversized = { putCode: 99, title: 'y'.repeat(70_000), externalIds: [] };
      const works = [...heavyWorks.slice(0, 2), oversized, ...heavyWorks.slice(2, 4)];

      const first = await page({ limit: 1000 }, works);
      expect(first.structured.works.map((w) => w.putCode)).toEqual([
        heavyWorks[0]!.putCode,
        heavyWorks[1]!.putCode,
      ]);
      expect(first.structured.nextOffset).toBe(2);

      const second = await page({ limit: 1000, offset: 2 }, works);
      expect(second.structured.works.map((w) => w.putCode)).toEqual([99]);
      expect(second.structured.nextOffset).toBe(3);
    });

    it('keeps the whole response under 130,000 bytes when the text outweighs the structured record', async () => {
      // An untitled work renders a `### (untitled)` heading its JSON has no field for.
      const untitled = Array.from({ length: 1000 }, (_, i) => ({
        putCode: 200_000_000 + i,
        url: `https://example.org/${'a'.repeat(33)}`,
        externalIds: [],
      }));
      const { result, structured } = await page(
        { limit: 1000, include_external_ids: false },
        untitled,
      );

      const textBytes = Buffer.byteLength(textOf(result));
      expect(bytesOf(result.structuredContent)).toBeLessThanOrEqual(BUDGET);
      expect(bytesOf(result.structuredContent) + textBytes).toBeLessThan(130_000);
      expect(structured.truncated).toBe(true);
      expect(structured.nextOffset).toBe(structured.returnedCount);
    });

    it('rejects a limit above the unchanged schema maximum', () => {
      expect(() =>
        orcidGetWorks.input.parse({ orcid_id: '0000-0001-9161-999X', limit: 1001 }),
      ).toThrow();
      expect(() =>
        orcidGetWorks.input.parse({ orcid_id: '0000-0001-9161-999X', limit: 1000 }),
      ).not.toThrow();
    });
  });

  it('formats untitled work as (untitled)', () => {
    const output = orcidGetWorks.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      workCount: 1,
      returnedCount: 1,
      offset: 0,
      truncated: false,
      works: [{ externalIds: [] }],
    });

    const blocks = orcidGetWorks.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(untitled)');
  });
});
