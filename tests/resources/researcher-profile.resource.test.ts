/**
 * @fileoverview Tests for researcher-profile resource.
 * @module tests/resources/researcher-profile.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researcherProfileResource } from '@/mcp-server/resources/definitions/researcher-profile.resource.js';

const mockGetPerson = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ getPerson: mockGetPerson }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

const fullPerson = {
  givenNames: 'Jennifer',
  familyName: 'Doudna',
  creditName: 'Jennifer A. Doudna',
  biography: 'Biochemist at UC Berkeley.',
  keywords: ['CRISPR'],
  researcherUrls: [{ name: 'Lab', url: 'https://doudnalab.org' }],
  externalIdentifiers: [
    {
      type: 'Scopus Author ID',
      value: '6603342255',
      url: 'https://scopus.com/...',
      relationship: 'self',
    },
  ],
  emails: [{ email: 'jdoudna@example.edu', primary: true }],
  countries: ['US'],
};

describe('researcherProfileResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns profile data for a valid ORCID iD', async () => {
    mockGetPerson.mockResolvedValueOnce(fullPerson);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherProfileResource.params.parse({
      orcid_id: '0000-0002-1825-0097',
    });
    const result = await researcherProfileResource.handler(params, ctx);

    expect(result.orcidId).toBe('0000-0002-1825-0097');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0002-1825-0097');
    expect(result.givenNames).toBe('Jennifer');
    expect(result.familyName).toBe('Doudna');
    expect(result.creditName).toBe('Jennifer A. Doudna');
    expect(result.biography).toBe('Biochemist at UC Berkeley.');
    expect(result.keywords).toEqual(['CRISPR']);
    expect(result.researcherUrls).toEqual([{ name: 'Lab', url: 'https://doudnalab.org' }]);
    expect(result.externalIdentifiers).toHaveLength(1);
    expect(result.externalIdentifiers[0].type).toBe('Scopus Author ID');
    expect(result.externalIdentifiers[0].value).toBe('6603342255');
    expect(result.externalIdentifiers[0].url).toBe('https://scopus.com/...');
    // relationship is not in the resource output schema — strips it
  });

  it('strips ORCID URI prefix from param', async () => {
    mockGetPerson.mockResolvedValueOnce(fullPerson);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherProfileResource.params.parse({
      orcid_id: 'https://orcid.org/0000-0002-1825-0097',
    });
    const result = await researcherProfileResource.handler(params, ctx);
    expect(result.orcidId).toBe('0000-0002-1825-0097');
  });

  it('rejects a checksum-invalid ORCID iD with InvalidParams before any upstream request', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    // Well-shaped but checksum-invalid: passes the regex-only param schema, rejected in-handler.
    const params = researcherProfileResource.params.parse({ orcid_id: '0000-0000-0000-0000' });
    const err = await researcherProfileResource.handler(params, ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((err as McpError).message).toContain('0000-0000-0000-0000');
    expect((err as McpError).message).toContain('ISO 7064');
    expect(mockGetPerson).not.toHaveBeenCalled();
  });

  it('throws notFound when person has no public name', async () => {
    mockGetPerson.mockResolvedValueOnce({
      keywords: [],
      researcherUrls: [],
      externalIdentifiers: [],
      emails: [],
      countries: [],
    });

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherProfileResource.params.parse({
      orcid_id: '0000-0009-9999-9999',
    });
    await expect(researcherProfileResource.handler(params, ctx)).rejects.toThrow();
  });

  it('propagates service errors', async () => {
    mockGetPerson.mockRejectedValueOnce(new Error('Service down'));

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherProfileResource.params.parse({
      orcid_id: '0000-0002-1825-0097',
    });
    await expect(researcherProfileResource.handler(params, ctx)).rejects.toThrow('Service down');
  });

  it('remaps an upstream 404 to a clean NotFound without leaking the upstream url or body', async () => {
    // fetchJson → httpErrorFromResponse builds an McpError whose data carries the raw
    // ORCID endpoint URL and error body. The handler must catch it and rethrow a clean
    // NotFound so the framework never serializes those internals to the client.
    mockGetPerson.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.', {
        url: 'https://pub.orcid.org/v3.0/0000-0000-0000-0001/person',
        status: 404,
        statusText: 'Not Found',
        body: '{"response-code":404,"developer-message":"404 Not Found"}',
      }),
    );

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherProfileResource.params.parse({ orcid_id: '0000-0000-0000-0001' });
    const error = await researcherProfileResource.handler(params, ctx).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((error as McpError).message).toBe(
      'No public profile found for ORCID iD 0000-0000-0000-0001.',
    );
    const data = (error as McpError).data as Record<string, unknown> | undefined;
    expect(data?.url).toBeUndefined();
    expect(data?.body).toBeUndefined();
    expect(data?.status).toBeUndefined();
  });

  it('propagates a non-NotFound McpError unchanged', async () => {
    mockGetPerson.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'ORCID API unavailable.'),
    );

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherProfileResource.params.parse({ orcid_id: '0000-0002-1825-0097' });
    const error = await researcherProfileResource.handler(params, ctx).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('handles a sparse profile with creditName only (no givenNames or familyName)', async () => {
    mockGetPerson.mockResolvedValueOnce({
      creditName: 'Anonymous Researcher',
      keywords: [],
      researcherUrls: [],
      externalIdentifiers: [],
      emails: [],
      countries: [],
    });

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherProfileResource.params.parse({ orcid_id: '0000-0009-0000-0007' });
    const result = await researcherProfileResource.handler(params, ctx);
    expect(result.creditName).toBe('Anonymous Researcher');
    expect(result.givenNames).toBeUndefined();
    expect(result.researcherUrls).toEqual([]);
  });

  it('does not include externalIdentifier relationship in output (not in resource schema)', async () => {
    mockGetPerson.mockResolvedValueOnce(fullPerson);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherProfileResource.params.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherProfileResource.handler(params, ctx);

    // relationship is stripped — not part of the resource output schema
    expect((result.externalIdentifiers[0] as Record<string, unknown>).relationship).toBeUndefined();
  });
});
