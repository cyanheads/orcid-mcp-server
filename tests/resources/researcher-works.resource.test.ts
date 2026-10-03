/**
 * @fileoverview Tests for researcher-works resource.
 * @module tests/resources/researcher-works.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researcherWorksResource } from '@/mcp-server/resources/definitions/researcher-works.resource.js';

const mockGetWorks = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', async () => ({
  getOrcidService: () => ({ getWorks: mockGetWorks }),
  normalizeOrcidId: (await import('@/services/orcid/orcid-id.js')).normalizeOrcidId,
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

/** Prolific record fixture (0000-0001-9161-999X returns 500+ works in production). */
const prolificWorks = Array.from({ length: 60 }, (_, i) => ({
  title: `Work ${i}`,
  workType: 'journal-article',
  externalIds: [{ type: 'doi', value: `10.1/${i}` }],
}));

/** A handler context wired with the resource's typed error contract, as production wires it. */
const resourceContext = () =>
  createMockContext({ tenantId: 'test-tenant', errors: researcherWorksResource.errors });

describe('researcherWorksResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the works for a valid ORCID iD', async () => {
    mockGetWorks.mockResolvedValueOnce(sampleWorks);

    const ctx = resourceContext();
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

  it('canonicalizes a lowercase check digit before the upstream call (#57)', async () => {
    mockGetWorks.mockResolvedValueOnce(sampleWorks);

    const ctx = resourceContext();
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0001-9161-999x' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(mockGetWorks).toHaveBeenCalledWith('0000-0001-9161-999X', ctx);
    expect(result.orcidId).toBe('0000-0001-9161-999X');
  });

  it('rejects the URI form — a resource URI segment carries only the bare iD (#57)', () => {
    expect(
      researcherWorksResource.params!.safeParse({
        orcid_id: 'https://orcid.org/0000-0002-1825-0097',
      }).success,
    ).toBe(false);
  });

  it('caps the works to a compact page and reports the full total in workCount', async () => {
    mockGetWorks.mockResolvedValueOnce(prolificWorks);

    const ctx = resourceContext();
    // 0000-0001-9161-999X is the real prolific record (500+ works in production).
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0001-9161-999X' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.workCount).toBe(60); // total available, not the page size
    expect(result.works).toHaveLength(25); // conservative compact cap
    expect(result.works[0]!.title).toBe('Work 0');
    expect(result.works[24]!.title).toBe('Work 24');
  });

  it('returns empty works with workCount 0 when no works', async () => {
    mockGetWorks.mockResolvedValueOnce([]);

    const ctx = resourceContext();
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.workCount).toBe(0);
    expect(result.works).toEqual([]);
  });

  it('handles sparse work entry (no title, no date, empty externalIds)', async () => {
    mockGetWorks.mockResolvedValueOnce([{ externalIds: [] }]);

    const ctx = resourceContext();
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.workCount).toBe(1);
    expect(result.works[0]!.title).toBeUndefined();
    expect(result.works[0]!.externalIds).toEqual([]);
  });

  it('propagates service errors', async () => {
    mockGetWorks.mockRejectedValueOnce(new Error('API unavailable'));

    const ctx = resourceContext();
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    await expect(researcherWorksResource.handler(params, ctx)).rejects.toThrow('API unavailable');
  });

  it('rejects a checksum-invalid ORCID iD with InvalidParams before any upstream request', async () => {
    const ctx = resourceContext();
    // Well-shaped but checksum-invalid: passes the regex-only param schema, rejected in-handler.
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0000-0000-0000' });
    const err = await Promise.resolve(researcherWorksResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((err as McpError).message).toBe(
      'The ORCID iD 0000-0000-0000-0000 is invalid — its ISO 7064 check digit does not match. Verify the iD and try again.',
    );
    expect((err as McpError).data).toStrictEqual({ reason: 'invalid_orcid_id' });
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

    const ctx = resourceContext();
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0000-0000-0001' });
    const err = await Promise.resolve(researcherWorksResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((err as McpError).message).toBe(
      'No works record found for ORCID iD 0000-0000-0000-0001. The record may not exist or may be fully private.',
    );
    // The iD stays beside the typed reason; the upstream URL does not leak.
    expect((err as McpError).data).toStrictEqual({
      orcidId: '0000-0000-0000-0001',
      reason: 'profile_not_found',
    });
  });

  it('re-throws non-NotFound service errors unchanged (#8)', async () => {
    const serviceError = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'ORCID API down');
    mockGetWorks.mockRejectedValueOnce(serviceError);

    const ctx = resourceContext();
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const err = await Promise.resolve(researcherWorksResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toBe(serviceError);
    expect((err as McpError).data).toBeUndefined();
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

    const ctx = resourceContext();
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    const ids = result.works[0]!.externalIds;
    expect(ids.some((id) => id.type === 'arxiv')).toBe(true);
    expect(ids.some((id) => id.type === 'doi')).toBe(true);
  });
});
