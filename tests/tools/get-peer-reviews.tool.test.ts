/**
 * @fileoverview Tests for orcidGetPeerReviews tool.
 * @module tests/tools/get-peer-reviews.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetPeerReviews } from '@/mcp-server/tools/definitions/get-peer-reviews.tool.js';

const mockGetPeerReviews = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ getPeerReviews: mockGetPeerReviews }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

const sampleReviews = [
  {
    reviewerRole: 'reviewer',
    reviewType: 'review',
    completionDate: '2021-03',
    conveningOrganization: {
      name: 'Science',
      city: 'Washington',
      country: 'US',
      disambiguatedId: 'https://ror.org/00abcd',
      disambiguationSource: 'ROR',
    },
    reviewUrl: 'https://publons.com/review/123',
    groupIssn: '0036-8075',
  },
];

describe('orcidGetPeerReviews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns peer review records with all fields', async () => {
    mockGetPeerReviews.mockResolvedValueOnce(sampleReviews);

    const ctx = createMockContext();
    const input = orcidGetPeerReviews.input.parse({ orcid_id: '0000-0001-9522-8779' });
    const result = await orcidGetPeerReviews.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0001-9522-8779');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0001-9522-8779');
    expect(result.reviewCount).toBe(1);
    expect(result.peerReviews).toHaveLength(1);
    const r = result.peerReviews[0];
    expect(r.reviewerRole).toBe('reviewer');
    expect(r.reviewType).toBe('review');
    expect(r.completionDate).toBe('2021-03');
    expect(r.conveningOrganization?.name).toBe('Science');
    expect(r.reviewUrl).toBe('https://publons.com/review/123');
    expect(r.groupIssn).toBe('0036-8075');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('strips ORCID URI prefix', async () => {
    mockGetPeerReviews.mockResolvedValueOnce(sampleReviews);

    const ctx = createMockContext();
    const input = orcidGetPeerReviews.input.parse({
      orcid_id: 'https://orcid.org/0000-0001-9522-8779',
    });
    const result = await orcidGetPeerReviews.handler(input, ctx);
    expect(result.orcidId).toBe('0000-0001-9522-8779');
  });

  it('adds notice enrichment when no peer reviews found', async () => {
    mockGetPeerReviews.mockResolvedValueOnce([]);

    const ctx = createMockContext();
    const input = orcidGetPeerReviews.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetPeerReviews.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.reviewCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No peer review records found');
  });

  it('handles sparse review with no optional fields', async () => {
    mockGetPeerReviews.mockResolvedValueOnce([{}]);

    const ctx = createMockContext();
    const input = orcidGetPeerReviews.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetPeerReviews.handler(input, ctx);

    expect(result.peerReviews[0].reviewerRole).toBeUndefined();
    expect(result.peerReviews[0].conveningOrganization).toBeUndefined();
    expect(result.peerReviews[0].groupIssn).toBeUndefined();
  });

  it('propagates non-404 service errors', async () => {
    mockGetPeerReviews.mockRejectedValueOnce(new Error('Rate limited'));

    const ctx = createMockContext();
    const input = orcidGetPeerReviews.input.parse({ orcid_id: '0000-0001-9522-8779' });
    await expect(orcidGetPeerReviews.handler(input, ctx)).rejects.toThrow('Rate limited');
  });

  it('rejects malformed ORCID iD at input validation', () => {
    expect(() => orcidGetPeerReviews.input.parse({ orcid_id: 'not-a-valid-orcid' })).toThrow();
    expect(() => orcidGetPeerReviews.input.parse({ orcid_id: '' })).toThrow();
  });

  it('accepts bare and URI forms of a valid ORCID iD', () => {
    expect(() =>
      orcidGetPeerReviews.input.parse({ orcid_id: '0000-0001-9522-8779' }),
    ).not.toThrow();
    expect(() =>
      orcidGetPeerReviews.input.parse({ orcid_id: 'https://orcid.org/0000-0001-9522-8779' }),
    ).not.toThrow();
  });

  it('throws profile_not_found McpError on 404', async () => {
    mockGetPeerReviews.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.'),
    );

    const ctx = createMockContext({ errors: orcidGetPeerReviews.errors });
    const input = orcidGetPeerReviews.input.parse({ orcid_id: '0000-0000-0000-0000' });
    const error = await orcidGetPeerReviews.handler(input, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((error as McpError).data?.reason).toBe('profile_not_found');
  });

  it('formats peer reviews with all key fields', () => {
    const output = orcidGetPeerReviews.output.parse({
      orcidId: '0000-0001-9522-8779',
      orcidUri: 'https://orcid.org/0000-0001-9522-8779',
      reviewCount: 1,
      peerReviews: sampleReviews,
    });

    const blocks = orcidGetPeerReviews.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0001-9522-8779');
    expect(text).toContain('https://orcid.org/0000-0001-9522-8779');
    expect(text).toContain('Science');
    expect(text).toContain('reviewer');
    expect(text).toContain('review');
    expect(text).toContain('2021-03');
    expect(text).toContain('0036-8075');
    expect(text).toContain('https://publons.com/review/123');
    expect(text).toContain('**Total Reviews:** 1');
  });

  it('formats empty peer reviews', () => {
    const output = orcidGetPeerReviews.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      reviewCount: 0,
      peerReviews: [],
    });

    const blocks = orcidGetPeerReviews.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Total Reviews:** 0');
  });

  it('formats review with unknown organization as "Unknown organization"', () => {
    const output = orcidGetPeerReviews.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      reviewCount: 1,
      peerReviews: [{ reviewerRole: 'reviewer' }],
    });

    const blocks = orcidGetPeerReviews.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Unknown organization');
  });
});
