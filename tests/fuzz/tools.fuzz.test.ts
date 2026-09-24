/**
 * @fileoverview Property-based fuzz coverage for every ORCID tool. Generated and
 * adversarial inputs are driven through the real handlers; the upstream is faked with a
 * catch-all empty JSON response so a run exercises validation and normalization rather
 * than the network. A thrown McpError is a handled outcome — these assertions cover
 * crashes, client-visible stack or path leaks, and prototype pollution.
 * @module tests/fuzz/tools.fuzz.test
 */

import type { FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import fc from 'fast-check';
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

/**
 * The search input contract (#34, #42, #44): a call is accepted exactly when at least one
 * field is non-blank after trimming and DOI/PMID URL-prefix stripping, and an accepted call
 * sends a query with one clause per non-blank field — never `*:*`, never an empty clause.
 * Each generated value records whether it is blank, independently of the code under test.
 */
describe('orcid_search_researchers input contract', () => {
  type Gen = { value?: string; blank: boolean };

  const blankText = fc.constantFrom('', ' ', '   ', '\t', ' \n ');
  const maybe = (arb: fc.Arbitrary<Gen>) =>
    fc.option(arb, { nil: undefined }).map((g) => g ?? { blank: true });
  const text = (content: fc.Arbitrary<string>) =>
    maybe(
      fc.oneof(
        blankText.map((value) => ({ value, blank: true })),
        fc
          .tuple(blankText, content, blankText)
          .map(([pad, body, tail]) => ({ value: `${pad}${body}${tail}`, blank: false })),
      ),
    );
  const prefixed = (prefixes: string[], body: fc.Arbitrary<string>) =>
    maybe(
      fc
        .tuple(fc.constantFrom(...prefixes), fc.oneof(blankText, body))
        .map(([prefix, rest]) => ({ value: `${prefix}${rest}`, blank: rest.trim() === '' })),
    );

  const word = fc.stringMatching(/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ '"()&/-]{0,15}$/);
  const fields = {
    given_name: text(word),
    family_name: text(word),
    affiliation: text(word),
    keyword: text(word),
    ror_id: text(fc.stringMatching(/^https:\/\/ror\.org\/0[a-z0-9]{8}$/)),
    doi: prefixed(
      [
        '',
        'https://doi.org/',
        'http://dx.doi.org/',
        'doi.org/',
        'doi:',
        'DOI: ',
        'HTTPS://DOI.ORG/',
      ],
      fc.stringMatching(/^10\.\d{4,5}\/[A-Za-z0-9._;()-]{1,16}$/),
    ),
    pmid: prefixed(
      [
        '',
        'https://pubmed.ncbi.nlm.nih.gov/',
        'https://www.ncbi.nlm.nih.gov/pubmed/',
        'pubmed.ncbi.nlm.nih.gov/',
        'PMID: ',
      ],
      fc.stringMatching(/^[1-9]\d{0,8}\/?$/),
    ),
    grant_number: text(fc.stringMatching(/^[A-Z0-9][A-Za-z0-9/-]{0,15}$/)),
    query: text(fc.constantFrom('email:*berkeley.edu', 'given-names:Jo*', 'keyword:crispr')),
  };

  /** Field → the clause prefix its non-blank value compiles to. */
  const CLAUSE_PREFIX: Record<keyof typeof fields, string> = {
    given_name: 'given-names:"',
    family_name: 'family-name:"',
    affiliation: 'affiliation-org-name:"',
    keyword: 'keyword:"',
    ror_id: 'ror-org-id:"',
    doi: 'doi-self:"',
    pmid: 'pmid-self:"',
    grant_number: 'grant-numbers:"',
    query: '',
  };

  it('accepts exactly the calls with a non-blank field and compiles one clause per such field', async () => {
    const outcomes = { accepted: 0, rejected: 0 };
    await fc.assert(
      fc.asyncProperty(fc.record(fields), async (generated) => {
        const raw = Object.fromEntries(
          Object.entries(generated).flatMap(([key, g]) =>
            g.value === undefined ? [] : [[key, g.value]],
          ),
        );
        const nonBlank = (Object.keys(fields) as (keyof typeof fields)[]).filter(
          (key) => !generated[key].blank,
        );

        const parsed = orcidSearchResearchers.input.safeParse(raw);
        expect(parsed.success).toBe(nonBlank.length > 0);
        if (!parsed.success) {
          outcomes.rejected++;
          return;
        }
        outcomes.accepted++;

        const before = http.calls.length;
        const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
        await orcidSearchResearchers.handler(parsed.data, ctx);
        const q = new URL(http.calls[before]!.request.url).searchParams.get('q') ?? '';

        expect(q).not.toBe('');
        expect(q).not.toBe('*:*');
        expect(q.split(' AND ').filter((clause) => clause === '')).toEqual([]);
        for (const [key, prefix] of Object.entries(CLAUSE_PREFIX)) {
          if (!prefix) continue;
          expect(q.includes(prefix)).toBe(nonBlank.includes(key as keyof typeof fields));
        }
      }),
      { numRuns: 300, seed: SEED },
    );

    // Both sides of the contract were exercised, not just one.
    expect(outcomes.accepted).toBeGreaterThan(50);
    expect(outcomes.rejected).toBeGreaterThan(0);
  });
});
