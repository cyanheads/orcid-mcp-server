/**
 * @fileoverview Tool-contract coverage for the two ORCID search tools. Each case runs
 * the production pipeline — input parse, real handler, output parse, format, enrichment,
 * error envelope — against a faked ORCID upstream, for both the success envelope and
 * every reason the tool declares in `errors[]`.
 * @module tests/integration/search-contracts.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { FetchMockHarness, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { afterAll, beforeAll, expect } from 'vitest';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';
import {
  BROKEN_QUERY_MARKER,
  createOrcidFetchMock,
  initOrcidServiceForTests,
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

toolContractSuite(orcidSearchResearchers, {
  success: [
    {
      name: 'returns matches with pagination and enrichment',
      input: { given_name: 'Jennifer', rows: 2 },
      expected: { rows: 2, start: 0 },
      assert: (result) => {
        const structured = result.structuredContent as {
          results: { orcidId: string }[];
          numFound: number;
          effectiveQuery: string;
          truncated: boolean;
        };
        expect(structured.results[0]?.orcidId).toBe(RESEARCHER_ID);
        expect(structured.effectiveQuery).toBe('given-names:"Jennifer"');
        expect(structured.numFound).toBe(2);
        expect(structured.truncated).toBe(false);
      },
    },
  ],
  errors: [
    {
      name: 'reports a query ORCID rejects',
      input: { given_name: BROKEN_QUERY_MARKER },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'query_failed',
    },
  ],
});

toolContractSuite(orcidResolveResearcher, {
  success: [
    ...[21, 10_000].map((rows) => ({
      name: `caps resolver rows ${rows} through the production contract`,
      input: { name: 'Jennifer Doudna', rows },
      assert: (result: Awaited<ReturnType<typeof runToolContract>>) => {
        expect(result.structuredContent).toMatchObject({
          totalFound: 2,
          notice: expect.stringContaining(String(rows)),
          candidates: [{ orcidId: RESEARCHER_ID }, expect.anything()],
        });
        const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        expect(text).toContain(String(rows));
        expect(text).toContain('20');
        const request = http.calls.at(-1)!;
        expect(new URL(request.request.url).searchParams.get('rows')).toBe('20');
      },
    })),
    {
      name: 'ranks candidates with transparent disambiguation signals',
      input: { name: 'Jennifer Doudna', affiliation: 'University of California, Berkeley' },
      assert: (result) => {
        const structured = result.structuredContent as {
          candidates: { orcidId: string; nameMatchType: string; institutionOverlap: boolean }[];
          primaryTotalFound: number;
        };
        expect(structured.candidates[0]).toMatchObject({
          orcidId: RESEARCHER_ID,
          nameMatchType: 'exact',
          institutionOverlap: true,
        });
        expect(structured.primaryTotalFound).toBe(2);
      },
    },
  ],
  errors: [
    {
      name: 'reports a disambiguation query ORCID rejects',
      input: { name: BROKEN_QUERY_MARKER },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'query_failed',
    },
  ],
});
