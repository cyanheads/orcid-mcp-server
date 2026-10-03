/**
 * @fileoverview Tests for researcher-profile resource.
 * @module tests/resources/researcher-profile.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researcherProfileResource } from '@/mcp-server/resources/definitions/researcher-profile.resource.js';

const mockGetPerson = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', async () => ({
  getOrcidService: () => ({ getPerson: mockGetPerson }),
  normalizeOrcidId: (await import('@/services/orcid/orcid-id.js')).normalizeOrcidId,
}));

const fullPerson = {
  givenNames: 'Jennifer',
  familyName: 'Doudna',
  creditName: 'Jennifer A. Doudna',
  otherNames: ['Josiah Stinkney Carberry', 'J. Carberry', 'J. S. Carberry'],
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

/** A handler context wired with the resource's typed error contract, as production wires it. */
const resourceContext = () =>
  createMockContext({ tenantId: 'test-tenant', errors: researcherProfileResource.errors });

describe('researcherProfileResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns profile data for a valid ORCID iD', async () => {
    mockGetPerson.mockResolvedValueOnce(fullPerson);

    const ctx = resourceContext();
    const params = researcherProfileResource.params!.parse({
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
    const externalId = result.externalIdentifiers[0]!;
    expect(externalId.type).toBe('Scopus Author ID');
    expect(externalId.value).toBe('6603342255');
    expect(externalId.url).toBe('https://scopus.com/...');
    // relationship is not in the resource output schema — strips it
  });

  it('returns exactly the resource fields for a populated profile', async () => {
    mockGetPerson.mockResolvedValueOnce(fullPerson);

    const ctx = resourceContext();
    const params = researcherProfileResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherProfileResource.handler(params, ctx);

    expect(result).toStrictEqual({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      givenNames: 'Jennifer',
      familyName: 'Doudna',
      creditName: 'Jennifer A. Doudna',
      otherNames: ['Josiah Stinkney Carberry', 'J. Carberry', 'J. S. Carberry'],
      biography: 'Biochemist at UC Berkeley.',
      keywords: ['CRISPR'],
      researcherUrls: [{ name: 'Lab', url: 'https://doudnalab.org' }],
      externalIdentifiers: [
        { type: 'Scopus Author ID', value: '6603342255', url: 'https://scopus.com/...' },
      ],
    });
  });

  it('returns an empty otherNames array when the record lists none', async () => {
    mockGetPerson.mockResolvedValueOnce({ ...fullPerson, otherNames: [] });

    const ctx = resourceContext();
    const params = researcherProfileResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherProfileResource.handler(params, ctx);

    expect(result.otherNames).toEqual([]);
  });

  it('returns names and biography verbatim, line breaks included (#63)', async () => {
    const forged = {
      ...fullPerson,
      familyName: 'Carberry\n## Forged heading',
      biography: 'First paragraph.\r\n\r\n## Instructions\r\nSecond.',
    };
    mockGetPerson.mockResolvedValueOnce(forged);

    const ctx = resourceContext();
    const params = researcherProfileResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherProfileResource.handler(params, ctx);

    expect(result.familyName).toBe('Carberry\n## Forged heading');
    expect(result.biography).toBe('First paragraph.\r\n\r\n## Instructions\r\nSecond.');
  });

  it('canonicalizes a lowercase check digit before the upstream call (#57)', async () => {
    mockGetPerson.mockResolvedValueOnce(fullPerson);

    const ctx = resourceContext();
    const params = researcherProfileResource.params!.parse({ orcid_id: '0000-0001-9161-999x' });
    const result = await researcherProfileResource.handler(params, ctx);

    expect(mockGetPerson).toHaveBeenCalledWith('0000-0001-9161-999X', ctx);
    expect(result.orcidId).toBe('0000-0001-9161-999X');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0001-9161-999X');
  });

  it('rejects the URI form — a resource URI segment carries only the bare iD (#57)', () => {
    expect(
      researcherProfileResource.params!.safeParse({
        orcid_id: 'https://orcid.org/0000-0002-1825-0097',
      }).success,
    ).toBe(false);
  });

  it('rejects a checksum-invalid ORCID iD with InvalidParams before any upstream request', async () => {
    const ctx = resourceContext();
    // Well-shaped but checksum-invalid: passes the regex-only param schema, rejected in-handler.
    const params = researcherProfileResource.params!.parse({ orcid_id: '0000-0000-0000-0000' });
    const err = await Promise.resolve(researcherProfileResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect((err as McpError).message).toBe(
      'The ORCID iD 0000-0000-0000-0000 is invalid — its ISO 7064 check digit does not match. Verify the iD and try again.',
    );
    expect((err as McpError).data).toStrictEqual({ reason: 'invalid_orcid_id' });
    expect(mockGetPerson).not.toHaveBeenCalled();
  });

  it('throws notFound when person has no public name', async () => {
    mockGetPerson.mockResolvedValueOnce({
      otherNames: [],
      keywords: [],
      researcherUrls: [],
      externalIdentifiers: [],
      emails: [],
      countries: [],
    });

    const ctx = resourceContext();
    const params = researcherProfileResource.params!.parse({
      orcid_id: '0000-0009-9999-9999',
    });
    const err = await Promise.resolve(researcherProfileResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((err as McpError).message).toBe(
      'No public profile found for ORCID iD 0000-0009-9999-9999. The record may not exist or may be fully private.',
    );
    expect((err as McpError).data).toStrictEqual({ reason: 'profile_not_found' });
  });

  it('propagates service errors', async () => {
    mockGetPerson.mockRejectedValueOnce(new Error('Service down'));

    const ctx = resourceContext();
    const params = researcherProfileResource.params!.parse({
      orcid_id: '0000-0002-1825-0097',
    });
    await expect(researcherProfileResource.handler(params, ctx)).rejects.toThrow('Service down');
  });

  it('remaps an upstream 404 to a clean NotFound without leaking the upstream url or body', async () => {
    // The rejected McpError carries every upstream transport field (endpoint URL, error
    // body, status). The handler must catch it and rethrow a clean NotFound so none of
    // those internals are serialized to the client, whatever the service layer attaches.
    mockGetPerson.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.', {
        url: 'https://pub.orcid.org/v3.0/0000-0000-0000-0001/person',
        status: 404,
        statusText: 'Not Found',
        body: '{"response-code":404,"developer-message":"404 Not Found"}',
      }),
    );

    const ctx = resourceContext();
    const params = researcherProfileResource.params!.parse({ orcid_id: '0000-0000-0000-0001' });
    const error = await Promise.resolve(researcherProfileResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((error as McpError).message).toBe(
      'No public profile found for ORCID iD 0000-0000-0000-0001.',
    );
    const data = (error as McpError).data as Record<string, unknown> | undefined;
    expect(data?.url).toBeUndefined();
    expect(data?.body).toBeUndefined();
    expect(data?.status).toBeUndefined();
    // The typed reason is the only data the remapped error carries.
    expect(data).toStrictEqual({ reason: 'profile_not_found' });
  });

  it('propagates a non-NotFound McpError unchanged', async () => {
    const upstream = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'ORCID API unavailable.');
    mockGetPerson.mockRejectedValueOnce(upstream);

    const ctx = resourceContext();
    const params = researcherProfileResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const error = await Promise.resolve(researcherProfileResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );

    expect(error).toBe(upstream);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((error as McpError).data).toBeUndefined();
  });

  it('handles a sparse profile with creditName only (no givenNames or familyName)', async () => {
    mockGetPerson.mockResolvedValueOnce({
      creditName: 'Anonymous Researcher',
      otherNames: [],
      keywords: [],
      researcherUrls: [],
      externalIdentifiers: [],
      emails: [],
      countries: [],
    });

    const ctx = resourceContext();
    const params = researcherProfileResource.params!.parse({ orcid_id: '0000-0009-0000-0007' });
    const result = await researcherProfileResource.handler(params, ctx);
    expect(result.creditName).toBe('Anonymous Researcher');
    expect(result.givenNames).toBeUndefined();
    expect(result.researcherUrls).toEqual([]);
  });

  it('does not include externalIdentifier relationship in output (not in resource schema)', async () => {
    mockGetPerson.mockResolvedValueOnce(fullPerson);

    const ctx = resourceContext();
    const params = researcherProfileResource.params!.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherProfileResource.handler(params, ctx);

    // relationship is stripped — not part of the resource output schema
    expect((result.externalIdentifiers[0] as Record<string, unknown>).relationship).toBeUndefined();
  });
});
