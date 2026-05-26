/**
 * @fileoverview Tests for orcidGetFunding tool.
 * @module tests/tools/get-funding.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    const input = orcidGetFunding.input.parse({ orcid_id: '0000-0001-9522-8779' });
    const result = await orcidGetFunding.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0001-9522-8779');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0001-9522-8779');
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
    expect(result.notice).toBeUndefined();
  });

  it('strips ORCID URI prefix', async () => {
    mockGetFundings.mockResolvedValueOnce(sampleFunding);

    const ctx = createMockContext();
    const input = orcidGetFunding.input.parse({
      orcid_id: 'https://orcid.org/0000-0001-9522-8779',
    });
    const result = await orcidGetFunding.handler(input, ctx);
    expect(result.orcidId).toBe('0000-0001-9522-8779');
  });

  it('adds notice when no funding records found', async () => {
    mockGetFundings.mockResolvedValueOnce([]);

    const ctx = createMockContext();
    const input = orcidGetFunding.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetFunding.handler(input, ctx);

    expect(result.fundingCount).toBe(0);
    expect(result.notice).toBeDefined();
    expect(result.notice).toContain('self-reported');
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

  it('propagates service errors', async () => {
    mockGetFundings.mockRejectedValueOnce(new Error('Timeout'));

    const ctx = createMockContext();
    const input = orcidGetFunding.input.parse({ orcid_id: '0000-0001-9522-8779' });
    await expect(orcidGetFunding.handler(input, ctx)).rejects.toThrow('Timeout');
  });

  it('formats funding records with all key fields visible', () => {
    const output = orcidGetFunding.output.parse({
      orcidId: '0000-0001-9522-8779',
      orcidUri: 'https://orcid.org/0000-0001-9522-8779',
      fundingCount: 1,
      funding: sampleFunding,
    });

    const blocks = orcidGetFunding.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0001-9522-8779');
    expect(text).toContain('https://orcid.org/0000-0001-9522-8779');
    expect(text).toContain('CRISPR Development Grant');
    expect(text).toContain('NIH');
    expect(text).toContain('https://doi.org/10.13039/100000002');
    expect(text).toContain('FUNDREF');
    expect(text).toContain('R01GM123456');
    expect(text).toContain('2015');
    expect(text).toContain('2020');
    expect(text).toContain('**Total Funding Records:** 1');
  });

  it('formats empty funding with notice', () => {
    const output = orcidGetFunding.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      fundingCount: 0,
      funding: [],
      notice: 'No funding records found.',
    });

    const blocks = orcidGetFunding.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Total Funding Records:** 0');
    expect(text).toContain('No funding records found');
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
