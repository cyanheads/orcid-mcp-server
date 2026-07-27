/**
 * @fileoverview Tests for orcidGetAffiliations tool.
 * @module tests/tools/get-affiliations.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetAffiliations } from '@/mcp-server/tools/definitions/get-affiliations.tool.js';

const mockGetAffiliations = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ getAffiliations: mockGetAffiliations }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

const sampleAffiliations = [
  {
    type: 'employment',
    organization: {
      name: 'UC Berkeley',
      city: 'Berkeley',
      country: 'US',
      disambiguatedId: 'https://ror.org/01an7q238',
      disambiguationSource: 'ROR',
    },
    department: 'Molecular and Cell Biology',
    role: 'Professor',
    startDate: '2002',
  },
  {
    type: 'education',
    organization: { name: 'Harvard University' },
    role: 'PhD',
    startDate: '1985',
    endDate: '1989',
  },
];

describe('orcidGetAffiliations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns affiliations for default types (employment + education)', async () => {
    mockGetAffiliations.mockResolvedValueOnce(sampleAffiliations);

    const ctx = createMockContext();
    const input = orcidGetAffiliations.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetAffiliations.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0002-1825-0097');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0002-1825-0097');
    expect(result.affiliationCount).toBe(2);
    expect(result.requestedTypes).toEqual(['employment', 'education']);
    expect(result.affiliations).toHaveLength(2);
    const emp = result.affiliations[0];
    expect(emp.type).toBe('employment');
    expect(emp.organization?.name).toBe('UC Berkeley');
    expect(emp.organization?.disambiguatedId).toBe('https://ror.org/01an7q238');
    expect(emp.role).toBe('Professor');
    expect(emp.startDate).toBe('2002');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('passes requested types to the service', async () => {
    mockGetAffiliations.mockResolvedValueOnce([]);

    const ctx = createMockContext();
    const input = orcidGetAffiliations.input.parse({
      orcid_id: '0000-0002-1825-0097',
      types: ['all'],
    });
    await orcidGetAffiliations.handler(input, ctx);

    const [, types] = mockGetAffiliations.mock.calls[0];
    expect(types).toEqual(['all']);
  });

  it('adds notice enrichment when no affiliations found', async () => {
    mockGetAffiliations.mockResolvedValueOnce([]);

    const ctx = createMockContext();
    const input = orcidGetAffiliations.input.parse({
      orcid_id: '0000-0002-1825-0097',
      types: ['employment'],
    });
    const result = await orcidGetAffiliations.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.affiliationCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('employment');
  });

  it('handles sparse affiliation with no organization details', async () => {
    mockGetAffiliations.mockResolvedValueOnce([{ type: 'memberships' }]);

    const ctx = createMockContext();
    const input = orcidGetAffiliations.input.parse({
      orcid_id: '0000-0002-1825-0097',
      types: ['memberships'],
    });
    const result = await orcidGetAffiliations.handler(input, ctx);

    expect(result.affiliations[0].type).toBe('memberships');
    expect(result.affiliations[0].organization).toBeUndefined();
    expect(result.affiliations[0].role).toBeUndefined();
  });

  it('propagates non-404 service errors', async () => {
    mockGetAffiliations.mockRejectedValueOnce(new Error('API error'));

    const ctx = createMockContext();
    const input = orcidGetAffiliations.input.parse({ orcid_id: '0000-0002-1825-0097' });
    await expect(orcidGetAffiliations.handler(input, ctx)).rejects.toThrow('API error');
  });

  it('rejects malformed ORCID iD at input validation', () => {
    expect(() => orcidGetAffiliations.input.parse({ orcid_id: 'not-a-valid-orcid' })).toThrow();
    expect(() => orcidGetAffiliations.input.parse({ orcid_id: '' })).toThrow();
  });

  it('accepts bare and URI forms of a valid ORCID iD', () => {
    expect(() =>
      orcidGetAffiliations.input.parse({ orcid_id: '0000-0002-1825-0097' }),
    ).not.toThrow();
    expect(() =>
      orcidGetAffiliations.input.parse({ orcid_id: 'https://orcid.org/0000-0002-1825-0097' }),
    ).not.toThrow();
  });

  it('throws profile_not_found McpError on 404', async () => {
    mockGetAffiliations.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.'),
    );

    const ctx = createMockContext({ errors: orcidGetAffiliations.errors });
    const input = orcidGetAffiliations.input.parse({ orcid_id: '0000-0000-0000-0001' });
    const error = await orcidGetAffiliations.handler(input, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    const data = (error as McpError).data as { reason?: string; recovery?: { hint?: string } };
    expect(data.reason).toBe('profile_not_found');
    expect(data.recovery?.hint).toBeDefined();
  });

  it('formats affiliations grouped by type with org details', () => {
    const output = orcidGetAffiliations.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      affiliationCount: 2,
      affiliations: sampleAffiliations,
      requestedTypes: ['employment', 'education'],
    });

    const blocks = orcidGetAffiliations.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0002-1825-0097');
    expect(text).toContain('UC Berkeley');
    expect(text).toContain('Professor');
    expect(text).toContain('2002');
    expect(text).toContain('https://ror.org/01an7q238');
    expect(text).toContain('Harvard University');
    expect(text).toContain('employment');
    expect(text).toContain('education');
    expect(text).toContain('**Total Affiliations:** 2');
  });

  it('omits the date line entirely for an affiliation with neither date', () => {
    const output = orcidGetAffiliations.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      affiliationCount: 1,
      affiliations: [{ type: 'qualifications', organization: { name: 'University of Oxford' } }],
      requestedTypes: ['qualifications'],
    });

    const text = (orcidGetAffiliations.format!(output)[0] as { text: string }).text;
    // `present` here would assert an ongoing appointment ORCID never stated.
    expect(text).toContain('University of Oxford');
    expect(text).not.toContain('Dates:');
    expect(text).not.toContain('present');
  });

  it('renders present as the open end only when a start date anchors it', () => {
    const output = orcidGetAffiliations.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      affiliationCount: 1,
      affiliations: [
        {
          type: 'employment',
          organization: { name: 'Universität Bielefeld' },
          startDate: '2003-02-01',
        },
      ],
      requestedTypes: ['employment'],
    });

    const text = (orcidGetAffiliations.format!(output)[0] as { text: string }).text;
    expect(text).toContain('Dates: 2003-02-01 – present');
  });

  it('renders a closed range when both dates are present', () => {
    const output = orcidGetAffiliations.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      affiliationCount: 1,
      affiliations: [
        {
          type: 'education',
          organization: { name: 'Harvard University' },
          startDate: '1985',
          endDate: '1989',
        },
      ],
      requestedTypes: ['education'],
    });

    const text = (orcidGetAffiliations.format!(output)[0] as { text: string }).text;
    expect(text).toContain('Dates: 1985 – 1989');
    expect(text).not.toContain('present');
  });

  it('formats empty affiliations', () => {
    const output = orcidGetAffiliations.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      affiliationCount: 0,
      affiliations: [],
      requestedTypes: ['employment'],
    });

    const blocks = orcidGetAffiliations.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Total Affiliations:** 0');
  });
});
