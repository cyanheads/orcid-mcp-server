/**
 * @fileoverview Property-based fuzz coverage for every ORCID tool. Generated and
 * adversarial inputs are driven through the real handlers; the upstream is faked — a
 * generated works list and bulk-works payload, and a catch-all empty JSON response for
 * every other route — so a run exercises validation and normalization rather than the
 * network. A thrown McpError is a handled outcome — these assertions cover crashes,
 * client-visible stack or path leaks, and prototype pollution, plus the search input
 * contract and the works response byte budget.
 * @module tests/fuzz/tools.fuzz.test
 */

import type { FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
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

/** Works list size the faked `/works` route serves for every ORCID iD. */
const GENERATED_WORK_COUNT = 300;

/** Structured-output ceiling the works tools hold every multi-record response to (#36). */
const RESPONSE_BYTE_BUDGET = 64_000;

/** Record size varies with the put-code, from a bare record to ~9 KB of abstract. */
const sizeFor = (code: number) => (code * 7_919) % 9_000;

/**
 * A work summary list sized like a prolific live record: titles and journals vary in
 * length with the put-code, and some carry the inline markup ORCID relays.
 */
function generatedWorks() {
  return {
    group: Array.from({ length: GENERATED_WORK_COUNT }, (_, i) => ({
      'work-summary': [
        {
          'put-code': i + 1,
          title: {
            title: { value: `Work ${i} <i>in vivo</i> ${'t'.repeat(sizeFor(i + 1) / 20)}` },
          },
          type: 'journal-article',
          'journal-title': { value: `Journal ${'j'.repeat(i % 80)}` },
          'external-ids': {
            'external-id': [{ 'external-id-type': 'doi', 'external-id-value': `10.1/${i}` }],
          },
        },
      ],
    })),
  };
}

/**
 * Mirror the live bulk endpoint for the requested put-codes: one work per distinct code in
 * ascending order, an invalid-put-code error for codes divisible by 17, then an
 * invalid-put-code error for every repeated occurrence of a code (the live endpoint's answer
 * to a repeat, which the tool must never send).
 */
function generatedBulk(url: string) {
  const codes = (url.split('/works/')[1] ?? '').split(',').map(Number);
  const distinct = [...new Set(codes)].sort((a, b) => a - b);
  const invalid = (code: number) =>
    `400 Bad Request: The put code provided is not valid. Full validation error: '${code}' is not a valid put code`;
  return {
    bulk: [
      ...distinct
        .filter((code) => code % 17 !== 0)
        .map((code) => ({
          work: {
            'put-code': code,
            title: { title: { value: `Work ${code}` } },
            'short-description': `<h4>Abstract</h4>${'a'.repeat(sizeFor(code))}`,
          },
        })),
      ...distinct
        .filter((code) => code % 17 === 0)
        .map((code) => ({ error: { 'developer-message': invalid(code) } })),
      ...codes
        .filter((code, i) => codes.indexOf(code) !== i)
        .map((code) => ({ error: { 'developer-message': invalid(code) } })),
    ],
  };
}

let http: FetchMockHarness;

beforeAll(() => {
  http = createFetchMock([
    {
      match: (request) => request.url.includes('/works/'),
      respond: (request) => Response.json(generatedBulk(request.url)),
    },
    {
      match: (request) => request.url.endsWith('/works'),
      respond: () => Response.json(generatedWorks()),
    },
    { match: () => true, respond: () => Response.json({}) },
  ]);
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

/**
 * The response byte budget (#36): for any page or batch request, a multi-record response
 * stays within the budget, and the continuation it reports — nextOffset for works,
 * deferredPutCodes for work detail — accounts for every record exactly once.
 */
describe('works response byte budget', () => {
  const ORCID = '0000-0002-1825-0097';
  const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  /** What a client receives: the text surface plus structuredContent, capped at 130,000 B. */
  const withinCombinedCeiling = (result: Awaited<ReturnType<typeof runToolContract>>) => {
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    return bytesOf(result.structuredContent) + Buffer.byteLength(text) < 130_000;
  };

  it('orcid_get_works: every page fits the budget and continues exactly where it stopped', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 0, max: GENERATED_WORK_COUNT + 20 }),
        fc.boolean(),
        async (limit, offset, includeIds) => {
          const result = await runToolContract(orcidGetWorks, {
            orcid_id: ORCID,
            limit,
            offset,
            include_external_ids: includeIds,
          });
          const page = result.structuredContent as {
            workCount: number;
            returnedCount: number;
            nextOffset?: number;
            truncated: boolean;
            works: { title?: string }[];
          };

          if (page.returnedCount > 1) {
            expect(bytesOf(result.structuredContent)).toBeLessThanOrEqual(RESPONSE_BYTE_BUDGET);
            expect(withinCombinedCeiling(result)).toBe(true);
          }
          expect(page.workCount).toBe(GENERATED_WORK_COUNT);
          expect(page.returnedCount).toBe(page.works.length);
          expect(page.returnedCount).toBeLessThanOrEqual(limit);
          if (offset < GENERATED_WORK_COUNT) expect(page.returnedCount).toBeGreaterThan(0);
          const end = offset + page.returnedCount;
          expect(page.truncated).toBe(end < GENERATED_WORK_COUNT);
          expect(page.nextOffset).toBe(end < GENERATED_WORK_COUNT ? end : undefined);
          for (const work of page.works) expect(work.title).not.toMatch(/<\/?i>/);
        },
      ),
      { numRuns: 150, seed: SEED },
    );
  });

  it('orcid_get_work_detail: every batch fits the budget and settles each put-code exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Codes drawn from a narrow range, so most batches repeat some put-codes.
        fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 100 }),
        async (putCodes) => {
          const result = await runToolContract(orcidGetWorkDetail, {
            orcid_id: ORCID,
            put_codes: putCodes,
          });
          const batch = result.structuredContent as {
            works: { putCode: number; abstract?: string }[];
            errors: { putCode?: number }[];
            deferredPutCodes?: number[];
            notice?: string;
          };

          if (batch.works.length + batch.errors.length > 1) {
            expect(bytesOf(result.structuredContent)).toBeLessThanOrEqual(RESPONSE_BYTE_BUDGET);
            expect(withinCombinedCeiling(result)).toBe(true);
          }
          const settled = [
            ...batch.works.map((w) => w.putCode),
            ...batch.errors.map((e) => e.putCode),
          ];
          const returned = new Set(settled);
          // A repeated put-code resolves or fails once — never a work and an error both (#49).
          expect(returned.size).toBe(settled.length);
          const deferred = batch.deferredPutCodes ?? [];
          expect(new Set(deferred).size).toBe(deferred.length);
          for (const code of deferred) expect(returned.has(code)).toBe(false);
          for (const code of new Set(putCodes)) {
            expect(returned.has(code) || deferred.includes(code)).toBe(true);
          }
          expect(batch.notice !== undefined).toBe(deferred.length > 0);
          for (const work of batch.works) expect(work.abstract).not.toContain('<h4>');
        },
      ),
      { numRuns: 150, seed: SEED },
    );
  });
});
