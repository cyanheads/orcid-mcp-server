/**
 * @fileoverview Tool-contract coverage for the ORCID record tools — profile, works
 * summaries, and bulk work detail. Each case runs the production pipeline (input parse,
 * real handler, output parse, format, enrichment, error envelope) against a faked ORCID
 * upstream, for both the success envelope and every declared error reason.
 * @module tests/integration/record-contracts.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
