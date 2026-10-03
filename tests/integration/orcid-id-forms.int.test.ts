/**
 * @fileoverview ORCID iD caller forms end to end (#57): every accepted `orcid_id` form —
 * lowercase check digit, scheme-less, `www.` host, trailing slash, surrounding
 * whitespace — runs the real schema, handler, service, and normalizer against a faked
 * upstream that answers only the canonical uppercase-`X` path, so a form that reached the
 * API un-normalized fails the request. Resources take the bare iD in either case.
 * @module tests/integration/orcid-id-forms.int.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { initOrcidServiceForTests } from './orcid-api-fixtures.js';

const CANONICAL_ID = '0000-0001-9161-999X';
const BASE = getServerConfig().orcidApiBaseUrl.replace(/\/$/, '');

const PERSON = {
  name: { 'given-names': { value: 'Jennifer' }, 'family-name': { value: 'Doudna' } },
};
const WORKS = {
  group: [
    {
      'work-summary': [
        {
          'put-code': 1,
          title: { title: { value: 'A programmable dual-RNA-guided DNA endonuclease' } },
          type: 'journal-article',
        },
      ],
    },
  ],
};

let http: FetchMockHarness;

beforeAll(() => {
  // Only the canonical path routes; any other request throws, failing the call.
  http = createFetchMock([
    {
      method: 'GET',
      match: `${BASE}/${CANONICAL_ID}/person`,
      respond: () => Response.json(PERSON),
    },
    { method: 'GET', match: `${BASE}/${CANONICAL_ID}/works`, respond: () => Response.json(WORKS) },
    {
      method: 'GET',
      match: (request) => request.url.startsWith(`${BASE}/${CANONICAL_ID}/works/`),
      respond: () => Response.json({ bulk: [] }),
    },
    {
      method: 'GET',
      match: (request) =>
        ['activities', 'fundings', 'peer-reviews', 'research-resources'].some(
          (section) => request.url === `${BASE}/${CANONICAL_ID}/${section}`,
        ),
      respond: () => Response.json({}),
    },
  ]);
  http.install();
  initOrcidServiceForTests();
});

afterAll(() => {
  http.restore();
});

/** Every accepted tool form the advertised JSON Schema pattern must also admit. */
const PATTERN_FORMS = [
  '0000-0001-9161-999x',
  'orcid.org/0000-0001-9161-999X',
  'https://www.orcid.org/0000-0001-9161-999X',
  'https://orcid.org/0000-0001-9161-999X/',
  // Regression: these forms resolve today and keep resolving.
  CANONICAL_ID,
  'https://orcid.org/0000-0001-9161-999X',
  'http://orcid.org/0000-0001-9161-999X',
];

describe('orcid_get_profile — orcid_id caller forms (#57)', () => {
  it.each([...PATTERN_FORMS, ' 0000-0001-9161-999X '])(
    'resolves %j to the canonical iD over the uppercase-X upstream path',
    async (orcidId) => {
      const before = http.calls.length;
      const result = await runToolContract(orcidGetProfile, { orcid_id: orcidId });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        orcidId: CANONICAL_ID,
        orcidUri: `https://orcid.org/${CANONICAL_ID}`,
        familyName: 'Doudna',
      });
      const requests = http.calls.slice(before).map((call) => new URL(call.request.url).pathname);
      expect(requests).toEqual([new URL(`${BASE}/${CANONICAL_ID}/person`).pathname]);
    },
  );

  it.each(['0000-0000-0000-0000', '0000-0002-1825-009x'])(
    'rejects %j with only the checksum message, before any upstream call',
    async (orcidId) => {
      const before = http.calls.length;
      const result = await runToolContract(orcidGetProfile, { orcid_id: orcidId });

      expect(result.isError).toBe(true);
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      expect(text).toContain(
        'The ORCID iD is invalid — its ISO 7064 check digit does not match. Verify the iD and try again.',
      );
      expect(text).not.toContain('Must be a valid ORCID iD');
      expect(http.calls.length).toBe(before);
    },
  );

  it.each(['not-an-orcid', '', '   ', '000000019161999X', 'HTTPS://ORCID.ORG/0000-0001-9161-999X'])(
    'rejects %j with only the shape message, before any upstream call',
    async (orcidId) => {
      const before = http.calls.length;
      const result = await runToolContract(orcidGetProfile, { orcid_id: orcidId });

      expect(result.isError).toBe(true);
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      expect(text).toContain(
        'Must be a valid ORCID iD (e.g. 0000-0001-2345-6789) or full ORCID URI.',
      );
      expect(text).not.toContain('ISO 7064');
      expect(http.calls.length).toBe(before);
    },
  );

  it('advertises an inputSchema pattern that admits every accepted form', () => {
    const inputSchema = z.toJSONSchema(orcidGetProfile.input) as unknown as {
      properties: { orcid_id: { pattern: string } };
    };
    const pattern = new RegExp(inputSchema.properties.orcid_id.pattern);
    for (const form of PATTERN_FORMS) expect(pattern.test(form)).toBe(true);
  });
});

describe('every orcid_id tool — canonical upstream path (#57)', () => {
  const tools = [
    { definition: orcidGetProfile, extra: {} },
    { definition: orcidGetWorks, extra: {} },
    { definition: orcidGetWorkDetail, extra: { put_codes: [1] } },
    { definition: orcidGetAffiliations, extra: {} },
    { definition: orcidGetFunding, extra: {} },
    { definition: orcidGetPeerReviews, extra: {} },
    { definition: orcidGetResearchResources, extra: {} },
  ];

  for (const { definition, extra } of tools) {
    it.each([
      '0000-0001-9161-999x',
      CANONICAL_ID,
      'https://orcid.org/0000-0001-9161-999X',
      'http://orcid.org/0000-0001-9161-999X',
    ])(`${definition.name} sends %j as the uppercase-X iD`, async (orcidId) => {
      const before = http.calls.length;
      const result = await runToolContract(definition, { orcid_id: orcidId, ...extra });

      expect(result.isError).toBeFalsy();
      const urls = http.calls.slice(before).map((call) => call.request.url);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url.startsWith(`${BASE}/${CANONICAL_ID}/`)).toBe(true);
    });
  }
});

describe('researcher resources — bare orcid_id in either check-digit case (#57)', () => {
  it('resolves orcid://researcher/0000-0001-9161-999x/profile over the uppercase-X path', async () => {
    const params = researcherProfileResource.params!.parse({ orcid_id: '0000-0001-9161-999x' });
    const ctx = createMockContext({ errors: researcherProfileResource.errors });
    const result = await researcherProfileResource.handler(params, ctx);

    expect(result).toMatchObject({ orcidId: CANONICAL_ID, familyName: 'Doudna' });
  });

  it('resolves orcid://researcher/0000-0001-9161-999x/works over the uppercase-X path', async () => {
    const params = researcherWorksResource.params!.parse({ orcid_id: '0000-0001-9161-999x' });
    const ctx = createMockContext({ errors: researcherWorksResource.errors });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result).toMatchObject({ orcidId: CANONICAL_ID, workCount: 1 });
  });

  it('still rejects a checksum-invalid bare iD with InvalidParams, before any upstream call', async () => {
    const before = http.calls.length;
    const params = researcherProfileResource.params!.parse({ orcid_id: '0000-0000-0000-0000' });
    const err = await Promise.resolve(
      researcherProfileResource.handler(
        params,
        createMockContext({ errors: researcherProfileResource.errors }),
      ),
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      message:
        'The ORCID iD 0000-0000-0000-0000 is invalid — its ISO 7064 check digit does not match. Verify the iD and try again.',
      data: { reason: 'invalid_orcid_id' },
    });
    expect(http.calls.length).toBe(before);
  });
});
