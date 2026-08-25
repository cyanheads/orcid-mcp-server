/**
 * @fileoverview Property-based fuzz coverage for the ORCID resource definitions.
 * Generated and adversarial URI params are driven through the real handlers against a
 * faked upstream. A thrown McpError — the rejection an invalid ORCID iD earns — is a
 * handled outcome; these assertions cover crashes, client-visible stack or path leaks,
 * and prototype pollution.
 * @module tests/fuzz/resources.fuzz.test
 */

import type { FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { fuzzResource } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { researcherProfileResource } from '@/mcp-server/resources/definitions/researcher-profile.resource.js';
import { researcherWorksResource } from '@/mcp-server/resources/definitions/researcher-works.resource.js';
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

const resources = [researcherProfileResource, researcherWorksResource];

describe('ORCID resource fuzz', () => {
  for (const definition of resources) {
    it(`keeps ${definition.name} safe across generated and adversarial params`, async () => {
      const report = await fuzzResource(definition, {
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
