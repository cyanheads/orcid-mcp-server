/**
 * @fileoverview Property-based fuzz coverage for every ORCID tool. Generated and
 * adversarial inputs are driven through the real handlers; the upstream is faked with a
 * catch-all empty JSON response so a run exercises validation and normalization rather
 * than the network. A thrown McpError is a handled outcome — these assertions cover
 * crashes, client-visible stack or path leaks, and prototype pollution.
 * @module tests/fuzz/tools.fuzz.test
 */

import type { FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orcidGetAffiliations } from '@/mcp-server/tools/definitions/get-affiliations.tool.js';
import { orcidGetFunding } from '@/mcp-server/tools/definitions/get-funding.tool.js';
import { orcidGetPeerReviews } from '@/mcp-server/tools/definitions/get-peer-reviews.tool.js';
import { orcidGetProfile } from '@/mcp-server/tools/definitions/get-profile.tool.js';
import { orcidGetResearchResources } from '@/mcp-server/tools/definitions/get-research-resources.tool.js';
import { orcidGetWorkDetail } from '@/mcp-server/tools/definitions/get-work-detail.tool.js';
import { orcidGetWorks } from '@/mcp-server/tools/definitions/get-works.tool.js';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';
import { initOrcidServiceForTests } from '../integration/orcid-api-fixtures.js';

/** Fixed seed keeps a failing run reproducible. */
const SEED = 20_260_824;

let http: FetchMockHarness;

beforeAll(() => {
  http = createFetchMock([{ match: () => true, respond: () => Response.json({}) }]);
  http.install();
  initOrcidServiceForTests();
});

afterAll(() => {
  http.restore();
});

const tools = [
  orcidSearchResearchers,
  orcidResolveResearcher,
  orcidGetProfile,
  orcidGetWorks,
  orcidGetWorkDetail,
  orcidGetAffiliations,
  orcidGetFunding,
  orcidGetPeerReviews,
  orcidGetResearchResources,
];

describe('ORCID tool fuzz', () => {
  for (const definition of tools) {
    it(`keeps ${definition.name} safe across generated and adversarial inputs`, async () => {
      const report = await fuzzTool(definition, {
        numRuns: 50,
        numAdversarial: 30,
        seed: SEED,
      });

      expect(report.crashes).toHaveLength(0);
      expect(report.leaks).toHaveLength(0);
      expect(report.prototypePollution).toBe(false);
    });
  }
});
