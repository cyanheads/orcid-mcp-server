/**
 * @fileoverview Tool-contract coverage for the ORCID record tools — profile, works
 * summaries, and bulk work detail. Each case runs the production pipeline (input parse,
 * real handler, output parse, format, enrichment, error envelope) against a faked ORCID
 * upstream, for both the success envelope and every declared error reason.
 * @module tests/integration/record-contracts.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { afterAll, beforeAll, expect } from 'vitest';
import { orcidGetProfile } from '@/mcp-server/tools/definitions/get-profile.tool.js';
import { orcidGetWorkDetail } from '@/mcp-server/tools/definitions/get-work-detail.tool.js';
import { orcidGetWorks } from '@/mcp-server/tools/definitions/get-works.tool.js';
import {
  BULK_FAILURE_ID,
  createOrcidFetchMock,
  initOrcidServiceForTests,
  MISSING_ID,
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
      },
      assert: (result) => {
        const structured = result.structuredContent as {
          externalIdentifiers: { type: string; value: string }[];
        };
        expect(structured.externalIdentifiers[0]).toMatchObject({
          type: 'Scopus Author ID',
          value: '6603342255',
        });
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
        expect(structured.errors[0]?.putCode).toBe(UNRESOLVED_PUT_CODE);
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
  ],
});
