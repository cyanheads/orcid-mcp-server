/**
 * @fileoverview Extended resource tests: param validation, URI prefix stripping,
 * and missing-field edge cases for researcher-profile and researcher-works resources.
 * @module tests/resources/resources-extended.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researcherProfileResource } from '@/mcp-server/resources/definitions/researcher-profile.resource.js';
import { researcherWorksResource } from '@/mcp-server/resources/definitions/researcher-works.resource.js';

const mockGetPerson = vi.fn();
const mockGetWorks = vi.fn();

vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({
    getPerson: mockGetPerson,
    getWorks: mockGetWorks,
  }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

// ---------------------------------------------------------------------------
// researcher-profile resource — validation
// ---------------------------------------------------------------------------

describe('researcherProfileResource — param validation', () => {
  it('rejects malformed ORCID iD (wrong group lengths)', () => {
    expect(() =>
      researcherProfileResource.params.parse({ orcid_id: '0000-00001-9522-8779' }),
    ).toThrow();
  });

  it('rejects empty orcid_id', () => {
    expect(() => researcherProfileResource.params.parse({ orcid_id: '' })).toThrow();
  });

  it('rejects non-ORCID URI formats', () => {
    expect(() =>
      researcherProfileResource.params.parse({
        orcid_id: 'http://example.com/0000-0002-1825-0097',
      }),
    ).toThrow();
  });

  it('accepts bare ORCID iD with X checksum', () => {
    expect(() =>
      researcherProfileResource.params.parse({ orcid_id: '0000-0002-9079-593X' }),
    ).not.toThrow();
  });

  it('accepts full URI form', () => {
    expect(() =>
      researcherProfileResource.params.parse({ orcid_id: 'https://orcid.org/0000-0002-1825-0097' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// researcher-profile resource — output fields
// ---------------------------------------------------------------------------

describe('researcherProfileResource — output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes biography when publicly visible', async () => {
    mockGetPerson.mockResolvedValueOnce({
      givenNames: 'Jennifer',
      familyName: 'Doudna',
      biography: 'Biochemist specializing in RNA structure and CRISPR.',
      keywords: [],
      researcherUrls: [],
      externalIdentifiers: [],
      emails: [],
      countries: [],
    });

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherProfileResource.params.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherProfileResource.handler(params, ctx);

    expect(result.biography).toBe('Biochemist specializing in RNA structure and CRISPR.');
  });

  it('omits biography when not present', async () => {
    mockGetPerson.mockResolvedValueOnce({
      givenNames: 'Josiah',
      familyName: 'Carberry',
      keywords: [],
      researcherUrls: [],
      externalIdentifiers: [],
      emails: [],
      countries: [],
    });

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherProfileResource.params.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherProfileResource.handler(params, ctx);

    expect(result.biography).toBeUndefined();
  });

  it('returns correct orcidUri from bare orcid_id', async () => {
    mockGetPerson.mockResolvedValueOnce({
      givenNames: 'Jennifer',
      familyName: 'Doudna',
      keywords: [],
      researcherUrls: [],
      externalIdentifiers: [],
      emails: [],
      countries: [],
    });

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherProfileResource.params.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherProfileResource.handler(params, ctx);

    expect(result.orcidUri).toBe('https://orcid.org/0000-0002-1825-0097');
  });

  it('returns keywords array when keywords are set', async () => {
    mockGetPerson.mockResolvedValueOnce({
      givenNames: 'Jennifer',
      familyName: 'Doudna',
      keywords: ['CRISPR', 'RNA Biology', 'Genome Editing'],
      researcherUrls: [],
      externalIdentifiers: [],
      emails: [],
      countries: [],
    });

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherProfileResource.params.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherProfileResource.handler(params, ctx);

    expect(result.keywords).toEqual(['CRISPR', 'RNA Biology', 'Genome Editing']);
  });
});

// ---------------------------------------------------------------------------
// researcher-works resource — validation
// ---------------------------------------------------------------------------

describe('researcherWorksResource — param validation', () => {
  it('rejects malformed ORCID iD', () => {
    expect(() => researcherWorksResource.params.parse({ orcid_id: 'not-a-valid-orcid' })).toThrow();
  });

  it('rejects empty orcid_id', () => {
    expect(() => researcherWorksResource.params.parse({ orcid_id: '' })).toThrow();
  });

  it('accepts X checksum digit', () => {
    expect(() =>
      researcherWorksResource.params.parse({ orcid_id: '0000-0002-9079-593X' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// researcher-works resource — output fields
// ---------------------------------------------------------------------------

describe('researcherWorksResource — output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns workCount matching the works array length for a small record', async () => {
    mockGetWorks.mockResolvedValueOnce([
      { title: 'Work A', externalIds: [] },
      { title: 'Work B', externalIds: [] },
      { title: 'Work C', externalIds: [] },
    ]);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.workCount).toBe(3);
    expect(result.works).toHaveLength(3);
  });

  it('includes journalTitle when present', async () => {
    mockGetWorks.mockResolvedValueOnce([
      {
        title: 'A Study',
        journalTitle: 'Nature Methods',
        externalIds: [],
      },
    ]);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.works[0].journalTitle).toBe('Nature Methods');
  });

  it('omits url field from works output (not in resource schema)', async () => {
    mockGetWorks.mockResolvedValueOnce([
      {
        title: 'A Study',
        url: 'https://doi.org/10.1/test', // present in Work domain type, not in resource output
        externalIds: [{ type: 'doi', value: '10.1/test' }],
      },
    ]);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    // url is not projected into the resource output schema
    expect((result.works[0] as Record<string, unknown>).url).toBeUndefined();
  });

  it('strips workType when absent', async () => {
    mockGetWorks.mockResolvedValueOnce([
      {
        // no workType
        title: 'A Study',
        externalIds: [],
      },
    ]);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.works[0].workType).toBeUndefined();
  });
});
