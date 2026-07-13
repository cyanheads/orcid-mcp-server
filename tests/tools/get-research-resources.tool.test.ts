/**
 * @fileoverview Tests for orcidGetResearchResources tool.
 * @module tests/tools/get-research-resources.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetResearchResources } from '@/mcp-server/tools/definitions/get-research-resources.tool.js';

const mockGetResearchResources = vi.fn();
const mockGetPerson = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({
    getResearchResources: mockGetResearchResources,
    getPerson: mockGetPerson,
  }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

/** Minimal NormalizedPerson stand-in proving the record exists (empty-result path). */
const existingPerson = {
  keywords: [],
  researcherUrls: [],
  externalIdentifiers: [],
  emails: [],
  countries: [],
};

const sampleResources = [
  {
    putCode: 8093,
    title:
      'Requesting Resources for a course on Deep Learning in Medical Imaging at Marshall University',
    hostOrganization: {
      name: 'Advanced Cyberinfrastructure Coordination Ecosystem: Services & Support',
      city: 'Alexandria',
      country: 'US',
      disambiguatedId: 'https://ror.org/01v6d0b34',
      disambiguationSource: 'ROR',
    },
    externalIds: [
      {
        type: 'uri',
        value: 'https://www.xras.org/public/requests/195990-ACCESS-CIS250068',
        relationship: 'self',
      },
    ],
    startDate: '2025-01-24',
    endDate: '2026-01-23',
    url: 'https://www.xras.org/public/requests/195990-ACCESS-CIS250068',
  },
];

describe('orcidGetResearchResources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns resources with all fields', async () => {
    mockGetResearchResources.mockResolvedValueOnce(sampleResources);

    const ctx = createMockContext();
    const input = orcidGetResearchResources.input.parse({ orcid_id: '0000-0002-4788-2309' });
    const result = await orcidGetResearchResources.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0002-4788-2309');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0002-4788-2309');
    expect(result.resourceCount).toBe(1);
    expect(result.resources[0].putCode).toBe(8093);
    expect(result.resources[0].title).toContain('Deep Learning');
    expect(result.resources[0].hostOrganization?.name).toContain('Cyberinfrastructure');
    expect(result.resources[0].hostOrganization?.country).toBe('US');
    expect(result.resources[0].externalIds).toHaveLength(1);
    expect(result.resources[0].startDate).toBe('2025-01-24');
    expect(result.resources[0].endDate).toBe('2026-01-23');
    expect(result.resources[0].url).toContain('xras.org');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('returns empty list gracefully and sets notice enrichment for an existing record', async () => {
    // Real API response for an existing researcher with no resources: {"group":[],...}.
    // The empty-result path verifies existence via getPerson, which resolves here.
    mockGetResearchResources.mockResolvedValueOnce([]);
    mockGetPerson.mockResolvedValueOnce(existingPerson);

    const ctx = createMockContext();
    const input = orcidGetResearchResources.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetResearchResources.handler(input, ctx);

    expect(result.resourceCount).toBe(0);
    expect(result.resources).toEqual([]);
    expect(mockGetPerson).toHaveBeenCalledTimes(1);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No research resources found');
  });

  it('throws profile_not_found for a non-existent iD (empty 200 disambiguated via getPerson 404)', async () => {
    // /research-resources returns HTTP 200 {"group":[]} for non-existent iDs (no 404),
    // so the empty result is ambiguous. The existence check via getPerson 404s.
    mockGetResearchResources.mockResolvedValueOnce([]);
    mockGetPerson.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.'),
    );

    const ctx = createMockContext({ errors: orcidGetResearchResources.errors });
    const input = orcidGetResearchResources.input.parse({ orcid_id: '0000-0000-0000-0001' });
    const error = await orcidGetResearchResources.handler(input, ctx).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((error as McpError).data?.reason).toBe('profile_not_found');
    expect(mockGetResearchResources).toHaveBeenCalledTimes(1);
    expect(mockGetPerson).toHaveBeenCalledTimes(1);
  });

  it('does not call getPerson when resources are present', async () => {
    mockGetResearchResources.mockResolvedValueOnce(sampleResources);

    const ctx = createMockContext();
    const input = orcidGetResearchResources.input.parse({ orcid_id: '0000-0002-4788-2309' });
    await orcidGetResearchResources.handler(input, ctx);

    expect(mockGetPerson).not.toHaveBeenCalled();
  });

  it('handles sparse resource (no host, no dates, no URL)', async () => {
    // Sparse case: only putCode and externalIds present
    const sparseResource = {
      putCode: 1234,
      externalIds: [],
    };
    mockGetResearchResources.mockResolvedValueOnce([sparseResource]);

    const ctx = createMockContext();
    const input = orcidGetResearchResources.input.parse({ orcid_id: '0000-0002-4788-2309' });
    const result = await orcidGetResearchResources.handler(input, ctx);

    expect(result.resourceCount).toBe(1);
    expect(result.resources[0].putCode).toBe(1234);
    expect(result.resources[0].title).toBeUndefined();
    expect(result.resources[0].hostOrganization).toBeUndefined();
    expect(result.resources[0].startDate).toBeUndefined();
    expect(result.resources[0].endDate).toBeUndefined();
    expect(result.resources[0].url).toBeUndefined();
    expect(result.resources[0].externalIds).toEqual([]);
    expect(() => orcidGetResearchResources.output.parse(result)).not.toThrow();
  });

  it('strips ORCID URI prefix from input', async () => {
    mockGetResearchResources.mockResolvedValueOnce(sampleResources);

    const ctx = createMockContext();
    const input = orcidGetResearchResources.input.parse({
      orcid_id: 'https://orcid.org/0000-0002-4788-2309',
    });
    const result = await orcidGetResearchResources.handler(input, ctx);
    expect(result.orcidId).toBe('0000-0002-4788-2309');
  });

  it('throws profile_not_found on 404', async () => {
    mockGetResearchResources.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.'),
    );

    const ctx = createMockContext({ errors: orcidGetResearchResources.errors });
    const input = orcidGetResearchResources.input.parse({ orcid_id: '0000-0000-0000-0001' });
    const error = await orcidGetResearchResources.handler(input, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((error as McpError).data?.reason).toBe('profile_not_found');
  });

  it('propagates non-404 service errors', async () => {
    mockGetResearchResources.mockRejectedValueOnce(new Error('ORCID API unavailable'));

    const ctx = createMockContext();
    const input = orcidGetResearchResources.input.parse({ orcid_id: '0000-0002-4788-2309' });
    await expect(orcidGetResearchResources.handler(input, ctx)).rejects.toThrow(
      'ORCID API unavailable',
    );
  });

  it('rejects invalid ORCID iD at input validation', () => {
    expect(() => orcidGetResearchResources.input.parse({ orcid_id: 'not-valid' })).toThrow();
  });

  it('formats resources with all fields rendered', () => {
    const output = orcidGetResearchResources.output.parse({
      orcidId: '0000-0002-4788-2309',
      orcidUri: 'https://orcid.org/0000-0002-4788-2309',
      resourceCount: 1,
      resources: [
        {
          putCode: 8093,
          title: 'Deep Learning Course Allocation',
          hostOrganization: {
            name: 'ACCESS',
            city: 'Alexandria',
            country: 'US',
            disambiguatedId: 'https://ror.org/01v6d0b34',
            disambiguationSource: 'ROR',
          },
          externalIds: [
            {
              type: 'uri',
              value: 'https://www.xras.org/public/requests/195990',
              relationship: 'self',
            },
          ],
          startDate: '2025-01-24',
          endDate: '2026-01-23',
          url: 'https://www.xras.org/public/requests/195990',
        },
      ],
    });

    const blocks = orcidGetResearchResources.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0002-4788-2309');
    expect(text).toContain('8093');
    expect(text).toContain('Deep Learning Course Allocation');
    expect(text).toContain('ACCESS');
    expect(text).toContain('Alexandria');
    expect(text).toContain('US');
    expect(text).toContain('https://ror.org/01v6d0b34');
    expect(text).toContain('2025-01-24');
    expect(text).toContain('2026-01-23');
    expect(text).toContain('xras.org');
    expect(text).toContain('uri:');
    expect(text).toContain('Total Resources:** 1');
  });

  it('formats empty resource list', () => {
    const output = orcidGetResearchResources.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      resourceCount: 0,
      resources: [],
    });

    const blocks = orcidGetResearchResources.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Total Resources:** 0');
    expect(text).not.toContain('###');
  });

  it('formats untitled resource without crashing', () => {
    const output = orcidGetResearchResources.output.parse({
      orcidId: '0000-0002-4788-2309',
      orcidUri: 'https://orcid.org/0000-0002-4788-2309',
      resourceCount: 1,
      resources: [{ putCode: 1, externalIds: [] }],
    });

    const blocks = orcidGetResearchResources.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(untitled)');
    expect(text).toContain('1');
  });
});
