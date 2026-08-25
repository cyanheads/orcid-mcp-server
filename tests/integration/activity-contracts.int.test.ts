/**
 * @fileoverview Tool-contract coverage for the ORCID activity-section tools —
 * affiliations, funding, peer reviews, and research resources. Each case runs the
 * production pipeline (input parse, real handler, output parse, format, enrichment,
 * error envelope) against a faked ORCID upstream, for both the success envelope and
 * every declared error reason.
 * @module tests/integration/activity-contracts.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { afterAll, beforeAll, expect } from 'vitest';
import { orcidGetAffiliations } from '@/mcp-server/tools/definitions/get-affiliations.tool.js';
import { orcidGetFunding } from '@/mcp-server/tools/definitions/get-funding.tool.js';
import { orcidGetPeerReviews } from '@/mcp-server/tools/definitions/get-peer-reviews.tool.js';
import { orcidGetResearchResources } from '@/mcp-server/tools/definitions/get-research-resources.tool.js';
import {
  createOrcidFetchMock,
  initOrcidServiceForTests,
  MISSING_ID,
  RESEARCHER_ID,
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

toolContractSuite(orcidGetAffiliations, {
  success: [
    {
      name: 'returns the default employment and education sections',
      input: { orcid_id: RESEARCHER_ID },
      expected: { affiliationCount: 2, requestedTypes: ['employment', 'education'] },
      assert: (result) => {
        const structured = result.structuredContent as {
          affiliations: {
            type: string;
            role?: string;
            organization?: { disambiguatedId?: string };
          }[];
        };
        expect(structured.affiliations[0]).toMatchObject({ type: 'employment', role: 'Professor' });
        expect(structured.affiliations[0]?.organization?.disambiguatedId).toBe(
          'https://ror.org/01an7q238',
        );
        // Sparse upstream education entry: organization name only, no invented dates.
        expect(structured.affiliations[1]).toEqual({
          type: 'education',
          organization: { name: 'Harvard Medical School' },
        });
      },
    },
    {
      name: 'expands the all selector across every section',
      input: { orcid_id: RESEARCHER_ID, types: ['all'] },
      expected: { affiliationCount: 2, requestedTypes: ['all'] },
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

toolContractSuite(orcidGetFunding, {
  success: [
    {
      name: 'returns funding records with grant numbers',
      input: { orcid_id: RESEARCHER_ID },
      expected: { fundingCount: 1 },
      assert: (result) => {
        const structured = result.structuredContent as {
          funding: { grantNumbers: string[]; funder?: { name?: string } }[];
        };
        expect(structured.funding[0]?.grantNumbers).toEqual(['R01GM000000']);
        expect(structured.funding[0]?.funder?.name).toBe('National Institutes of Health');
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

toolContractSuite(orcidGetPeerReviews, {
  success: [
    {
      name: 'returns reviews with the ISSN of their journal group',
      input: { orcid_id: RESEARCHER_ID },
      expected: { reviewCount: 1 },
      assert: (result) => {
        const structured = result.structuredContent as {
          peerReviews: { groupIssn?: string; reviewerRole?: string }[];
        };
        expect(structured.peerReviews[0]).toMatchObject({
          groupIssn: '1476-4687',
          reviewerRole: 'reviewer',
        });
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

toolContractSuite(orcidGetResearchResources, {
  success: [
    {
      name: 'returns hosted research resources',
      input: { orcid_id: RESEARCHER_ID },
      expected: { resourceCount: 1 },
      assert: (result) => {
        const structured = result.structuredContent as {
          resources: { putCode: number; title?: string; hostOrganization?: { name?: string } }[];
        };
        expect(structured.resources[0]).toMatchObject({
          putCode: 7001,
          title: 'ACCESS compute allocation',
        });
        expect(structured.resources[0]?.hostOrganization?.name).toBe(
          'Pittsburgh Supercomputing Center',
        );
      },
    },
  ],
  errors: [
    {
      // /research-resources answers 200 with an empty group for an unknown iD, so the
      // handler confirms the record through /person before reporting the contract reason.
      name: 'reports an ORCID iD with no registered researcher',
      input: { orcid_id: MISSING_ID },
      code: JsonRpcErrorCode.NotFound,
      reason: 'profile_not_found',
    },
  ],
});
