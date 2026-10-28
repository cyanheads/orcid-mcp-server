/**
 * @fileoverview A deprecated (merged) ORCID iD resolves to its primary record on every record
 * tool and resource. Runs the real handlers and service against a faked upstream built from
 * captured ORCID responses: sections that redirect answer with a followed `Response`
 * (`redirected: true`, `url` on the primary iD), and the three endpoints that never redirect
 * answer as ORCID does for a deprecated iD — bulk works with an invalid-put-code error per code,
 * research resources with an empty group, and allocation detail with 404. Per-tool cases prove
 * the wiring (reported iD, the notice, the re-fetch paths); the resolution rules themselves are
 * tabled in `tests/services/orcid/orcid-service.test.ts`.
 * @module tests/integration/deprecated-id.int.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { researcherProfileResource } from '@/mcp-server/resources/definitions/researcher-profile.resource.js';
import { researcherWorksResource } from '@/mcp-server/resources/definitions/researcher-works.resource.js';
import { orcidGetAffiliations } from '@/mcp-server/tools/definitions/get-affiliations.tool.js';
import { orcidGetFunding } from '@/mcp-server/tools/definitions/get-funding.tool.js';
import { orcidGetPeerReviews } from '@/mcp-server/tools/definitions/get-peer-reviews.tool.js';
import { orcidGetProfile } from '@/mcp-server/tools/definitions/get-profile.tool.js';
import { orcidGetResearchResources } from '@/mcp-server/tools/definitions/get-research-resources.tool.js';
import { orcidGetWorkDetail } from '@/mcp-server/tools/definitions/get-work-detail.tool.js';
import { orcidGetWorks } from '@/mcp-server/tools/definitions/get-works.tool.js';
import captured from './fixtures/deprecated-id.json' with { type: 'json' };
import allocation from './fixtures/research-resource-detail.json' with { type: 'json' };
import {
  createOrcidFetchMock,
  initOrcidServiceForTests,
  MISSING_ID,
  RESEARCHER_ID,
  RESOLVED_PUT_CODE,
} from './orcid-api-fixtures.js';

/** Deprecated iD ORCID merged into {@link PRIMARY}; it 301s to the primary's same endpoint. */
const DEPRECATED = '0000-0002-7759-8499';
const PRIMARY = '0000-0001-8143-9338';
/** Put-code of a work on the primary record; the bulk endpoint rejects it under DEPRECATED. */
const WORK_PUT_CODE = 230577139;
/** Primary works group asserted through Scopus on the researcher's behalf. */
const SELF_ASSERTED_WORK = 168853534;
const FUNDING_PUT_CODE = 2329252;
const ALLOCATION_PUT_CODE = 5724;
/**
 * A second merge whose primary record holds none of what is asked of it (constructed,
 * checksum-valid iDs): the re-fetch under the primary iD comes back empty or not-found too.
 */
const BARE_DEPRECATED = '0000-0003-0000-0003';
const BARE_PRIMARY = '0009-0000-0000-0009';

const BASE = getServerConfig().orcidApiBaseUrl.replace(/\/$/, '');
const award = JSON.parse(
  readFileSync(new URL('./funding-award.fixture.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const NOTICE = `ORCID iD ${DEPRECATED} is deprecated: ORCID merged it into ${PRIMARY}, and this response reports that primary record. Use ${PRIMARY} in later calls.`;

/** A followed redirect as `fetch` returns it: the primary's body, flagged, at its final URL. */
function redirected(body: unknown, path: string, primary = PRIMARY): Response {
  const response = Response.json(body);
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: `${BASE}/${primary}/${path}` },
  });
  return response;
}

const notFound = () =>
  Response.json(
    {
      'response-code': 404,
      'developer-message': '404 Not Found: The resource was not found.',
      'error-code': 9016,
    },
    { status: 404 },
  );

/** One populated allocation summary on the primary record. */
const PRIMARY_RESOURCES = {
  group: [
    {
      'research-resource-summary': [
        {
          'put-code': ALLOCATION_PUT_CODE,
          proposal: { title: { title: { value: 'Delta GPU allocation' } } },
          source: {
            'source-orcid': { path: PRIMARY },
            'source-name': { value: 'Hossein Ali Khonakdar' },
          },
        },
      ],
    },
  ],
  path: `/${PRIMARY}/research-resources`,
};

let http: FetchMockHarness;

beforeAll(() => {
  http = createOrcidFetchMock();
  http.route(
    { match: `${BASE}/${DEPRECATED}/person`, respond: () => redirected(captured.person, 'person') },
    { match: `${BASE}/${DEPRECATED}/works`, respond: () => redirected(captured.works, 'works') },
    {
      match: `${BASE}/${DEPRECATED}/activities`,
      respond: () => redirected(captured.activities, 'activities'),
    },
    {
      match: `${BASE}/${DEPRECATED}/fundings`,
      respond: () => redirected({ group: [], path: `/${PRIMARY}/fundings` }, 'fundings'),
    },
    {
      match: `${BASE}/${DEPRECATED}/funding/${FUNDING_PUT_CODE}`,
      respond: () => redirected(award, `funding/${FUNDING_PUT_CODE}`),
    },
    {
      match: `${BASE}/${DEPRECATED}/peer-reviews`,
      respond: () => redirected(captured.peerReviews, 'peer-reviews'),
    },
    {
      match: `${BASE}/${DEPRECATED}/works/${WORK_PUT_CODE}`,
      respond: () => Response.json({ bulk: captured.bulkErrors.bulk.slice(0, 1) }),
    },
    {
      match: `${BASE}/${PRIMARY}/works/${WORK_PUT_CODE}`,
      respond: () => Response.json(captured.bulkWork),
    },
    {
      match: `${BASE}/${DEPRECATED}/research-resources`,
      respond: () => Response.json(captured.emptyResources),
    },
    {
      match: `${BASE}/${PRIMARY}/research-resources`,
      respond: () => Response.json(PRIMARY_RESOURCES),
    },
    {
      match: `${BASE}/${DEPRECATED}/research-resource/${ALLOCATION_PUT_CODE}`,
      respond: notFound,
    },
    {
      match: `${BASE}/${PRIMARY}/research-resource/${ALLOCATION_PUT_CODE}`,
      respond: () => Response.json(allocation),
    },
    {
      match: `${BASE}/${BARE_DEPRECATED}/person`,
      respond: () => redirected({ name: null }, 'person', BARE_PRIMARY),
    },
    ...[BARE_DEPRECATED, BARE_PRIMARY].flatMap((id) => [
      {
        match: `${BASE}/${id}/works/${WORK_PUT_CODE}`,
        respond: () => Response.json({ bulk: captured.bulkErrors.bulk.slice(0, 1) }),
      },
      {
        match: `${BASE}/${id}/research-resources`,
        respond: () => Response.json({ group: [], path: `/${id}/research-resources` }),
      },
      { match: `${BASE}/${id}/research-resource/${ALLOCATION_PUT_CODE}`, respond: notFound },
    ]),
  );
  http.install();
  initOrcidServiceForTests();
});

/** Index of the first upstream request the current test made. */
let firstCall = 0;
beforeEach(() => {
  firstCall = http.calls.length;
});

afterAll(() => http.restore());

/** Paths (after the API base) of the upstream requests the current test made, in order. */
const requested = () => http.calls.slice(firstCall).map((c) => c.request.url.slice(BASE.length));

const text = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

/** The reported iD on both surfaces and the deprecation notice on both. */
function expectPrimary(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    orcidId: PRIMARY,
    orcidUri: `https://orcid.org/${PRIMARY}`,
  });
  expect(String((result.structuredContent as { notice?: string }).notice)).toContain(NOTICE);
  expect(text(result)).toContain(`https://orcid.org/${PRIMARY}`);
  expect(text(result)).not.toContain(`https://orcid.org/${DEPRECATED}`);
  expect(text(result)).toContain(`> ${NOTICE}`);
}

describe('a deprecated ORCID iD on the redirecting sections', () => {
  it('orcid_get_profile reports the primary record', async () => {
    const result = await runToolContract(orcidGetProfile, { orcid_id: DEPRECATED });
    expectPrimary(result);
    expect(result.structuredContent).toMatchObject({ familyName: 'Khonakdar' });
    expect(requested()).toEqual([`/${DEPRECATED}/person`]);
  });

  it('orcid_get_works computes selfAsserted against the primary iD', async () => {
    const result = await runToolContract(orcidGetWorks, { orcid_id: DEPRECATED });
    expectPrimary(result);
    const works = (
      result.structuredContent as {
        works: { putCode: number; sources: { selfAsserted: boolean }[] }[];
      }
    ).works;
    expect(works.find((w) => w.putCode === SELF_ASSERTED_WORK)?.sources).toEqual([
      expect.objectContaining({ selfAsserted: true }),
    ]);
    expect(works.find((w) => w.putCode === WORK_PUT_CODE)?.sources).toEqual([
      expect.objectContaining({ name: 'Crossref', selfAsserted: false }),
    ]);
    expect(text(result)).toContain('(self-asserted)');
    expect(requested()).toEqual([`/${DEPRECATED}/works`]);
  });

  it('orcid_get_affiliations computes selfAsserted against the primary iD', async () => {
    const result = await runToolContract(orcidGetAffiliations, {
      orcid_id: DEPRECATED,
      types: ['all'],
    });
    expectPrimary(result);
    const affiliations = (
      result.structuredContent as { affiliations: { sources: { selfAsserted: boolean }[] }[] }
    ).affiliations;
    expect(affiliations.length).toBeGreaterThan(0);
    for (const affiliation of affiliations)
      expect(affiliation.sources).toEqual([expect.objectContaining({ selfAsserted: true })]);
  });

  it('orcid_get_funding composes the notice with the empty-funding notice', async () => {
    const result = await runToolContract(orcidGetFunding, { orcid_id: DEPRECATED });
    expectPrimary(result);
    expect(result.structuredContent).toMatchObject({ fundingCount: 0 });
    expect((result.structuredContent as { notice: string }).notice).toBe(
      `${NOTICE} No funding records found. Funding reaches ORCID from the researcher or from member organizations, and most records carry none. Absence does not imply no funding.`,
    );
  });

  it('orcid_get_funding with put_code reports the primary record', async () => {
    const result = await runToolContract(orcidGetFunding, {
      orcid_id: DEPRECATED,
      put_code: FUNDING_PUT_CODE,
    });
    expectPrimary(result);
    expect(result.structuredContent).toMatchObject({
      view: 'detail',
      funding: [{ putCode: FUNDING_PUT_CODE }],
    });
  });

  it('orcid_get_peer_reviews reports the primary record', async () => {
    const result = await runToolContract(orcidGetPeerReviews, { orcid_id: DEPRECATED });
    expectPrimary(result);
    expect((result.structuredContent as { reviewCount: number }).reviewCount).toBeGreaterThan(0);
  });
});

describe('a deprecated ORCID iD on the endpoints that never redirect', () => {
  it('orcid_get_work_detail re-fetches under the primary iD when no work resolves', async () => {
    const result = await runToolContract(orcidGetWorkDetail, {
      orcid_id: DEPRECATED,
      put_codes: [WORK_PUT_CODE],
    });
    expectPrimary(result);
    expect(result.structuredContent).toMatchObject({
      works: [{ putCode: WORK_PUT_CODE }],
      errors: [],
    });
    expect(requested()).toEqual([
      `/${DEPRECATED}/works/${WORK_PUT_CODE}`,
      `/${DEPRECATED}/person`,
      `/${PRIMARY}/works/${WORK_PUT_CODE}`,
    ]);
  });

  it('orcid_get_research_resources re-fetches the summary under the primary iD', async () => {
    const result = await runToolContract(orcidGetResearchResources, { orcid_id: DEPRECATED });
    expectPrimary(result);
    expect(result.structuredContent).toMatchObject({
      resourceCount: 1,
      resources: [{ putCode: ALLOCATION_PUT_CODE, sources: [{ selfAsserted: true }] }],
    });
    expect((result.structuredContent as { notice: string }).notice).toBe(NOTICE);
    expect(requested()).toEqual([
      `/${DEPRECATED}/research-resources`,
      `/${DEPRECATED}/person`,
      `/${PRIMARY}/research-resources`,
    ]);
  });

  it('orcid_get_research_resources re-fetches a put_code under the primary iD', async () => {
    const result = await runToolContract(orcidGetResearchResources, {
      orcid_id: DEPRECATED,
      put_code: ALLOCATION_PUT_CODE,
    });
    expectPrimary(result);
    expect(result.structuredContent).toMatchObject({
      view: 'detail',
      resources: [{ putCode: ALLOCATION_PUT_CODE }],
    });
    expect(requested()).toEqual([
      `/${DEPRECATED}/research-resource/${ALLOCATION_PUT_CODE}`,
      `/${DEPRECATED}/person`,
      `/${PRIMARY}/research-resource/${ALLOCATION_PUT_CODE}`,
    ]);
  });
});

describe('a deprecated ORCID iD whose primary record lacks what was asked', () => {
  const notice = `ORCID iD ${BARE_DEPRECATED} is deprecated: ORCID merged it into ${BARE_PRIMARY}, and this response reports that primary record. Use ${BARE_PRIMARY} in later calls.`;

  it('orcid_get_work_detail re-fetches once and keeps the primary record errors', async () => {
    const result = await runToolContract(orcidGetWorkDetail, {
      orcid_id: BARE_DEPRECATED,
      put_codes: [WORK_PUT_CODE],
    });
    expect(result.structuredContent).toMatchObject({
      orcidId: BARE_PRIMARY,
      works: [],
      errors: [{ putCode: WORK_PUT_CODE }],
      notice,
    });
    expect(requested()).toEqual([
      `/${BARE_DEPRECATED}/works/${WORK_PUT_CODE}`,
      `/${BARE_DEPRECATED}/person`,
      `/${BARE_PRIMARY}/works/${WORK_PUT_CODE}`,
    ]);
  });

  it('orcid_get_research_resources composes the notice with the empty-section notice', async () => {
    const result = await runToolContract(orcidGetResearchResources, { orcid_id: BARE_DEPRECATED });
    expect(result.structuredContent).toMatchObject({ orcidId: BARE_PRIMARY, resourceCount: 0 });
    const composed = (result.structuredContent as { notice: string }).notice;
    expect(composed.startsWith(`${notice} No research resources found.`)).toBe(true);
    expect(text(result)).toContain(`> ${notice} No research resources found.`);
    expect(requested()).toEqual([
      `/${BARE_DEPRECATED}/research-resources`,
      `/${BARE_DEPRECATED}/person`,
      `/${BARE_PRIMARY}/research-resources`,
    ]);
  });

  it('orcid_get_research_resources fails a put_code the primary lacks as resource_not_found', async () => {
    const result = await runToolContract(orcidGetResearchResources, {
      orcid_id: BARE_DEPRECATED,
      put_code: ALLOCATION_PUT_CODE,
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'resource_not_found' } },
    });
    expect(requested()).toEqual([
      `/${BARE_DEPRECATED}/research-resource/${ALLOCATION_PUT_CODE}`,
      `/${BARE_DEPRECATED}/person`,
      `/${BARE_PRIMARY}/research-resource/${ALLOCATION_PUT_CODE}`,
    ]);
  });

  it('orcid_get_works composes the notice with the limit cap and the past-end notice, in that order', async () => {
    const result = await runToolContract(orcidGetWorks, {
      orcid_id: DEPRECATED,
      work_types: ['journal-article'],
      limit: 5000,
      offset: 10,
    });
    expect(result.structuredContent).toMatchObject({
      orcidId: PRIMARY,
      workCount: 2,
      matchedCount: 2,
      returnedCount: 0,
      truncated: false,
      works: [],
      appliedFilters: { workTypes: ['journal-article'] },
      notice: `${NOTICE} Requested limit 5000; effective cap 1000 works. Offset 10 exceeds matchedCount (2). Reduce offset to page through the works.`,
    });
  });

  it('orcid_get_works composes the notice with the limit cap and the no-match filter notice', async () => {
    const result = await runToolContract(orcidGetWorks, {
      orcid_id: DEPRECATED,
      work_types: ['preprint'],
      year_from: 2025,
      limit: 5000,
    });
    const notice = `${NOTICE} Requested limit 5000; effective cap 1000 works. No works match the filters (work_types: preprint; year_from: 2025) among the record's 2 works. Drop or widen a filter.`;
    expect(result.structuredContent).toMatchObject({
      orcidId: PRIMARY,
      workCount: 2,
      matchedCount: 0,
      returnedCount: 0,
      truncated: false,
      notice,
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain(`> ${notice}`);
  });

  it('orcid_get_peer_reviews composes the notice with the limit cap and the past-end notice', async () => {
    const result = await runToolContract(orcidGetPeerReviews, {
      orcid_id: DEPRECATED,
      limit: 5000,
      offset: 1000,
    });
    const { totalCount } = result.structuredContent as { totalCount: number };
    expect(totalCount).toBeGreaterThan(0);
    expect(result.structuredContent).toMatchObject({
      orcidId: PRIMARY,
      reviewCount: 0,
      truncated: false,
      notice: `${NOTICE} Requested limit 5000; effective cap 1000 reviews. Offset 1000 exceeds totalCount (${totalCount}). Reduce offset to page through the reviews.`,
    });
  });
});

describe('a deprecated ORCID iD on the resources', () => {
  it('orcid://researcher/{orcid_id}/profile reports the primary iD', async () => {
    const ctx = createMockContext({ errors: researcherProfileResource.errors });
    const params = researcherProfileResource.params!.parse({ orcid_id: DEPRECATED });
    expect(await researcherProfileResource.handler(params, ctx)).toMatchObject({
      orcidId: PRIMARY,
      orcidUri: `https://orcid.org/${PRIMARY}`,
      familyName: 'Khonakdar',
    });
  });

  it('orcid://researcher/{orcid_id}/works reports the primary iD', async () => {
    const ctx = createMockContext({ errors: researcherWorksResource.errors });
    const params = researcherWorksResource.params!.parse({ orcid_id: DEPRECATED });
    expect(await researcherWorksResource.handler(params, ctx)).toMatchObject({
      orcidId: PRIMARY,
      orcidUri: `https://orcid.org/${PRIMARY}`,
      workCount: 2,
    });
  });
});

describe('an iD that is not deprecated', () => {
  it.each([
    ['orcid_get_profile', orcidGetProfile, {}, ['/person']],
    ['orcid_get_works', orcidGetWorks, {}, ['/works']],
    ['orcid_get_affiliations', orcidGetAffiliations, {}, ['/activities']],
    ['orcid_get_funding', orcidGetFunding, {}, ['/fundings']],
    ['orcid_get_peer_reviews', orcidGetPeerReviews, {}, ['/peer-reviews']],
    ['orcid_get_research_resources', orcidGetResearchResources, {}, ['/research-resources']],
    [
      'orcid_get_work_detail',
      orcidGetWorkDetail,
      { put_codes: [RESOLVED_PUT_CODE] },
      [`/works/${RESOLVED_PUT_CODE}`],
    ],
  ] as const)(
    '%s on a populated record makes exactly one request and adds no deprecation notice',
    async (_name, definition, extra, paths) => {
      const result = await runToolContract(definition as typeof orcidGetProfile, {
        orcid_id: RESEARCHER_ID,
        ...extra,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ orcidId: RESEARCHER_ID });
      expect(JSON.stringify(result)).not.toContain('is deprecated');
      expect(requested()).toEqual(paths.map((p) => `/${RESEARCHER_ID}${p}`));
    },
  );

  it('a non-existent iD still fails profile_not_found', async () => {
    const result = await runToolContract(orcidGetProfile, { orcid_id: MISSING_ID });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'profile_not_found' } },
    });
  });

  it('a non-existent iD on research resources still fails profile_not_found after one probe', async () => {
    const result = await runToolContract(orcidGetResearchResources, { orcid_id: MISSING_ID });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'profile_not_found' } },
    });
    expect(requested()).toEqual([`/${MISSING_ID}/research-resources`, `/${MISSING_ID}/person`]);
  });
});
