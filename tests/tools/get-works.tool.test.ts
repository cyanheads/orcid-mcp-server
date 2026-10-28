/**
 * @fileoverview Tests for orcidGetWorks tool.
 * @module tests/tools/get-works.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetWorks } from '@/mcp-server/tools/definitions/get-works.tool.js';

const mockGetWorks = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', async () => {
  const { served } = await import('../helpers/served-record.js');
  const normalizeOrcidId = (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim();
  return {
    getOrcidService: () => ({ getWorks: served(mockGetWorks, normalizeOrcidId) }),
    normalizeOrcidId,
  };
});

const sampleWorks = [
  {
    title: 'CRISPR-Cas9 Mechanism',
    workType: 'journal-article',
    publicationDate: '2012-08',
    journalTitle: 'Science',
    url: 'https://doi.org/10.1126/science.1225829',
    externalIds: [{ type: 'doi', value: '10.1126/science.1225829' }],
    sources: [{ name: 'Crossref', selfAsserted: false }],
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
    sources: [],
  },
];

/** Prolific record fixture (0000-0001-9161-999X returns 500+ works in production). */
const prolificWorks = Array.from({ length: 60 }, (_, i) => ({
  putCode: 1000 + i,
  title: `Work ${i}`,
  workType: 'journal-article',
  publicationDate: '2020',
  externalIds: [{ type: 'doi', value: `10.1/${i}` }],
  sources: [],
}));

describe('orcidGetWorks sources', () => {
  it('carries every source of the work group on both result surfaces', async () => {
    mockGetWorks.mockResolvedValueOnce([
      {
        putCode: 165310393,
        title: 'Grouped work',
        externalIds: [],
        sources: [
          { name: 'Scopus - Elsevier', assertionOriginName: 'David Ussery', selfAsserted: true },
          {
            name: "Oklahoma State University's Research Information Management System",
            selfAsserted: false,
          },
        ],
      },
      {
        putCode: 2,
        title: 'Researcher-entered, unnamed',
        externalIds: [],
        sources: [{ selfAsserted: true }],
      },
      { putCode: 3, title: 'No source recorded', externalIds: [], sources: [] },
    ]);

    const result = await runToolContract(orcidGetWorks, { orcid_id: '0000-0003-3632-5512' });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      works: {
        sources: { name?: string; assertionOriginName?: string; selfAsserted: boolean }[];
      }[];
    };
    expect(structured.works[0]?.sources).toEqual([
      { name: 'Scopus - Elsevier', assertionOriginName: 'David Ussery', selfAsserted: true },
      {
        name: "Oklahoma State University's Research Information Management System",
        selfAsserted: false,
      },
    ]);
    expect(structured.works[2]?.sources).toEqual([]);
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain(
      "**Sources:** David Ussery via Scopus - Elsevier (self-asserted); Oklahoma State University's Research Information Management System\n",
    );
    expect(text).toContain('**Sources:** (unnamed source) (self-asserted)\n');
    expect(text.match(/\*\*Sources:\*\*/g)).toHaveLength(2);
  });
});

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
    expect(result.returnedCount).toBe(25); // default limit
    expect(result.offset).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(25);
    expect(result.works).toHaveLength(25);
    expect(result.works[0]!.title).toBe('Work 0');
    expect(result.works[24]!.title).toBe('Work 24');
  });

  it('pages the tail with offset and clears truncation on the final page', async () => {
    mockGetWorks.mockResolvedValueOnce(prolificWorks);

    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0001-9161-999X', offset: 50 });
    const result = await orcidGetWorks.handler(input, ctx);

    expect(result.workCount).toBe(60);
    expect(result.matchedCount).toBe(60);
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
    expect(enrichment.notice).toBe(
      'No works found. They may be set to private, or neither the researcher nor a member organization added any; absence does not mean no publications.',
    );
  });

  it('handles a sparse work entry (no title, no date)', async () => {
    mockGetWorks.mockResolvedValueOnce([{ externalIds: [], sources: [] }]);

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

  it('fails with profile_not_found and the contract recovery hint on 404', async () => {
    mockGetWorks.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.'),
    );

    // Checksum-valid but unregistered iD — passes local validation, 404s upstream.
    const result = await runToolContract(orcidGetWorks, { orcid_id: '0000-0000-0000-0001' });
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; data: { reason: string; recovery: { hint: string } } };
    };
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('profile_not_found');
    expect(error.data.recovery.hint).toContain('orcid_search_researchers');
  });

  it('formats works with counts, truncation, and external IDs', () => {
    const output = orcidGetWorks.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      workCount: 60,
      matchedCount: 40,
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
    expect(text).toContain('**Matched Works:** 40');
    expect(text).toContain('**Returned:** 2 (offset 0)');
    expect(text).toContain('**Truncated:** Yes');
    expect(text).toContain('**Next Offset:** 2');
  });

  it('formats empty works list', () => {
    const output = orcidGetWorks.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      workCount: 0,
      matchedCount: 0,
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

  describe('unfiltered responses', () => {
    const textOf = (result: { content: { type: string; text?: string }[] }) =>
      result.content.map((block) => block.text ?? '').join('');

    it('returns a small page byte-identical on both surfaces, matchedCount equal to workCount', async () => {
      mockGetWorks.mockResolvedValueOnce(sampleWorks);

      const result = await runToolContract(orcidGetWorks, { orcid_id: '0000-0002-1825-0097' });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toStrictEqual({
        orcidId: '0000-0002-1825-0097',
        orcidUri: 'https://orcid.org/0000-0002-1825-0097',
        workCount: 2,
        matchedCount: 2,
        returnedCount: 2,
        offset: 0,
        truncated: false,
        works: sampleWorks,
      });
      expect(textOf(result)).toMatchInlineSnapshot(`
        "## Works for ORCID 0000-0002-1825-0097
        **URI:** https://orcid.org/0000-0002-1825-0097
        **Total Works:** 2
        **Matched Works:** 2
        **Returned:** 2 (offset 0)
        **Truncated:** No

        ### CRISPR-Cas9 Mechanism
        **Type:** journal-article
        **Date:** 2012-08
        **Journal:** Science
        **URL:** https://doi.org/10.1126/science.1225829
        **IDs:** doi:10.1126/science.1225829
        **Sources:** Crossref

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

      expect(structured.returnedCount).toBe(25);
      expect(structured.nextOffset).toBe(25);
      expect(structured.truncated).toBe(true);
      expect(structured.works.every((w) => w.externalIds === undefined)).toBe(true);
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(textOf(result)).toContain('**Returned:** 25 (offset 0)\n**Truncated:** Yes\n');
    });

    it.each([60, 75])(
      'returns an empty page with a past-end notice for offset %i at or past matchedCount',
      async (offset) => {
        mockGetWorks.mockResolvedValueOnce(prolificWorks);

        const result = await runToolContract(orcidGetWorks, {
          orcid_id: '0000-0001-9161-999X',
          offset,
        });

        const notice = `Offset ${offset} exceeds matchedCount (60). Reduce offset to page through the works.`;
        expect(result.structuredContent).toMatchObject({
          workCount: 60,
          matchedCount: 60,
          returnedCount: 0,
          offset,
          truncated: false,
          works: [],
          notice,
        });
        expect(result.structuredContent).not.toHaveProperty('nextOffset');
        expect(textOf(result)).toContain(`> ${notice}`);
      },
    );

    it('keeps the empty-record notice, not a past-end notice, past the end of an empty record', async () => {
      mockGetWorks.mockResolvedValueOnce([]);

      const result = await runToolContract(orcidGetWorks, {
        orcid_id: '0000-0001-9161-999X',
        offset: 10,
      });

      expect(result.structuredContent).toMatchObject({
        workCount: 0,
        matchedCount: 0,
        notice:
          'No works found. They may be set to private, or neither the researcher nor a member organization added any; absence does not mean no publications.',
      });
    });
  });

  describe('page size (#79)', () => {
    const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const textOf = (result: { content: { type: string; text?: string }[] }) =>
      result.content.map((block) => block.text ?? '').join('');

    /** Works sized like the live record's heaviest summaries (~1 KB structured each). */
    const heavyWorks = Array.from({ length: 1200 }, (_, i) => ({
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
      sources: [
        { name: 'Scopus - Elsevier', assertionOriginName: 'Jennifer Doudna', selfAsserted: true },
        { name: 'Crossref', selfAsserted: false },
      ],
    }));

    type Page = {
      workCount: number;
      matchedCount: number;
      returnedCount: number;
      offset: number;
      nextOffset?: number;
      truncated: boolean;
      works: { putCode?: number; workType?: string; publicationDate?: string }[];
      notice?: string;
      appliedFilters?: unknown;
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

    it('returns limit 1,000 works of 1,200 whatever their size, and continues at 1,000', async () => {
      const { result, structured } = await page({ limit: 1000 });

      // Far past the 64,000 bytes the page used to stop at.
      expect(bytesOf(result.structuredContent)).toBeGreaterThan(500_000);
      expect(structured).toMatchObject({
        workCount: 1200,
        matchedCount: 1200,
        returnedCount: 1000,
        nextOffset: 1000,
        truncated: true,
      });
      expect(structured.works.map((w) => w.putCode)).toEqual(
        heavyWorks.slice(0, 1000).map((w) => w.putCode),
      );
      expect(structured).not.toHaveProperty('notice');
      const text = textOf(result);
      expect(text).toContain(
        '**Returned:** 1000 (offset 0)\n**Truncated:** Yes\n**Next Offset:** 1000',
      );
      expect(text.match(/^### Heavy work /gm)).toHaveLength(1000);
    });

    it('pages from offset 0 to the end in full pages, yielding every work exactly once and in order', async () => {
      const seen: number[] = [];
      const sizes: number[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const { structured } = await page({ limit: 500, offset });
        expect(structured.offset).toBe(offset);
        seen.push(...structured.works.map((w) => w.putCode!));
        sizes.push(structured.returnedCount);
        if (structured.nextOffset === undefined) expect(structured.truncated).toBe(false);
        offset = structured.nextOffset;
      }

      expect(seen).toEqual(heavyWorks.map((w) => w.putCode));
      expect(sizes).toEqual([500, 500, 200]);
    });

    it('returns an oversized record inside a full page instead of ending the page at it', async () => {
      const oversized = { putCode: 99, title: 'y'.repeat(70_000), externalIds: [], sources: [] };
      const works = [...heavyWorks.slice(0, 2), oversized, ...heavyWorks.slice(2, 4)];

      const { structured } = await page({ limit: 1000 }, works);

      expect(structured.works.map((w) => w.putCode)).toEqual(works.map((w) => w.putCode));
      expect(structured.truncated).toBe(false);
      expect(structured).not.toHaveProperty('nextOffset');
      expect(structured).not.toHaveProperty('notice');
    });

    it.each([1001, 10000])(
      'clamps limit %i to 1,000 works with a notice naming both sizes on both surfaces',
      async (limit) => {
        const { result, structured } = await page({ limit });

        const notice = `Requested limit ${limit}; effective cap 1000 works.`;
        expect(structured).toMatchObject({ returnedCount: 1000, nextOffset: 1000, notice });
        expect(textOf(result)).toContain(`> ${notice}`);
      },
    );

    it('rejects a limit above the hard input maximum', () => {
      expect(() =>
        orcidGetWorks.input.parse({ orcid_id: '0000-0001-9161-999X', limit: 10001 }),
      ).toThrow();
      expect(() =>
        orcidGetWorks.input.parse({ orcid_id: '0000-0001-9161-999X', limit: 1000 }),
      ).not.toThrow();
    });
  });

  describe('work type and publication year filters (#81)', () => {
    const textOf = (result: { content: { type: string; text?: string }[] }) =>
      result.content.map((block) => block.text ?? '').join('');

    const TYPES = ['journal-article', 'preprint', 'data-set', 'software', 'book-chapter'];
    const DATES = [
      '2019',
      '2020',
      '2020-06',
      '2021-03-04',
      '2022',
      '2022-12-31',
      '2023',
      undefined,
    ];
    /** 40 works: every type crossed with every date form, undated ones included, in upstream order. */
    const mixedWorks = Array.from({ length: 40 }, (_, i) => {
      const date = DATES[i % DATES.length];
      return {
        putCode: 500 + i,
        title: `Mixed ${i}`,
        workType: TYPES[i % TYPES.length],
        ...(date && { publicationDate: date }),
        externalIds: [],
        sources: [],
      };
    });
    const yearOf = (w: { publicationDate?: string }) =>
      w.publicationDate ? Number(w.publicationDate.slice(0, 4)) : undefined;

    type Page = {
      workCount: number;
      matchedCount: number;
      returnedCount: number;
      offset: number;
      nextOffset?: number;
      truncated: boolean;
      works: { putCode: number; workType?: string; publicationDate?: string }[];
      notice?: string;
      appliedFilters?: { workTypes?: string[]; yearFrom?: number; yearTo?: number };
    };

    async function page(input: Record<string, unknown>, works: unknown[] = mixedWorks) {
      mockGetWorks.mockResolvedValueOnce(works);
      const result = await runToolContract(orcidGetWorks, {
        orcid_id: '0000-0001-9161-999X',
        ...input,
      });
      expect(result.isError).toBeFalsy();
      return { result, structured: result.structuredContent as Page };
    }

    it('keeps only the requested work types, counts them, and pages each match once in order', async () => {
      const wanted = mixedWorks.filter(
        (w) => w.workType === 'journal-article' || w.workType === 'preprint',
      );
      const seen: number[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const { structured } = await page({
          work_types: ['journal-article', 'preprint'],
          limit: 7,
          offset,
        });
        expect(structured.workCount).toBe(40);
        expect(structured.matchedCount).toBe(wanted.length);
        expect(
          structured.works.every((w) => ['journal-article', 'preprint'].includes(w.workType!)),
        ).toBe(true);
        expect(structured.truncated).toBe(structured.nextOffset !== undefined);
        seen.push(...structured.works.map((w) => w.putCode));
        offset = structured.nextOffset;
      }
      expect(seen).toEqual(wanted.map((w) => w.putCode));
    });

    it('echoes the applied type filter on both surfaces and keeps undated works under it', async () => {
      const { result, structured } = await page({ work_types: ['software'] });

      expect(structured.appliedFilters).toEqual({ workTypes: ['software'] });
      expect(structured.works.some((w) => w.publicationDate === undefined)).toBe(true);
      expect(structured).not.toHaveProperty('notice');
      expect(textOf(result)).toContain('**Filters:** work_types: software');
    });

    it('keeps works dated 2020–2022 in YYYY, YYYY-MM, or YYYY-MM-DD form and counts the undated it drops', async () => {
      const { result, structured } = await page({ year_from: 2020, year_to: 2022, limit: 100 });

      const wanted = mixedWorks.filter((w) => {
        const year = yearOf(w);
        return year !== undefined && year >= 2020 && year <= 2022;
      });
      expect(structured.matchedCount).toBe(wanted.length);
      expect(structured.works.map((w) => w.putCode)).toEqual(wanted.map((w) => w.putCode));
      expect(new Set(structured.works.map((w) => w.publicationDate))).toEqual(
        new Set(['2020', '2020-06', '2021-03-04', '2022', '2022-12-31']),
      );
      expect(structured.appliedFilters).toEqual({ yearFrom: 2020, yearTo: 2022 });
      const notice = '5 works without a publication date were left out by the year filter.';
      expect(structured.notice).toBe(notice);
      const text = textOf(result);
      expect(text).toContain(`> ${notice}`);
      expect(text).toContain('**Filters:** year_from: 2020; year_to: 2022');
      expect(text).toContain(`**Matched Works:** ${wanted.length}`);
    });

    it('applies an open-ended year bound and ANDs it with the type filter', async () => {
      const { structured } = await page({ work_types: ['data-set'], year_from: 2022 });

      const wanted = mixedWorks.filter(
        (w) => w.workType === 'data-set' && (yearOf(w) ?? 0) >= 2022,
      );
      expect(structured.works.map((w) => w.putCode)).toEqual(wanted.map((w) => w.putCode));
      expect(structured.appliedFilters).toEqual({ workTypes: ['data-set'], yearFrom: 2022 });
    });

    it('treats work_types: [] as no type filter: no echo, matchedCount equals workCount', async () => {
      const { structured } = await page({ work_types: [], limit: 100 });

      expect(structured.matchedCount).toBe(40);
      expect(structured.returnedCount).toBe(40);
      expect(structured).not.toHaveProperty('appliedFilters');
      expect(structured).not.toHaveProperty('notice');
    });

    it('returns zero works and a notice naming the filters and workCount when nothing matches', async () => {
      const { result, structured } = await page({
        work_types: ['patent', 'software'],
        year_from: 1990,
        year_to: 1995,
      });

      expect(structured).toMatchObject({
        workCount: 40,
        matchedCount: 0,
        returnedCount: 0,
        truncated: false,
        works: [],
      });
      expect(structured).not.toHaveProperty('nextOffset');
      // Only the undated works the type filter would keep are counted: one undated software work.
      const notice =
        "1 work without a publication date was left out by the year filter. No works match the filters (work_types: patent, software; year_from: 1990; year_to: 1995) among the record's 40 works. Drop or widen a filter.";
      expect(structured.notice).toBe(notice);
      expect(textOf(result)).toContain(`> ${notice}`);
    });

    it('composes the clamp, filter, and past-end notices in that order into one notice', async () => {
      const { structured } = await page({ year_from: 2023, limit: 1001, offset: 9 });

      expect(structured.matchedCount).toBe(5);
      expect(structured.notice).toBe(
        'Requested limit 1001; effective cap 1000 works. 5 works without a publication date were left out by the year filter. Offset 9 exceeds matchedCount (5). Reduce offset to page through the works.',
      );
    });

    it.each<[Record<string, unknown>, string]>([
      [{ work_types: ['dataset'] }, 'journal-article'],
      [{ work_types: ['Journal-Article'] }, 'journal-article'],
      [{ year_from: 2023, year_to: 2020 }, 'year_from'],
      [{ year_from: 2020.5 }, 'year_from'],
    ])('rejects %j before any upstream request', async (input, mentioned) => {
      const result = await runToolContract(orcidGetWorks, {
        orcid_id: '0000-0001-9161-999X',
        ...input,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(mentioned);
      expect(mockGetWorks).not.toHaveBeenCalled();
    });

    it('advertises the 58 ORCID work types as the work_types vocabulary', () => {
      const schema = z.toJSONSchema(orcidGetWorks.input) as unknown as {
        properties: { work_types: { items: { enum: string[] } } };
      };
      const vocabulary = schema.properties.work_types.items.enum;
      expect(vocabulary).toHaveLength(58);
      expect(vocabulary).toEqual(
        expect.arrayContaining(['data-set', 'journal-article', 'undefined']),
      );
      expect(vocabulary).not.toContain('dataset');
    });
  });

  it('formats untitled work as (untitled)', () => {
    const output = orcidGetWorks.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      workCount: 1,
      matchedCount: 1,
      returnedCount: 1,
      offset: 0,
      truncated: false,
      works: [{ externalIds: [], sources: [] }],
    });

    const blocks = orcidGetWorks.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(untitled)');
  });
});
