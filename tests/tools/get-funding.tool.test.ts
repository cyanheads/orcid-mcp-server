/**
 * @fileoverview Tests for orcidGetFunding tool.
 * @module tests/tools/get-funding.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { assert, beforeEach, describe, expect, it, vi } from 'vitest';
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
    sources: [{ name: 'Jennifer Doudna', selfAsserted: true }],
  },
];

describe('orcidGetFunding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns funding records with funder details and grant numbers', async () => {
    mockGetFundings.mockResolvedValueOnce(sampleFunding);

    const ctx = createMockContext({ errors: orcidGetFunding.errors });
    const input = orcidGetFunding.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetFunding.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0002-1825-0097');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0002-1825-0097');
    expect(result.fundingCount).toBe(1);
    expect(result.funding).toHaveLength(1);
    const f = result.funding[0];
    assert(f);
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

    const ctx = createMockContext({ errors: orcidGetFunding.errors });
    const input = orcidGetFunding.input.parse({
      orcid_id: 'https://orcid.org/0000-0002-1825-0097',
    });
    const result = await orcidGetFunding.handler(input, ctx);
    expect(result.orcidId).toBe('0000-0002-1825-0097');
  });

  it('adds notice enrichment when no funding records found', async () => {
    mockGetFundings.mockResolvedValueOnce([]);

    const ctx = createMockContext({ errors: orcidGetFunding.errors });
    const input = orcidGetFunding.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetFunding.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.fundingCount).toBe(0);
    expect(enrichment.notice).toBe(
      'No funding records found. Funding reaches ORCID from the researcher or from member organizations, and most records carry none. Absence does not imply no funding.',
    );
  });

  it('handles sparse funding record (no funder, no dates)', async () => {
    mockGetFundings.mockResolvedValueOnce([{ grantNumbers: [] }]);

    const ctx = createMockContext({ errors: orcidGetFunding.errors });
    const input = orcidGetFunding.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetFunding.handler(input, ctx);

    expect(result.fundingCount).toBe(1);
    const sparse = result.funding[0];
    assert(sparse);
    expect(sparse.funder).toBeUndefined();
    expect(sparse.grantNumbers).toEqual([]);
  });

  it('propagates non-404 service errors', async () => {
    mockGetFundings.mockRejectedValueOnce(new Error('Timeout'));

    const ctx = createMockContext({ errors: orcidGetFunding.errors });
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

  it('fails with profile_not_found and the contract recovery hint on 404', async () => {
    mockGetFundings.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.'),
    );

    const result = await runToolContract(orcidGetFunding, { orcid_id: '0000-0000-0000-0001' });
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; data: { reason: string; recovery: { hint: string } } };
    };
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('profile_not_found');
    expect(error.data.recovery.hint).toContain('orcid_search_researchers');
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
    expect(blocks[0]!.type).toBe('text');
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

  it('carries distinct award periods on both result surfaces', async () => {
    mockGetFundings.mockResolvedValueOnce([
      {
        title: 'Dopamine and alpha-2 agonists: Potential anti glaucoma drugs',
        startDate: '1991-08',
        endDate: '1994-07',
        grantNumbers: ['EY06338 NEI'],
        periods: [
          { startDate: '1985-01' },
          { startDate: '1991-08', endDate: '1994-07' },
          { startDate: '1994-08', endDate: '1998-07' },
        ],
        sources: [{ name: 'David Potter', selfAsserted: true }],
      },
      { title: 'Single-version grant', startDate: '2001', grantNumbers: ['X1'], sources: [] },
    ]);

    const result = await runToolContract(orcidGetFunding, { orcid_id: '0000-0002-3489-8176' });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      fundingCount: number;
      funding: { periods?: { startDate?: string; endDate?: string }[] }[];
    };
    expect(structured.fundingCount).toBe(2);
    expect(structured.funding[0]?.periods).toEqual([
      { startDate: '1985-01' },
      { startDate: '1991-08', endDate: '1994-07' },
      { startDate: '1994-08', endDate: '1998-07' },
    ]);
    expect(structured.funding[1]?.periods).toBeUndefined();
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('**Periods:** 1985-01; 1991-08 – 1994-07; 1994-08 – 1998-07');
    expect(text.match(/\*\*Periods:\*\*/g)).toHaveLength(1);
  });

  it('carries every source of the funding item on both result surfaces', async () => {
    mockGetFundings.mockResolvedValueOnce([
      {
        title: 'T32GM008231',
        grantNumbers: ['T32GM008231'],
        sources: [
          { name: 'A Researcher', selfAsserted: true },
          { name: 'DimensionsWizard', assertionOriginName: 'A Researcher', selfAsserted: true },
          { name: 'American Cancer Society', selfAsserted: false },
        ],
      },
    ]);

    const result = await runToolContract(orcidGetFunding, { orcid_id: '0000-0003-1566-2229' });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      funding: {
        sources: { name?: string; assertionOriginName?: string; selfAsserted: boolean }[];
      }[];
    };
    expect(structured.funding[0]?.sources).toHaveLength(3);
    expect(structured.funding[0]?.sources[1]).toEqual({
      name: 'DimensionsWizard',
      assertionOriginName: 'A Researcher',
      selfAsserted: true,
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain(
      '**Sources:** A Researcher (self-asserted); A Researcher via DimensionsWizard (self-asserted); American Cancer Society\n',
    );
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
      funding: [{ grantNumbers: [], sources: [] }],
    });

    const blocks = orcidGetFunding.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(untitled funding)');
  });
});
