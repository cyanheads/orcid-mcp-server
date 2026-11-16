/**
 * @fileoverview Tool-contract coverage for the ORCID record tools — profile, works
 * summaries, and bulk work detail. Each case runs the production pipeline (input parse,
 * real handler, output parse, format, enrichment, error envelope) against a faked ORCID
 * upstream, for both the success envelope and every declared error reason.
 * @module tests/integration/record-contracts.int.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { orcidGetProfile } from '@/mcp-server/tools/definitions/get-profile.tool.js';
import { orcidGetWorkDetail } from '@/mcp-server/tools/definitions/get-work-detail.tool.js';
import { orcidGetWorks } from '@/mcp-server/tools/definitions/get-works.tool.js';
import {
  BULK_FAILURE_ID,
  createOrcidFetchMock,
  initOrcidServiceForTests,
  LARGE_COLLAB_CITATION,
  LARGE_COLLAB_CONTRIBUTORS,
  LARGE_COLLAB_ID,
  LARGE_COLLAB_PUT_CODE,
  MISSING_ID,
  RATE_LIMITED_ID,
  RESEARCHER_ID,
  RESOLVED_PUT_CODE,
  UNRESOLVED_PUT_CODE,
} from './orcid-api-fixtures.js';

let http: FetchMockHarness;

beforeAll(() => {
  http = createOrcidFetchMock();
  http.install();
  initOrcidServiceForTests();
});

afterAll(() => {
  http.restore();
});

toolContractSuite(orcidGetProfile, {
  success: [
    {
      name: 'returns the public person section',
      input: { orcid_id: RESEARCHER_ID },
      expected: {
        orcidId: RESEARCHER_ID,
        orcidUri: `https://orcid.org/${RESEARCHER_ID}`,
        familyName: 'Doudna',
        otherNames: ['Josiah Stinkney Carberry', 'J. Carberry', 'J. S. Carberry'],
      },
      assert: (result) => {
        const structured = result.structuredContent as {
          externalIdentifiers: { type: string; value: string }[];
        };
        expect(structured.externalIdentifiers[0]).toMatchObject({
          type: 'Scopus Author ID',
          value: '6603342255',
        });
        const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        expect(text).toContain(
          '**Credit Name:** Jennifer A. Doudna\n**Other Names:** Josiah Stinkney Carberry, J. Carberry, J. S. Carberry\n**ORCID URI:**',
        );
        // Every section is populated, so no empty-section notice reaches either surface.
        expect(result.structuredContent).not.toHaveProperty('notice');
        expect(text).not.toContain('This profile has no public');
      },
    },
    {
      name: 'accepts a full ORCID URI and normalizes it',
      input: { orcid_id: `https://orcid.org/${RESEARCHER_ID}` },
      expected: { orcidId: RESEARCHER_ID },
    },
  ],
  errors: [
    {
      name: 'reports an ORCID iD with no registered researcher',
      input: { orcid_id: MISSING_ID },
      code: JsonRpcErrorCode.NotFound,
      reason: 'profile_not_found',
    },
  ],
});

toolContractSuite(orcidGetWorks, {
  success: [
    {
      name: 'returns a paged slice of the works list',
      input: { orcid_id: RESEARCHER_ID, limit: 1 },
      expected: {
        workCount: 2,
        returnedCount: 1,
        offset: 0,
        nextOffset: 1,
        truncated: true,
      },
    },
    {
      name: 'carries identifiers another source in the work group holds',
      input: { orcid_id: RESEARCHER_ID, limit: 1 },
      assert: (result) => {
        const structured = result.structuredContent as {
          works: { externalIds?: { type: string; value: string; relationship?: string }[] }[];
        };
        expect(structured.works[0]?.externalIds).toEqual([
          {
            type: 'doi',
            value: '10.1126/science.1225829',
            url: 'https://doi.org/10.1126/science.1225829',
            relationship: 'self',
          },
          { type: 'pmid', value: '22745249', relationship: 'self' },
          { type: 'pmc', value: 'PMC6286148', relationship: 'self' },
        ]);
        const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        expect(text).toContain('pmid:22745249 [self], pmc:PMC6286148 [self]');
        expect(text).not.toContain('inst-000417');
      },
    },
    {
      name: 'lists every source in the work group, and none for a sourceless summary',
      input: { orcid_id: RESEARCHER_ID },
      assert: (result) => {
        const structured = result.structuredContent as { works: { sources: unknown[] }[] };
        expect(structured.works[0]?.sources).toEqual([
          { name: 'Crossref', selfAsserted: false },
          {
            name: 'Europe PubMed Central',
            assertionOriginName: 'Jennifer Doudna',
            selfAsserted: true,
          },
        ]);
        expect(structured.works[1]?.sources).toEqual([]);
        const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        expect(text).toContain(
          '**Sources:** Crossref; Jennifer Doudna via Europe PubMed Central (self-asserted)\n',
        );
      },
    },
    {
      name: 'omits external identifiers when not requested',
      input: { orcid_id: RESEARCHER_ID, include_external_ids: false },
      assert: (result) => {
        const structured = result.structuredContent as {
          works: { externalIds?: unknown[] }[];
        };
        expect(structured.works).toHaveLength(2);
        for (const work of structured.works) {
          expect(work.externalIds).toBeUndefined();
        }
      },
    },
  ],
  errors: [
    {
      name: 'reports an ORCID iD with no registered researcher',
      input: { orcid_id: MISSING_ID },
      code: JsonRpcErrorCode.NotFound,
      reason: 'profile_not_found',
    },
  ],
});

toolContractSuite(orcidGetWorkDetail, {
  success: [
    {
      name: 'resolves put-codes and surfaces per-record errors inline',
      input: { orcid_id: RESEARCHER_ID, put_codes: [RESOLVED_PUT_CODE, UNRESOLVED_PUT_CODE] },
      assert: (result) => {
        const structured = result.structuredContent as {
          works: { putCode: number; abstract?: string; contributors: { name?: string }[] }[];
          errors: { putCode?: number; message: string }[];
        };
        expect(structured.works[0]?.putCode).toBe(RESOLVED_PUT_CODE);
        expect(structured.works[0]?.abstract).toContain('RNA-programmable');
        expect(structured.works[0]?.contributors).toHaveLength(2);
        expect((structured.works[0] as { sources?: unknown }).sources).toEqual([
          { name: 'Crossref', selfAsserted: false },
        ]);
        expect(structured.errors[0]?.putCode).toBe(UNRESOLVED_PUT_CODE);
      },
    },
    {
      name: 'caps a large-collaboration record: first 100 contributors plus the owner, no citation (#52)',
      input: { orcid_id: LARGE_COLLAB_ID, put_codes: [LARGE_COLLAB_PUT_CODE] },
      assert: (result) => {
        const [work] = (
          result.structuredContent as {
            works: {
              putCode: number;
              contributors: { name?: string; orcidId?: string }[];
              contributorCount?: number;
              contributorsTruncated?: boolean;
              citation?: unknown;
              citationOmitted?: boolean;
            }[];
          }
        ).works;
        expect(Buffer.byteLength(LARGE_COLLAB_CITATION)).toBeGreaterThan(8_192);
        expect(work?.putCode).toBe(LARGE_COLLAB_PUT_CODE);
        expect(work?.contributors).toHaveLength(101);
        expect(work?.contributors[99]).toEqual({ name: 'Author 99', role: 'author' });
        expect(work?.contributors[100]).toEqual({
          name: 'Owner R.',
          orcidId: LARGE_COLLAB_ID,
          role: 'author',
        });
        expect(work?.contributorCount).toBe(LARGE_COLLAB_CONTRIBUTORS);
        expect(work?.contributorsTruncated).toBe(true);
        expect(work).not.toHaveProperty('citation');
        expect(work?.citationOmitted).toBe(true);
        const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        expect(text).toContain(
          `**Contributors (first 100 of ${LARGE_COLLAB_CONTRIBUTORS}, plus the record owner):**`,
        );
        expect(text).toContain(
          '**Citation:** omitted — the deposited citation exceeds 8,192 bytes',
        );
      },
    },
  ],
  errors: [
    {
      name: 'reports an ORCID iD with no registered researcher',
      input: { orcid_id: MISSING_ID, put_codes: [RESOLVED_PUT_CODE] },
      code: JsonRpcErrorCode.NotFound,
      reason: 'profile_not_found',
    },
    {
      name: 'reports an unexpected bulk-endpoint failure',
      input: { orcid_id: BULK_FAILURE_ID, put_codes: [RESOLVED_PUT_CODE] },
      code: JsonRpcErrorCode.InternalError,
      reason: 'fetch_failed',
    },
    {
      name: 'keeps an upstream 429 rate limit as RateLimited',
      input: { orcid_id: RATE_LIMITED_ID, put_codes: [RESOLVED_PUT_CODE] },
      code: JsonRpcErrorCode.RateLimited,
    },
  ],
});

describe('orcid_get_work_detail upstream rate limit, through the real service', () => {
  it('forwards the upstream Retry-After and nothing else from the 429', async () => {
    const result = await runToolContract(orcidGetWorkDetail, {
      orcid_id: RATE_LIMITED_ID,
      put_codes: [RESOLVED_PUT_CODE],
    });

    expect(result.isError).toBe(true);
    const envelope = (
      result.structuredContent as {
        error: { code: number; message: string; data?: Record<string, unknown> };
      }
    ).error;
    expect(envelope.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(envelope.message).toBe(
      `ORCID bulk works endpoint is rate-limited for ${RATE_LIMITED_ID}.`,
    );
    // httpErrorFromResponse sets retryAfter from the header and no retryable flag for a 429.
    expect(envelope.data).toStrictEqual({ retryAfter: '120' });
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(text).not.toContain('203.0.113.7');
    expect(text).not.toContain('/works/');
  });
});

describe('orcid_get_profile include_history, through the real service (#87)', () => {
  const BASE = getServerConfig().orcidApiBaseUrl.replace(/\/$/, '');
  /** `/record` of this iD as ORCID served it, its public email addresses replaced. */
  const RECORD_ID = '0000-0001-5406-5852';
  const record = JSON.parse(
    readFileSync(new URL('./profile-record.fixture.json', import.meta.url), 'utf8'),
  ) as { person: unknown };
  const HISTORY_BLOCK = [
    '### Record History',
    '**Created:** 2018-05-10T05:58:12.742Z',
    '**Creation Method:** MEMBER_REFERRED',
    '**Claimed:** true',
    '**Verified Email:** true',
    '**Verified Primary Email:** true',
    '**Last Modified:** 2019-12-18T02:26:52.219Z',
  ].join('\n');
  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Answer every request with `respond(url)`, recording each URL requested. */
  function serve(respond: (url: string) => Response) {
    const fetchMock = vi.fn(async (url: string) => respond(url));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('returns the record history on both surfaces and reads /record alone', async () => {
    const fetchMock = serve(() => Response.json(record));
    const result = await runToolContract(orcidGetProfile, {
      orcid_id: RECORD_ID,
      include_history: true,
    });

    expect(result.isError).toBeFalsy();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${BASE}/${RECORD_ID}/record`]);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.history).toStrictEqual({
      createdDate: '2018-05-10T05:58:12.742Z',
      creationMethod: 'MEMBER_REFERRED',
      claimed: true,
      verifiedEmail: true,
      verifiedPrimaryEmail: true,
      lastModifiedDate: '2019-12-18T02:26:52.219Z',
    });
    expect(structured.emails).toStrictEqual([
      { email: 'person@example.org', primary: true, verified: true },
      { email: 'person.alt@example.org', primary: false, verified: true },
    ]);
    expect(textOf(result)).toContain(HISTORY_BLOCK);
    expect(textOf(result)).toContain(
      '### Emails\n- person@example.org (primary) (verified)\n- person.alt@example.org (verified)',
    );
  });

  it.each([{}, { include_history: false }])(
    'reads /person alone and returns no history for %j',
    async (option) => {
      const fetchMock = serve(() => Response.json(record.person));
      const result = await runToolContract(orcidGetProfile, { orcid_id: RECORD_ID, ...option });

      expect(result.isError).toBeFalsy();
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${BASE}/${RECORD_ID}/person`]);
      expect(result.structuredContent).not.toHaveProperty('history');
      expect(textOf(result)).not.toContain('### Record History');
    },
  );

  it('returns every field the option-off call returns, unchanged, for the same person data', async () => {
    serve(() => Response.json(record.person));
    const off = await runToolContract(orcidGetProfile, { orcid_id: RECORD_ID });
    serve(() => Response.json(record));
    const on = await runToolContract(orcidGetProfile, {
      orcid_id: RECORD_ID,
      include_history: true,
    });

    const { history, ...shared } = on.structuredContent as Record<string, unknown>;
    expect(history).toBeDefined();
    expect(shared).toStrictEqual(off.structuredContent);
    expect(textOf(on).replace(`\n\n${HISTORY_BLOCK}`, '')).toBe(textOf(off));
  });

  it('leaves out every history field ORCID publishes as null or omits', async () => {
    serve(() =>
      Response.json({
        history: {
          'creation-method': null,
          'completion-date': null,
          'last-modified-date': { value: null },
          claimed: null,
          source: null,
          'deactivation-date': null,
          'verified-email': true,
          'verified-primary-email': null,
        },
        person: record.person,
      }),
    );
    const result = await runToolContract(orcidGetProfile, {
      orcid_id: RECORD_ID,
      include_history: true,
    });

    expect((result.structuredContent as { history?: unknown }).history).toStrictEqual({
      verifiedEmail: true,
    });
    expect(textOf(result)).toContain('### Record History\n**Verified Email:** true');
    for (const label of ['Created', 'Creation Method', 'Claimed', 'Verified Primary Email'])
      expect(textOf(result)).not.toContain(`**${label}:**`);
    expect(textOf(result)).not.toContain('**Last Modified:**');
  });

  it("follows a deprecated iD's redirect to the primary's /record and reports the primary iD", async () => {
    const DEPRECATED = '0000-0002-7759-8499';
    const PRIMARY = '0000-0001-8143-9338';
    const fetchMock = serve(() => {
      const response = Response.json(record);
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: `${BASE}/${PRIMARY}/record` },
      });
      return response;
    });
    const result = await runToolContract(orcidGetProfile, {
      orcid_id: DEPRECATED,
      include_history: true,
    });

    expect(result.isError).toBeFalsy();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${BASE}/${DEPRECATED}/record`]);
    const structured = result.structuredContent as {
      orcidId: string;
      notice?: string;
      history?: unknown;
    };
    expect(structured.orcidId).toBe(PRIMARY);
    expect(structured.history).toMatchObject({ creationMethod: 'MEMBER_REFERRED' });
    expect(structured.notice).toContain(`ORCID iD ${DEPRECATED} is deprecated`);
    expect(textOf(result)).toContain(`ORCID iD ${DEPRECATED} is deprecated`);
  });

  /** A failed call's envelope without its per-call request id. */
  function envelopeOf(result: Awaited<ReturnType<typeof runToolContract>>) {
    const { error } = result.structuredContent as {
      error: { code: number; message: string; data?: Record<string, unknown> };
    };
    const { requestId: _requestId, ...data } = error.data ?? {};
    return { code: error.code, message: error.message, data };
  }

  it('fails a /record 404 as profile_not_found, as a /person 404 fails', async () => {
    serve(() => new Response('', { status: 404, statusText: 'Not Found' }));
    const off = await runToolContract(orcidGetProfile, { orcid_id: RECORD_ID });
    const fetchMock = serve(() => new Response('', { status: 404, statusText: 'Not Found' }));
    const on = await runToolContract(orcidGetProfile, {
      orcid_id: RECORD_ID,
      include_history: true,
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${BASE}/${RECORD_ID}/record`]);
    expect(on.isError).toBe(true);
    expect(envelopeOf(on)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'profile_not_found' },
    });
    expect(envelopeOf(on)).toStrictEqual(envelopeOf(off));
    expect(textOf(on)).toContain('orcid_search_researchers');
  });

  it('keeps a /record 503 transient, retried and carrying Retry-After, as a /person 503 is', async () => {
    vi.useFakeTimers();
    const unavailable = () =>
      new Response('down', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Retry-After': '1' },
      });
    const run = async (input: Record<string, unknown>) => {
      const fetchMock = serve(unavailable);
      const pending = runToolContract(orcidGetProfile, { orcid_id: RECORD_ID, ...input });
      await vi.advanceTimersByTimeAsync(120_000);
      return { result: await pending, urls: fetchMock.mock.calls.map(([url]) => url) };
    };
    const off = await run({});
    const on = await run({ include_history: true });

    expect(on.urls).toEqual(Array(4).fill(`${BASE}/${RECORD_ID}/record`));
    expect(off.urls).toHaveLength(4);
    expect(envelopeOf(on.result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryAfter: '1' },
    });
    expect(envelopeOf(on.result)).toStrictEqual(envelopeOf(off.result));
  });
});
