/**
 * @fileoverview Tests for orcidGetWorks tool.
 * @module tests/tools/get-works.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

describe('orcidGetWorks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns works list with correct counts and IDs', async () => {
    mockGetWorks.mockResolvedValueOnce(sampleWorks);

    const ctx = createMockContext();
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0001-9522-8779' });
    const result = await orcidGetWorks.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0001-9522-8779');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0001-9522-8779');
    expect(result.workCount).toBe(2);
    expect(result.works).toHaveLength(2);
    expect(result.works[0].title).toBe('CRISPR-Cas9 Mechanism');
    expect(result.works[0].externalIds[0].type).toBe('doi');
    expect(result.notice).toBeUndefined();
  });

  it('strips ORCID URI prefix', async () => {
    mockGetWorks.mockResolvedValueOnce(sampleWorks);

    const ctx = createMockContext();
    const input = orcidGetWorks.input.parse({
      orcid_id: 'https://orcid.org/0000-0001-9522-8779',
    });
    const result = await orcidGetWorks.handler(input, ctx);
    expect(result.orcidId).toBe('0000-0001-9522-8779');
  });

  it('adds notice when works list is empty', async () => {
    mockGetWorks.mockResolvedValueOnce([]);

    const ctx = createMockContext();
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetWorks.handler(input, ctx);

    expect(result.workCount).toBe(0);
    expect(result.works).toEqual([]);
    expect(result.notice).toBeDefined();
    expect(result.notice).toContain('No works found');
  });

  it('handles a sparse work entry (no title, no date)', async () => {
    mockGetWorks.mockResolvedValueOnce([{ externalIds: [] }]);

    const ctx = createMockContext();
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetWorks.handler(input, ctx);

    expect(result.workCount).toBe(1);
    expect(result.works[0].title).toBeUndefined();
    expect(result.works[0].externalIds).toEqual([]);
  });

  it('propagates non-404 service errors', async () => {
    mockGetWorks.mockRejectedValueOnce(new Error('Upstream timeout'));

    const ctx = createMockContext();
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0001-9522-8779' });
    await expect(orcidGetWorks.handler(input, ctx)).rejects.toThrow('Upstream timeout');
  });

  it('rejects malformed ORCID iD at input validation', () => {
    expect(() => orcidGetWorks.input.parse({ orcid_id: 'not-a-valid-orcid' })).toThrow();
    expect(() => orcidGetWorks.input.parse({ orcid_id: '' })).toThrow();
  });

  it('accepts bare and URI forms of a valid ORCID iD', () => {
    expect(() => orcidGetWorks.input.parse({ orcid_id: '0000-0001-9522-8779' })).not.toThrow();
    expect(() =>
      orcidGetWorks.input.parse({ orcid_id: 'https://orcid.org/0000-0001-9522-8779' }),
    ).not.toThrow();
  });

  it('throws profile_not_found McpError on 404', async () => {
    mockGetWorks.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.'),
    );

    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    const input = orcidGetWorks.input.parse({ orcid_id: '0000-0000-0000-0000' });
    const error = await orcidGetWorks.handler(input, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((error as McpError).data?.reason).toBe('profile_not_found');
  });

  it('formats works with titles, types, dates, and external IDs', () => {
    const output = orcidGetWorks.output.parse({
      orcidId: '0000-0001-9522-8779',
      orcidUri: 'https://orcid.org/0000-0001-9522-8779',
      workCount: 2,
      works: sampleWorks,
    });

    const blocks = orcidGetWorks.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0001-9522-8779');
    expect(text).toContain('https://orcid.org/0000-0001-9522-8779');
    expect(text).toContain('CRISPR-Cas9 Mechanism');
    expect(text).toContain('journal-article');
    expect(text).toContain('2012-08');
    expect(text).toContain('Science');
    expect(text).toContain('doi:10.1126/science.1225829');
    expect(text).toContain('**Total Works:** 2');
  });

  it('formats empty works list with notice', () => {
    const output = orcidGetWorks.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      workCount: 0,
      works: [],
      notice: 'No works found.',
    });

    const blocks = orcidGetWorks.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Total Works:** 0');
    expect(text).toContain('No works found');
  });

  it('formats untitled work as (untitled)', () => {
    const output = orcidGetWorks.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      workCount: 1,
      works: [{ externalIds: [] }],
    });

    const blocks = orcidGetWorks.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(untitled)');
  });
});
