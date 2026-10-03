/**
 * @fileoverview Tests for orcidGetProfile tool.
 * @module tests/tools/get-profile.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  otherNames: [],
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

/** The exact text `format()` renders for `fullPerson`. */
const FULL_PERSON_TEXT = [
  '## ORCID Profile: 0000-0002-1825-0097',
  '**Name:** Jennifer Doudna',
  '**Credit Name:** Jennifer A. Doudna',
  '**ORCID URI:** https://orcid.org/0000-0002-1825-0097',
  '',
  '### Biography',
  '> Biochemist at UC Berkeley.',
  '',
  '**Keywords:** CRISPR, RNA biology',
  '',
  '### External Identifiers',
  '- **Scopus Author ID:** 6603342255 (https://scopus.com/...) [self]',
  '',
  '### Researcher URLs',
  '- **Lab:** https://doudnalab.org',
  '',
  '### Emails',
  '- jdoudna@berkeley.edu (primary)',
  '',
  '**Countries:** US',
].join('\n');

describe('orcidGetProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the researcher profile for a bare ORCID iD', async () => {
    mockGetPerson.mockResolvedValueOnce(fullPerson);

    const ctx = createMockContext({ errors: orcidGetProfile.errors });
    const input = orcidGetProfile.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetProfile.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0002-1825-0097');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0002-1825-0097');
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

  it('returns every profile field unchanged and renders them in a fixed layout', async () => {
    mockGetPerson.mockResolvedValueOnce(fullPerson);

    const ctx = createMockContext({ errors: orcidGetProfile.errors });
    const input = orcidGetProfile.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetProfile.handler(input, ctx);

    expect(result).toStrictEqual({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      ...fullPerson,
    });
    const blocks = orcidGetProfile.format!(orcidGetProfile.output.parse(result));
    expect(blocks).toEqual([{ type: 'text', text: FULL_PERSON_TEXT }]);
  });

  it('returns other names in order and renders them after the credit name', async () => {
    const otherNames = ['Josiah Stinkney Carberry', 'J. Carberry', 'J. S. Carberry'];
    mockGetPerson.mockResolvedValueOnce({ ...fullPerson, otherNames });

    const ctx = createMockContext({ errors: orcidGetProfile.errors });
    const input = orcidGetProfile.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetProfile.handler(input, ctx);

    expect(result.otherNames).toEqual(otherNames);
    const [block] = orcidGetProfile.format!(orcidGetProfile.output.parse(result));
    expect((block as { text: string }).text).toBe(
      FULL_PERSON_TEXT.replace(
        '**Credit Name:** Jennifer A. Doudna\n',
        '**Credit Name:** Jennifer A. Doudna\n**Other Names:** Josiah Stinkney Carberry, J. Carberry, J. S. Carberry\n',
      ),
    );
  });

  it('renders a CRLF-separated biography as quoted paragraphs, verbatim in structuredContent (#63)', async () => {
    // The live biography of ORCID's demonstration record: two paragraphs split by CRLF CRLF.
    const biography =
      "Josiah Carberry is a fictitious person. This account is used as a demonstration account by ORCID, CrossRef and others who wish to demonstrate the interaction of ORCID with other scholarly communication systems without having to use a real-person's account.\r\n\r\nJosiah Stinkney Carberry is a fictional professor, created as a joke in 1929.";
    mockGetPerson.mockResolvedValueOnce({ ...emptyPerson, familyName: 'Carberry', biography });

    const result = await runToolContract(orcidGetProfile, { orcid_id: '0000-0002-1825-0097' });

    expect((result.structuredContent as { biography?: string }).biography).toBe(biography);
    expect(textOf(result)).toContain(
      [
        '### Biography',
        "> Josiah Carberry is a fictitious person. This account is used as a demonstration account by ORCID, CrossRef and others who wish to demonstrate the interaction of ORCID with other scholarly communication systems without having to use a real-person's account.",
        '>',
        '> Josiah Stinkney Carberry is a fictional professor, created as a joke in 1929.',
      ].join('\n'),
    );
  });

  it('strips ORCID URI prefix from orcid_id', async () => {
    mockGetPerson.mockResolvedValueOnce(fullPerson);

    const ctx = createMockContext({ errors: orcidGetProfile.errors });
    const input = orcidGetProfile.input.parse({
      orcid_id: 'https://orcid.org/0000-0002-1825-0097',
    });
    const result = await orcidGetProfile.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0002-1825-0097');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0002-1825-0097');
  });

  it('handles a sparse profile (name only, no biography/keywords/etc.)', async () => {
    mockGetPerson.mockResolvedValueOnce({
      givenNames: 'Josiah',
      familyName: 'Carberry',
      otherNames: [],
      keywords: [],
      researcherUrls: [],
      externalIdentifiers: [],
      emails: [],
      countries: [],
    });

    const ctx = createMockContext({ errors: orcidGetProfile.errors });
    const input = orcidGetProfile.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetProfile.handler(input, ctx);

    expect(result.givenNames).toBe('Josiah');
    expect(result.otherNames).toEqual([]);
    expect(result.biography).toBeUndefined();
    expect(result.keywords).toEqual([]);
    expect(result.externalIdentifiers).toEqual([]);
  });

  it('propagates non-404 service errors', async () => {
    mockGetPerson.mockRejectedValueOnce(new Error('Network error'));

    const ctx = createMockContext({ errors: orcidGetProfile.errors });
    const input = orcidGetProfile.input.parse({ orcid_id: '0000-0002-1825-0097' });
    await expect(orcidGetProfile.handler(input, ctx)).rejects.toThrow('Network error');
  });

  it('rejects malformed ORCID iD at input validation', () => {
    expect(() => orcidGetProfile.input.parse({ orcid_id: 'not-a-valid-orcid' })).toThrow();
    expect(() => orcidGetProfile.input.parse({ orcid_id: 'XXXX-0000-0000-0000' })).toThrow();
    expect(() => orcidGetProfile.input.parse({ orcid_id: '' })).toThrow();
  });

  it('accepts both bare and URI forms of a valid ORCID iD', () => {
    expect(() => orcidGetProfile.input.parse({ orcid_id: '0000-0002-1825-0097' })).not.toThrow();
    expect(() =>
      orcidGetProfile.input.parse({ orcid_id: 'https://orcid.org/0000-0002-1825-0097' }),
    ).not.toThrow();
    // X checksum digit
    expect(() => orcidGetProfile.input.parse({ orcid_id: '0000-0002-9079-593X' })).not.toThrow();
  });

  it('fails with profile_not_found and the contract recovery hint on 404', async () => {
    mockGetPerson.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.'),
    );

    const result = await runToolContract(orcidGetProfile, { orcid_id: '0000-0000-0000-0001' });
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; data: { reason: string; recovery: { hint: string } } };
    };
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('profile_not_found');
    expect(error.data.recovery.hint).toContain('orcid_search_researchers');
  });

  it('formats profile with ORCID ID and all populated fields', () => {
    const output = orcidGetProfile.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      givenNames: 'Jennifer',
      familyName: 'Doudna',
      creditName: 'Jennifer A. Doudna',
      otherNames: ['J. A. Doudna'],
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
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0002-1825-0097');
    expect(text).toContain('https://orcid.org/0000-0002-1825-0097');
    expect(text).toContain('Jennifer Doudna');
    expect(text).toContain('**Other Names:** J. A. Doudna');
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
      otherNames: [],
      keywords: [],
      researcherUrls: [],
      externalIdentifiers: [],
      emails: [],
      countries: [],
    });

    const blocks = orcidGetProfile.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // Every empty section is absent: only the heading and the URI render.
    expect(text).toBe(
      '## ORCID Profile: 0000-0002-1825-0097\n**ORCID URI:** https://orcid.org/0000-0002-1825-0097',
    );
  });
});

/** Every collection empty and every scalar absent. */
const emptyPerson = {
  otherNames: [],
  keywords: [],
  researcherUrls: [],
  externalIdentifiers: [],
  emails: [],
  countries: [],
};

/** Every section the notice checks carries data. */
const populatedPerson = { ...fullPerson, otherNames: ['J. A. Doudna'] };

const VISIBILITY =
  'Researchers set ORCID visibility per field, so a section can be private rather than empty.';

/** Run the handler on a mocked person section and return the notice it enriched. */
async function noticeFor(person: Record<string, unknown>): Promise<unknown> {
  mockGetPerson.mockResolvedValueOnce(person);
  const ctx = createMockContext({ errors: orcidGetProfile.errors });
  const input = orcidGetProfile.input.parse({ orcid_id: '0000-0002-1825-0097' });
  await orcidGetProfile.handler(input, ctx);
  return getEnrichment(ctx).notice;
}

const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((block) => block.text ?? '').join('');

describe('orcidGetProfile — empty-section notice (#40)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names every empty section of a name-only profile', async () => {
    expect(await noticeFor({ ...emptyPerson, givenNames: 'Jennifer', familyName: 'Doudna' })).toBe(
      `This profile has no public other names, biography, keywords, researcher URLs, external identifiers, email addresses, or countries. ${VISIBILITY}`,
    );
  });

  it('leads with name when the profile has no name part', async () => {
    expect(await noticeFor(emptyPerson)).toBe(
      `This profile has no public name, other names, biography, keywords, researcher URLs, external identifiers, email addresses, or countries. ${VISIBILITY}`,
    );
  });

  it('joins two empty sections with "or"', async () => {
    expect(await noticeFor({ ...populatedPerson, emails: [], countries: [] })).toBe(
      `This profile has no public email addresses or countries. ${VISIBILITY}`,
    );
  });

  it('names a single empty section alone', async () => {
    expect(await noticeFor({ ...populatedPerson, countries: [] })).toBe(
      `This profile has no public countries. ${VISIBILITY}`,
    );
  });

  it('names an empty other names list right after name', async () => {
    expect(await noticeFor({ ...populatedPerson, otherNames: [], biography: undefined })).toBe(
      `This profile has no public other names or biography. ${VISIBILITY}`,
    );
  });

  it.each([
    ['given names', { givenNames: 'Jennifer' }],
    ['family name', { familyName: 'Doudna' }],
    ['credit name', { creditName: 'Jennifer A. Doudna' }],
  ])('never lists name when only the %s is present', async (_part, name) => {
    const { givenNames: _g, familyName: _f, creditName: _c, ...rest } = populatedPerson;
    expect(await noticeFor({ ...rest, ...name })).toBeUndefined();
  });

  it('emits no notice for a fully populated profile', async () => {
    expect(await noticeFor(populatedPerson)).toBeUndefined();
  });

  it('carries the notice into structuredContent and a content[] blockquote', async () => {
    mockGetPerson.mockResolvedValueOnce({ ...populatedPerson, emails: [], countries: [] });
    const result = await runToolContract(orcidGetProfile, { orcid_id: '0000-0002-1825-0097' });

    const notice = `This profile has no public email addresses or countries. ${VISIBILITY}`;
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
    expect(textOf(result)).toContain(`> ${notice}`);
  });

  it('adds nothing to either surface for a fully populated profile', async () => {
    mockGetPerson.mockResolvedValueOnce(populatedPerson);
    const result = await runToolContract(orcidGetProfile, { orcid_id: '0000-0002-1825-0097' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(textOf(result)).not.toContain('This profile has no public');
  });

  it('serves a nameless profile with the notice, never profile_not_found', async () => {
    mockGetPerson.mockResolvedValueOnce(emptyPerson);
    const result = await runToolContract(orcidGetProfile, { orcid_id: '0000-0002-1825-0097' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toStrictEqual({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      ...emptyPerson,
      notice: `This profile has no public name, other names, biography, keywords, researcher URLs, external identifiers, email addresses, or countries. ${VISIBILITY}`,
    });
  });

  it('keeps the notice out of the handler return', async () => {
    mockGetPerson.mockResolvedValueOnce(emptyPerson);
    const ctx = createMockContext({ errors: orcidGetProfile.errors });
    const input = orcidGetProfile.input.parse({ orcid_id: '0000-0002-1825-0097' });
    const result = await orcidGetProfile.handler(input, ctx);

    expect(result).toStrictEqual({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      ...emptyPerson,
    });
  });
});
