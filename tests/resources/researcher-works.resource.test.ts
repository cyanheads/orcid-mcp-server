/**
 * @fileoverview Tests for researcher-works resource.
 * @module tests/resources/researcher-works.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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

/** Prolific record fixture (0000-0001-9161-999X returns 524 works in production). */
const prolificWorks = Array.from({ length: 60 }, (_, i) => ({
  title: `Work ${i}`,
  workType: 'journal-article',
  externalIds: [{ type: 'doi', value: `10.1/${i}` }],
}));

describe('researcherWorksResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the works for a valid ORCID iD', async () => {
    mockGetWorks.mockResolvedValueOnce(sampleWorks);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.orcidId).toBe('0000-0002-1825-0097');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0002-1825-0097');
    expect(result.workCount).toBe(1);
    expect(result.works).toHaveLength(1);
    const work = result.works[0]!;
    expect(work.title).toBe('CRISPR-Cas9 Mechanism');
    expect(work.workType).toBe('journal-article');
    expect(work.publicationDate).toBe('2012-08');
    expect(work.journalTitle).toBe('Science');
    // externalIds are projected to type+value only
    expect(work.externalIds).toHaveLength(2);
    const externalId = work.externalIds[0]!;
    expect(externalId.type).toBe('doi');
    expect(externalId.value).toBe('10.1126/science.1225829');
    // relationship is stripped (not in resource output schema)
    expect((externalId as Record<string, unknown>).relationship).toBeUndefined();
  });

  it('strips ORCID URI prefix', async () => {
    mockGetWorks.mockResolvedValueOnce(sampleWorks);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params!.parse({
      orcid_id: 'https://orcid.org/0000-0002-1825-0097',
    });
    const result = await researcherWorksResource.handler(params, ctx);
    expect(result.orcidId).toBe('0000-0002-1825-0097');
  });

  it('caps the works to a compact page and reports the full total in workCount', async () => {
    mockGetWorks.mockResolvedValueOnce(prolificWorks);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    // 0000-0001-9161-999X is the real prolific record (524 works in production).
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0001-9161-999X' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.workCount).toBe(60); // total available, not the page size
    expect(result.works).toHaveLength(25); // conservative compact cap
    expect(result.works[0]!.title).toBe('Work 0');
    expect(result.works[24]!.title).toBe('Work 24');
  });

  it('returns empty works with workCount 0 when no works', async () => {
    mockGetWorks.mockResolvedValueOnce([]);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.workCount).toBe(0);
    expect(result.works).toEqual([]);
  });

  it('handles sparse work entry (no title, no date, empty externalIds)', async () => {
    mockGetWorks.mockResolvedValueOnce([{ externalIds: [] }]);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.workCount).toBe(1);
    expect(result.works[0]!.title).toBeUndefined();
    expect(result.works[0]!.externalIds).toEqual([]);
  });

  it('propagates service errors', async () => {
    mockGetWorks.mockRejectedValueOnce(new Error('API unavailable'));

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    await expect(researcherWorksResource.handler(params, ctx)).rejects.toThrow('API unavailable');
  });

  it('rejects a checksum-invalid ORCID iD with InvalidParams before any upstream request', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    // Well-shaped but checksum-invalid: passes the regex-only param schema, rejected in-handler.
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0000-0000-0000' });
    const err = await Promise.resolve(researcherWorksResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((err as McpError).message).toContain('0000-0000-0000-0000');
    expect((err as McpError).message).toContain('ISO 7064');
    expect(mockGetWorks).not.toHaveBeenCalled();
  });

  it('surfaces notFound() for a non-existent ORCID iD (#8)', async () => {
    // Simulate the service throwing an McpError NotFound (as httpErrorFromResponse does on 404).
    // 0000-0000-0000-0001 is checksum-valid but unregistered — passes local validation.
    mockGetWorks.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'Not Found', {
        url: 'https://pub.orcid.org/v3.0/0000-0000-0000-0001/works',
      }),
    );

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0000-0000-0001' });
    const err = await Promise.resolve(researcherWorksResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((err as McpError).message).toContain('0000-0000-0000-0001');
    expect((err as McpError).message).toContain('not exist or may be fully private');
  });

  it('re-throws non-NotFound service errors unchanged (#8)', async () => {
    const serviceError = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'ORCID API down');
    mockGetWorks.mockRejectedValueOnce(serviceError);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const err = await Promise.resolve(researcherWorksResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toBe(serviceError);
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
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    const ids = result.works[0]!.externalIds;
    expect(ids.some((id) => id.type === 'arxiv')).toBe(true);
    expect(ids.some((id) => id.type === 'doi')).toBe(true);
  });
});
