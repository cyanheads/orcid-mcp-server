/**
 * @fileoverview Tests for orcidGetFunding tool.
 * @module tests/tools/get-funding.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetFunding } from '@/mcp-server/tools/definitions/get-funding.tool.js';

const mockGetFundings = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ getFundings: mockGetFundings }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

const sampleFunding = [
  {
    title: 'CRISPR Development Grant',
    type: 'grant',
    funder: {
      name: 'NIH',
      country: 'US',
      city: 'Bethesda',
      disambiguatedId: 'https://doi.org/10.13039/100000002',
      disambiguationSource: 'FUNDREF',
    },
    startDate: '2015',
    endDate: '2020',
    grantNumbers: ['R01GM123456', 'R01GM789012'],
    url: 'https://grantome.com/grant/NIH/R01-GM123456',
  },
];

describe('orcidGetFunding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns funding records with funder details and grant numbers', async () => {
    mockGetFundings.mockResolvedValueOnce(sampleFunding);

    const ctx = createMockContext();
    const input = orcidGetFunding.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetFunding.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0002-1825-0097');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0002-1825-0097');
    expect(result.fundingCount).toBe(1);
    expect(result.funding).toHaveLength(1);
    const f = result.funding[0];
    expect(f.title).toBe('CRISPR Development Grant');
    expect(f.type).toBe('grant');
    expect(f.funder?.name).toBe('NIH');
    expect(f.funder?.disambiguatedId).toBe('https://doi.org/10.13039/100000002');
    expect(f.grantNumbers).toEqual(['R01GM123456', 'R01GM789012']);
    expect(f.startDate).toBe('2015');
    expect(f.endDate).toBe('2020');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('strips ORCID URI prefix', async () => {
    mockGetFundings.mockResolvedValueOnce(sampleFunding);

    const ctx = createMockContext();
    const input = orcidGetFunding.input.parse({
      orcid_id: 'https://orcid.org/0000-0002-1825-0097',
    });
    const result = await orcidGetFunding.handler(input, ctx);
    expect(result.orcidId).toBe('0000-0002-1825-0097');
  });

  it('adds notice enrichment when no funding records found', async () => {
    mockGetFundings.mockResolvedValueOnce([]);

    const ctx = createMockContext();
    const input = orcidGetFunding.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetFunding.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.fundingCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('self-reported');
  });

  it('handles sparse funding record (no funder, no dates)', async () => {
    mockGetFundings.mockResolvedValueOnce([{ grantNumbers: [] }]);

    const ctx = createMockContext();
    const input = orcidGetFunding.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetFunding.handler(input, ctx);

    expect(result.fundingCount).toBe(1);
    expect(result.funding[0].funder).toBeUndefined();
    expect(result.funding[0].grantNumbers).toEqual([]);
  });

  it('propagates non-404 service errors', async () => {
    mockGetFundings.mockRejectedValueOnce(new Error('Timeout'));

    const ctx = createMockContext();
    const input = orcidGetFunding.input.parse({ orcid_id: '0000-0002-1825-0097' });
    await expect(orcidGetFunding.handler(input, ctx)).rejects.toThrow('Timeout');
  });

  it('rejects malformed ORCID iD at input validation', () => {
    expect(() => orcidGetFunding.input.parse({ orcid_id: 'not-a-valid-orcid' })).toThrow();
    expect(() => orcidGetFunding.input.parse({ orcid_id: '' })).toThrow();
  });

  it('accepts bare and URI forms of a valid ORCID iD', () => {
    expect(() => orcidGetFunding.input.parse({ orcid_id: '0000-0002-1825-0097' })).not.toThrow();
    expect(() =>
      orcidGetFunding.input.parse({ orcid_id: 'https://orcid.org/0000-0002-1825-0097' }),
    ).not.toThrow();
  });

  it('throws profile_not_found McpError on 404', async () => {
    mockGetFundings.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.'),
    );

    const ctx = createMockContext({ errors: orcidGetFunding.errors });
    const input = orcidGetFunding.input.parse({ orcid_id: '0000-0000-0000-0001' });
    const error = await orcidGetFunding.handler(input, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    const data = (error as McpError).data as { reason?: string; recovery?: { hint?: string } };
    expect(data.reason).toBe('profile_not_found');
    expect(data.recovery?.hint).toBeDefined();
  });

  it('formats funding records with all key fields visible', () => {
    const output = orcidGetFunding.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      fundingCount: 1,
      funding: sampleFunding,
    });

    const blocks = orcidGetFunding.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0002-1825-0097');
    expect(text).toContain('https://orcid.org/0000-0002-1825-0097');
    expect(text).toContain('CRISPR Development Grant');
    expect(text).toContain('NIH');
    expect(text).toContain('https://doi.org/10.13039/100000002');
    expect(text).toContain('FUNDREF');
    expect(text).toContain('R01GM123456');
    expect(text).toContain('2015');
    expect(text).toContain('2020');
    expect(text).toContain('**Total Funding Records:** 1');
  });

  it('formats empty funding', () => {
    const output = orcidGetFunding.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      fundingCount: 0,
      funding: [],
    });

    const blocks = orcidGetFunding.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Total Funding Records:** 0');
  });

  it('formats untitled funding record as (untitled funding)', () => {
    const output = orcidGetFunding.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      fundingCount: 1,
      funding: [{ grantNumbers: [] }],
    });

    const blocks = orcidGetFunding.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(untitled funding)');
  });
});
