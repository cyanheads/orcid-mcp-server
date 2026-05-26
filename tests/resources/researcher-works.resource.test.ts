/**
 * @fileoverview Tests for researcher-works resource.
 * @module tests/resources/researcher-works.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researcherWorksResource } from '@/mcp-server/resources/definitions/researcher-works.resource.js';

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
    externalIds: [
      { type: 'doi', value: '10.1126/science.1225829', relationship: 'self' },
      { type: 'pmid', value: '22745249', relationship: 'self' },
    ],
  },
];

describe('researcherWorksResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns works list for a valid ORCID iD', async () => {
    mockGetWorks.mockResolvedValueOnce(sampleWorks);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params.parse({ orcid_id: '0000-0001-9522-8779' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.orcidId).toBe('0000-0001-9522-8779');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0001-9522-8779');
    expect(result.workCount).toBe(1);
    expect(result.works).toHaveLength(1);
    expect(result.works[0].title).toBe('CRISPR-Cas9 Mechanism');
    expect(result.works[0].workType).toBe('journal-article');
    expect(result.works[0].publicationDate).toBe('2012-08');
    expect(result.works[0].journalTitle).toBe('Science');
    // externalIds are projected to type+value only
    expect(result.works[0].externalIds).toHaveLength(2);
    expect(result.works[0].externalIds[0].type).toBe('doi');
    expect(result.works[0].externalIds[0].value).toBe('10.1126/science.1225829');
    // relationship is stripped (not in resource output schema)
    expect(
      (result.works[0].externalIds[0] as Record<string, unknown>).relationship,
    ).toBeUndefined();
  });

  it('strips ORCID URI prefix', async () => {
    mockGetWorks.mockResolvedValueOnce(sampleWorks);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params.parse({
      orcid_id: 'https://orcid.org/0000-0001-9522-8779',
    });
    const result = await researcherWorksResource.handler(params, ctx);
    expect(result.orcidId).toBe('0000-0001-9522-8779');
  });

  it('returns empty works list with workCount 0 when no works', async () => {
    mockGetWorks.mockResolvedValueOnce([]);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.workCount).toBe(0);
    expect(result.works).toEqual([]);
  });

  it('handles sparse work entry (no title, no date, empty externalIds)', async () => {
    mockGetWorks.mockResolvedValueOnce([{ externalIds: [] }]);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.workCount).toBe(1);
    expect(result.works[0].title).toBeUndefined();
    expect(result.works[0].externalIds).toEqual([]);
  });

  it('propagates service errors', async () => {
    mockGetWorks.mockRejectedValueOnce(new Error('API unavailable'));

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params.parse({ orcid_id: '0000-0001-9522-8779' });
    await expect(researcherWorksResource.handler(params, ctx)).rejects.toThrow('API unavailable');
  });

  it('projects multiple external ID types (doi, pmid, arxiv)', async () => {
    mockGetWorks.mockResolvedValueOnce([
      {
        title: 'Preprint Study',
        externalIds: [
          { type: 'arxiv', value: '2301.12345', relationship: 'self' },
          { type: 'doi', value: '10.1101/2023.01.01', relationship: 'self' },
        ],
      },
    ]);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    const ids = result.works[0].externalIds;
    expect(ids.some((id) => id.type === 'arxiv')).toBe(true);
    expect(ids.some((id) => id.type === 'doi')).toBe(true);
  });
});
