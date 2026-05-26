/**
 * @fileoverview Tests for orcidGetProfile tool.
 * @module tests/tools/get-profile.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetProfile } from '@/mcp-server/tools/definitions/get-profile.tool.js';

const mockGetPerson = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ getPerson: mockGetPerson }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

/** Full person fixture. */
const fullPerson = {
  givenNames: 'Jennifer',
  familyName: 'Doudna',
  creditName: 'Jennifer A. Doudna',
  biography: 'Biochemist at UC Berkeley.',
  keywords: ['CRISPR', 'RNA biology'],
  researcherUrls: [{ name: 'Lab', url: 'https://doudnalab.org' }],
  externalIdentifiers: [
    {
      type: 'Scopus Author ID',
      value: '6603342255',
      url: 'https://scopus.com/...',
      relationship: 'self',
    },
  ],
  emails: [{ email: 'jdoudna@berkeley.edu', primary: true }],
  countries: ['US'],
};

describe('orcidGetProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the researcher profile for a bare ORCID iD', async () => {
    mockGetPerson.mockResolvedValueOnce(fullPerson);

    const ctx = createMockContext();
    const input = orcidGetProfile.input.parse({ orcid_id: '0000-0001-9522-8779' });
    const result = await orcidGetProfile.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0001-9522-8779');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0001-9522-8779');
    expect(result.givenNames).toBe('Jennifer');
    expect(result.familyName).toBe('Doudna');
    expect(result.creditName).toBe('Jennifer A. Doudna');
    expect(result.biography).toBe('Biochemist at UC Berkeley.');
    expect(result.keywords).toEqual(['CRISPR', 'RNA biology']);
    expect(result.researcherUrls).toHaveLength(1);
    expect(result.externalIdentifiers).toHaveLength(1);
    expect(result.emails).toHaveLength(1);
    expect(result.countries).toEqual(['US']);
  });

  it('strips ORCID URI prefix from orcid_id', async () => {
    mockGetPerson.mockResolvedValueOnce(fullPerson);

    const ctx = createMockContext();
    const input = orcidGetProfile.input.parse({
      orcid_id: 'https://orcid.org/0000-0001-9522-8779',
    });
    const result = await orcidGetProfile.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0001-9522-8779');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0001-9522-8779');
  });

  it('handles a sparse profile (name only, no biography/keywords/etc.)', async () => {
    mockGetPerson.mockResolvedValueOnce({
      givenNames: 'Josiah',
      familyName: 'Carberry',
      keywords: [],
      researcherUrls: [],
      externalIdentifiers: [],
      emails: [],
      countries: [],
    });

    const ctx = createMockContext();
    const input = orcidGetProfile.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetProfile.handler(input, ctx);

    expect(result.givenNames).toBe('Josiah');
    expect(result.biography).toBeUndefined();
    expect(result.keywords).toEqual([]);
    expect(result.externalIdentifiers).toEqual([]);
  });

  it('propagates non-404 service errors', async () => {
    mockGetPerson.mockRejectedValueOnce(new Error('Network error'));

    const ctx = createMockContext();
    const input = orcidGetProfile.input.parse({ orcid_id: '0000-0001-9522-8779' });
    await expect(orcidGetProfile.handler(input, ctx)).rejects.toThrow('Network error');
  });

  it('rejects malformed ORCID iD at input validation', () => {
    expect(() => orcidGetProfile.input.parse({ orcid_id: 'not-a-valid-orcid' })).toThrow();
    expect(() => orcidGetProfile.input.parse({ orcid_id: 'XXXX-0000-0000-0000' })).toThrow();
    expect(() => orcidGetProfile.input.parse({ orcid_id: '' })).toThrow();
  });

  it('accepts both bare and URI forms of a valid ORCID iD', () => {
    expect(() => orcidGetProfile.input.parse({ orcid_id: '0000-0001-9522-8779' })).not.toThrow();
    expect(() =>
      orcidGetProfile.input.parse({ orcid_id: 'https://orcid.org/0000-0001-9522-8779' }),
    ).not.toThrow();
    // X checksum digit
    expect(() => orcidGetProfile.input.parse({ orcid_id: '0000-0001-5109-344X' })).not.toThrow();
  });

  it('throws profile_not_found McpError on 404', async () => {
    mockGetPerson.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.'),
    );

    const ctx = createMockContext({ errors: orcidGetProfile.errors });
    const input = orcidGetProfile.input.parse({ orcid_id: '0000-0000-0000-0000' });
    const error = await orcidGetProfile.handler(input, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((error as McpError).data?.reason).toBe('profile_not_found');
  });

  it('formats profile with ORCID ID and all populated fields', () => {
    const output = orcidGetProfile.output.parse({
      orcidId: '0000-0001-9522-8779',
      orcidUri: 'https://orcid.org/0000-0001-9522-8779',
      givenNames: 'Jennifer',
      familyName: 'Doudna',
      creditName: 'Jennifer A. Doudna',
      biography: 'Biochemist at UC Berkeley.',
      keywords: ['CRISPR'],
      researcherUrls: [{ name: 'Lab', url: 'https://doudnalab.org' }],
      externalIdentifiers: [
        { type: 'Scopus Author ID', value: '6603342255', url: 'https://scopus.com/...' },
      ],
      emails: [{ email: 'jdoudna@berkeley.edu', primary: true }],
      countries: ['US'],
    });

    const blocks = orcidGetProfile.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0001-9522-8779');
    expect(text).toContain('https://orcid.org/0000-0001-9522-8779');
    expect(text).toContain('Jennifer Doudna');
    expect(text).toContain('Biochemist at UC Berkeley.');
    expect(text).toContain('CRISPR');
    expect(text).toContain('Scopus Author ID');
    expect(text).toContain('6603342255');
    expect(text).toContain('https://doudnalab.org');
    expect(text).toContain('jdoudna@berkeley.edu');
  });

  it('formats a sparse profile without optional sections', () => {
    const output = orcidGetProfile.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      keywords: [],
      researcherUrls: [],
      externalIdentifiers: [],
      emails: [],
      countries: [],
    });

    const blocks = orcidGetProfile.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0002-1825-0097');
    // No crash on empty arrays — sections should be absent
    expect(text).not.toContain('External Identifiers');
    expect(text).not.toContain('Researcher URLs');
  });
});
