/**
 * @fileoverview Tests for orcidGetWorkDetail tool.
 * @module tests/tools/get-work-detail.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetWorkDetail } from '@/mcp-server/tools/definitions/get-work-detail.tool.js';

const mockGetWorkDetail = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ getWorkDetail: mockGetWorkDetail }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

const fullWorkDetail = {
  putCode: 215949386,
  title: 'CRISPR-Cas9 Programmable Genome Editing',
  subtitle: 'A Versatile Tool for Genome Engineering',
  workType: 'journal-article',
  publicationDate: '2012-08',
  journalTitle: 'Science',
  abstract:
    'We describe the application of the type II CRISPR-Cas9 system for programmable genome editing.',
  citation: {
    type: 'bibtex',
    value: '@article{doudna2012,\n\ttitle = {CRISPR-Cas9}\n}',
  },
  url: 'https://doi.org/10.1126/science.1225829',
  externalIds: [
    {
      type: 'doi',
      value: '10.1126/science.1225829',
      url: 'https://doi.org/10.1126/science.1225829',
      relationship: 'self',
    },
    { type: 'pmid', value: '22745249' },
  ],
  contributors: [
    { name: 'Jinek M', role: 'author', sequence: 'first' },
    { name: 'Chylinski K', role: 'author', sequence: 'additional' },
    { name: 'Doudna JA', role: 'author', sequence: 'additional', orcidId: '0000-0001-9161-999X' },
  ],
  languageCode: 'en',
};

describe('orcidGetWorkDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns full work detail with all fields', async () => {
    mockGetWorkDetail.mockResolvedValueOnce(fullWorkDetail);

    const ctx = createMockContext();
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_code: 215949386,
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0001-9161-999X');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0001-9161-999X');
    expect(result.putCode).toBe(215949386);
    expect(result.title).toBe('CRISPR-Cas9 Programmable Genome Editing');
    expect(result.subtitle).toBe('A Versatile Tool for Genome Engineering');
    expect(result.workType).toBe('journal-article');
    expect(result.publicationDate).toBe('2012-08');
    expect(result.journalTitle).toBe('Science');
    expect(result.abstract).toContain('CRISPR-Cas9');
    expect(result.citation?.type).toBe('bibtex');
    expect(result.url).toBe('https://doi.org/10.1126/science.1225829');
    expect(result.externalIds).toHaveLength(2);
    expect(result.contributors).toHaveLength(3);
    expect(result.contributors[2].orcidId).toBe('0000-0001-9161-999X');
    expect(result.languageCode).toBe('en');
  });

  it('strips ORCID URI prefix from input', async () => {
    mockGetWorkDetail.mockResolvedValueOnce(fullWorkDetail);

    const ctx = createMockContext();
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: 'https://orcid.org/0000-0001-9161-999X',
      put_code: 215949386,
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);
    expect(result.orcidId).toBe('0000-0001-9161-999X');
  });

  it('handles sparse work (no abstract, no contributors, no citation)', async () => {
    // Mirrors what the real API returns for minimal records — most fields absent entirely
    const sparseDetail = {
      putCode: 99999,
      externalIds: [],
      contributors: [],
    };
    mockGetWorkDetail.mockResolvedValueOnce(sparseDetail);

    const ctx = createMockContext();
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0002-1825-0097',
      put_code: 99999,
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result.putCode).toBe(99999);
    expect(result.title).toBeUndefined();
    expect(result.abstract).toBeUndefined();
    expect(result.citation).toBeUndefined();
    expect(result.journalTitle).toBeUndefined();
    expect(result.contributors).toEqual([]);
    expect(result.externalIds).toEqual([]);
    // Output must still validate against the schema
    expect(() => orcidGetWorkDetail.output.parse(result)).not.toThrow();
  });

  it('throws work_not_found on 404', async () => {
    mockGetWorkDetail.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.'),
    );

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0000-0000-0000',
      put_code: 1,
    });
    const error = await orcidGetWorkDetail.handler(input, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((error as McpError).data?.reason).toBe('work_not_found');
  });

  it('propagates non-404 service errors', async () => {
    mockGetWorkDetail.mockRejectedValueOnce(new Error('Network timeout'));

    const ctx = createMockContext();
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_code: 215949386,
    });
    await expect(orcidGetWorkDetail.handler(input, ctx)).rejects.toThrow('Network timeout');
  });

  it('rejects invalid ORCID iD at input validation', () => {
    expect(() =>
      orcidGetWorkDetail.input.parse({ orcid_id: 'not-valid', put_code: 123 }),
    ).toThrow();
  });

  it('rejects non-integer put_code', () => {
    expect(() =>
      orcidGetWorkDetail.input.parse({ orcid_id: '0000-0001-9161-999X', put_code: 1.5 }),
    ).toThrow();
  });

  it('formats a full work with all fields rendered', () => {
    const output = orcidGetWorkDetail.output.parse({
      orcidId: '0000-0001-9161-999X',
      orcidUri: 'https://orcid.org/0000-0001-9161-999X',
      putCode: 215949386,
      title: 'CRISPR-Cas9 Programmable Genome Editing',
      subtitle: 'A Versatile Tool',
      workType: 'journal-article',
      publicationDate: '2012-08',
      journalTitle: 'Science',
      abstract: 'Abstract text here.',
      citation: { type: 'bibtex', value: '@article{...}' },
      url: 'https://doi.org/10.1126/science.1225829',
      externalIds: [{ type: 'doi', value: '10.1126/science.1225829' }],
      contributors: [{ name: 'Jinek M', role: 'author', sequence: 'first' }],
      languageCode: 'en',
    });

    const blocks = orcidGetWorkDetail.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CRISPR-Cas9 Programmable Genome Editing');
    expect(text).toContain('0000-0001-9161-999X');
    expect(text).toContain('215949386');
    expect(text).toContain('A Versatile Tool');
    expect(text).toContain('journal-article');
    expect(text).toContain('2012-08');
    expect(text).toContain('Science');
    expect(text).toContain('Abstract text here.');
    expect(text).toContain('bibtex');
    expect(text).toContain('@article{...}');
    expect(text).toContain('doi:10.1126/science.1225829');
    expect(text).toContain('Jinek M');
    expect(text).toContain('author');
    expect(text).toContain('en');
  });

  it('formats an untitled work without crashing', () => {
    const output = orcidGetWorkDetail.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      putCode: 1,
      externalIds: [],
      contributors: [],
    });

    const blocks = orcidGetWorkDetail.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(untitled)');
  });
});
