/**
 * @fileoverview Tests for orcidGetWorks tool.
 * @module tests/tools/get-works.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

/** Prolific record fixture (0000-0001-9161-999X returns 524 works in production). */
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
    // 0000-0001-9161-999X is the real prolific record (524 works in production).
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
