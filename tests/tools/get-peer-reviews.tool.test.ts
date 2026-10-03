/**
 * @fileoverview Tests for orcidGetPeerReviews tool.
 * @module tests/tools/get-peer-reviews.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { assert, beforeEach, describe, expect, it, vi } from 'vitest';
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
    sources: [{ name: 'Web of Science Researcher Profile Sync', selfAsserted: false }],
  },
];

describe('orcidGetPeerReviews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns peer review records with all fields', async () => {
    mockGetPeerReviews.mockResolvedValueOnce(sampleReviews);

    const ctx = createMockContext({ errors: orcidGetPeerReviews.errors });
    const input = orcidGetPeerReviews.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetPeerReviews.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0002-1825-0097');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0002-1825-0097');
    expect(result.reviewCount).toBe(1);
    expect(result.peerReviews).toHaveLength(1);
    const r = result.peerReviews[0];
    assert(r);
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

    const ctx = createMockContext({ errors: orcidGetPeerReviews.errors });
    const input = orcidGetPeerReviews.input.parse({
      orcid_id: 'https://orcid.org/0000-0002-1825-0097',
    });
    const result = await orcidGetPeerReviews.handler(input, ctx);
    expect(result.orcidId).toBe('0000-0002-1825-0097');
  });

  it('adds notice enrichment when no peer reviews found', async () => {
    mockGetPeerReviews.mockResolvedValueOnce([]);

    const ctx = createMockContext({ errors: orcidGetPeerReviews.errors });
    const input = orcidGetPeerReviews.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetPeerReviews.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.reviewCount).toBe(0);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('No peer review records found');
  });

  it('handles sparse review with no optional fields', async () => {
    mockGetPeerReviews.mockResolvedValueOnce([{}]);

    const ctx = createMockContext({ errors: orcidGetPeerReviews.errors });
    const input = orcidGetPeerReviews.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetPeerReviews.handler(input, ctx);

    const sparse = result.peerReviews[0];
    assert(sparse);
    expect(sparse.reviewerRole).toBeUndefined();
    expect(sparse.conveningOrganization).toBeUndefined();
    expect(sparse.groupIssn).toBeUndefined();
  });

  it('propagates non-404 service errors', async () => {
    mockGetPeerReviews.mockRejectedValueOnce(new Error('Rate limited'));

    const ctx = createMockContext({ errors: orcidGetPeerReviews.errors });
    const input = orcidGetPeerReviews.input.parse({ orcid_id: '0000-0002-1825-0097' });
    await expect(orcidGetPeerReviews.handler(input, ctx)).rejects.toThrow('Rate limited');
  });

  it('rejects malformed ORCID iD at input validation', () => {
    expect(() => orcidGetPeerReviews.input.parse({ orcid_id: 'not-a-valid-orcid' })).toThrow();
    expect(() => orcidGetPeerReviews.input.parse({ orcid_id: '' })).toThrow();
  });

  it('accepts bare and URI forms of a valid ORCID iD', () => {
    expect(() =>
      orcidGetPeerReviews.input.parse({ orcid_id: '0000-0002-1825-0097' }),
    ).not.toThrow();
    expect(() =>
      orcidGetPeerReviews.input.parse({ orcid_id: 'https://orcid.org/0000-0002-1825-0097' }),
    ).not.toThrow();
  });

  it('fails with profile_not_found and the contract recovery hint on 404', async () => {
    mockGetPeerReviews.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.'),
    );

    const result = await runToolContract(orcidGetPeerReviews, { orcid_id: '0000-0000-0000-0001' });
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; data: { reason: string; recovery: { hint: string } } };
    };
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('profile_not_found');
    expect(error.data.recovery.hint).toContain('orcid_search_researchers');
  });

  it('formats peer reviews with all key fields', () => {
    const output = orcidGetPeerReviews.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      reviewCount: 1,
      peerReviews: sampleReviews,
    });

    const blocks = orcidGetPeerReviews.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0002-1825-0097');
    expect(text).toContain('https://orcid.org/0000-0002-1825-0097');
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

  describe('review headings', () => {
    /** Text of one tool call's `content[]`, with its structured result. */
    async function run(reviews: object[]) {
      mockGetPeerReviews.mockResolvedValueOnce(reviews);
      const result = await runToolContract(orcidGetPeerReviews, {
        orcid_id: '0000-0003-0698-1930',
      });
      expect(result.isError).toBeFalsy();
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const structured = result.structuredContent as {
        peerReviews: { conveningOrganization?: { name?: string }; groupIssn?: string }[];
      };
      return { text, structured };
    }

    it('heads an ISSN-keyed review by the journal ISSN, with the importer on its own line', async () => {
      // Mirrors 0000-0003-0698-1930: a Web of Science import whose convening organization is
      // the import service, keyed by the Clinical Trials ISSN.
      const { text, structured } = await run([
        {
          reviewerRole: 'reviewer',
          reviewType: 'review',
          completionDate: '2024',
          conveningOrganization: { name: 'Publons', city: 'London', country: 'GB' },
          groupIssn: '1740-7753',
          sources: [],
        },
      ]);

      expect(text).toContain(
        '### Journal ISSN 1740-7753\n**Convening organization:** Publons\n**Role:** reviewer',
      );
      expect(text).not.toContain('### Publons');
      expect(text).not.toContain('**Journal ISSN:**');
      expect(structured.peerReviews[0]?.conveningOrganization?.name).toBe('Publons');
      expect(structured.peerReviews[0]?.groupIssn).toBe('1740-7753');
    });

    it('omits the convening line when an ISSN-keyed review has no organization name', async () => {
      const { text } = await run([
        {
          reviewerRole: 'reviewer',
          conveningOrganization: { country: 'US' },
          groupIssn: '0036-8075',
          sources: [],
        },
      ]);

      expect(text).toContain('### Journal ISSN 0036-8075\n**Role:** reviewer');
      expect(text).not.toContain('**Convening organization:**');
      expect(text).not.toContain('Unknown organization');
    });

    it('heads a review without an ISSN by its organization, with no convening line', async () => {
      // An orcid-generated F1000 group: there the organization is the venue.
      const { text } = await run([
        {
          reviewerRole: 'reviewer',
          reviewType: 'evaluation',
          conveningOrganization: { name: 'F1000' },
          sources: [],
        },
      ]);

      expect(text).toContain('### F1000\n**Role:** reviewer');
      expect(text).not.toContain('Journal ISSN');
      expect(text).not.toContain('**Convening organization:**');
    });

    it('carries the importing source on both result surfaces', async () => {
      const { text, structured } = await run([
        {
          reviewerRole: 'reviewer',
          conveningOrganization: { name: 'Publons' },
          groupIssn: '1740-7753',
          sources: [{ name: 'Web of Science Researcher Profile Sync', selfAsserted: false }],
        },
      ]);

      expect((structured.peerReviews[0] as { sources?: unknown } | undefined)?.sources).toEqual([
        { name: 'Web of Science Researcher Profile Sync', selfAsserted: false },
      ]);
      expect(text).toContain('**Sources:** Web of Science Researcher Profile Sync\n');
    });

    it('heads a review with neither an ISSN nor an organization name as Unknown organization', async () => {
      const { text } = await run([{ reviewerRole: 'editor', sources: [] }]);

      expect(text).toContain('### Unknown organization\n**Role:** editor');
      expect(text).not.toContain('**Convening organization:**');
    });
  });

  it('never describes the convening organization as the journal or publisher (#60)', () => {
    const outputSchema = z.toJSONSchema(orcidGetPeerReviews.output) as unknown as {
      properties: { peerReviews: { items: { properties: Record<string, unknown> } } };
    };
    const { conveningOrganization, groupIssn } =
      outputSchema.properties.peerReviews.items.properties;
    const descriptions = JSON.stringify([orcidGetPeerReviews.description, conveningOrganization]);

    expect(descriptions).not.toMatch(/journals? (or|and) publishers?/i);
    expect(descriptions).toContain('importing service');
    expect(JSON.stringify(groupIssn)).toContain('the key to the journal');
  });

  it('formats review with unknown organization as "Unknown organization"', () => {
    const output = orcidGetPeerReviews.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      reviewCount: 1,
      peerReviews: [{ reviewerRole: 'reviewer', sources: [] }],
    });

    const blocks = orcidGetPeerReviews.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Unknown organization');
  });
});
