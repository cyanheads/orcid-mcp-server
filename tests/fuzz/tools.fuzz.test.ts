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

/** Researchers the faked expanded-search route serves, in ORCID's order. */
const GENERATED_RESEARCHER_COUNT = 1_500;

/** An expanded-search registry whose record size varies with the position, as live data does. */
const generatedResearchers = Array.from({ length: GENERATED_RESEARCHER_COUNT }, (_, i) => ({
  'orcid-id': `0000-0001-${String(Math.floor(i / 10_000)).padStart(4, '0')}-${String(i % 10_000).padStart(4, '0')}`,
  ...(i % 9 !== 0 && { 'given-names': `Given ${'g'.repeat(i % 40)}` }),
  'family-names': 'Smith',
  ...(i % 4 === 0 && { 'credit-name': `G. Smith ${i}` }),
  'other-name': i % 3 === 0 ? [`Alias ${i}`, `Another alias ${i}`] : [],
  email: [],
  'institution-name': Array.from(
    { length: (i * 7) % 9 },
    (_, k) => `Institution ${k} ${'i'.repeat(i % 30)}`,
  ),
}));

/** Page the generated registry the way ORCID does: a slice at `start` of at most `rows`. */
function generatedSearch(url: string) {
  const params = new URL(url).searchParams;
  const start = Number(params.get('start') ?? 0);
  const rows = Number(params.get('rows') ?? 10);
  return {
    'expanded-result': generatedResearchers.slice(start, start + rows),
    'num-found': GENERATED_RESEARCHER_COUNT,
  };
}

/** ORCID iD whose bulk-works route serves {@link capPayload}, set per property run. */
const CAP_ORCID = '0000-0001-9161-999X';

/** The raw bulk-works payload the next `CAP_ORCID` request receives. */
let capPayload: unknown = { bulk: [] };

let http: FetchMockHarness;

beforeAll(() => {
  http = createFetchMock([
    {
      match: (request) => request.url.includes('/expanded-search/'),
      respond: (request) => Response.json(generatedSearch(request.url)),
    },
    {
      match: (request) => request.url.includes(`/${CAP_ORCID}/works/`),
      respond: () => Response.json(capPayload),
    },
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
      const before = http.calls.length;
      const report = await fuzzTool(definition, {
        numRuns: 50,
        numAdversarial: 30,
        seed: SEED,
      });

      expect(report.crashes).toHaveLength(0);
      expect(report.leaks).toHaveLength(0);
      expect(report.prototypePollution).toBe(false);
      // Generated inputs pass validation often enough to drive the handler upstream.
      expect(http.calls.length).toBeGreaterThan(before);
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
  /**
   * A ROR ID with valid check digits (`98 − (n × 100 mod 97)` over the six Crockford base32
   * characters), in any accepted form: bare or behind a ror.org prefix, either letter case,
   * with or without a trailing slash.
   */
  const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
  const rorId = fc
    .tuple(
      fc.integer({ min: 0, max: 32 ** 6 - 1 }),
      fc.constantFrom('', 'ror.org/', 'https://ror.org/', 'http://www.ror.org/'),
      fc.boolean(),
      fc.constantFrom('', '/'),
    )
    .map(([n, prefix, upper, slash]) => {
      let body = '';
      for (let v = n, i = 0; i < 6; i++, v = Math.floor(v / 32)) body = CROCKFORD[v % 32] + body;
      const id = `0${body}${String(98 - ((n * 100) % 97)).padStart(2, '0')}`;
      return `${prefix}${upper ? id.toUpperCase() : id}${slash}`;
    });
  const fields = {
    given_name: text(word),
    family_name: text(word),
    affiliation: text(word),
    keyword: text(word),
    ror_id: text(rorId),
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
    query: text(
      fc.constantFrom(
        'email:*berkeley.edu',
        'given-names:Jo*',
        'keyword:crispr',
        'given-names:Jo* OR keyword:crispr',
        '-keyword:crispr',
      ),
    ),
  };

  /**
   * Field → the clause its non-blank value compiles to. A given name of only initials (the
   * generator emits single letters) compiles to `given-names:J*` terms instead of a phrase
   * (#53); a raw query's `given-names:Jo*` matches neither form.
   */
  const CLAUSE: Record<keyof typeof fields, RegExp | undefined> = {
    given_name: /given-names:(?:"|\p{L}\p{M}*\*)/u,
    family_name: /family-name:"/,
    affiliation: /affiliation-org-name:"/,
    keyword: /keyword:"/,
    ror_id: /ror-org-id:"/,
    doi: /doi-self:"/,
    pmid: /pmid-self:"/,
    grant_number: /grant-numbers:"/,
    query: undefined,
  };

  it('accepts exactly the calls with a non-blank field and compiles one clause per such field', async () => {
    const outcomes = { accepted: 0, rejected: 0, initials: 0 };
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
        for (const [key, clause] of Object.entries(CLAUSE)) {
          if (!clause) continue;
          expect(clause.test(q)).toBe(nonBlank.includes(key as keyof typeof fields));
        }
        if (/given-names:\p{L}\p{M}*\*/u.test(q)) outcomes.initials++;
        // The raw query closes the clause list: verbatim when alone, else one AND-ed group —
        // except an exclusion-only query, which ORCID matches only ungrouped (#61).
        const rawQuery = generated.query.blank ? undefined : generated.query.value?.trim();
        if (rawQuery) {
          if (nonBlank.length === 1) {
            expect(q).toBe(rawQuery);
          } else {
            expect(
              q.endsWith(rawQuery.startsWith('-') ? ` AND ${rawQuery}` : ` AND (${rawQuery})`),
            ).toBe(true);
          }
        }
      }),
      { numRuns: 300, seed: SEED },
    );

    // Both sides of the contract were exercised, not just one, and the initials-only given name.
    expect(outcomes.accepted).toBeGreaterThan(50);
    expect(outcomes.rejected).toBeGreaterThan(0);
    expect(outcomes.initials).toBeGreaterThan(0);
  });
});

/**
 * The search response byte budget (#54): for any page request, a multi-result response keeps
 * each surface within the budget, returns a contiguous run of ORCID's order starting at
 * `start`, and reports nextStart exactly where the next page begins.
 */
describe('search response byte budget', () => {
  it('orcid_search_researchers: every page fits the budget and continues exactly where it stopped', async () => {
    const textBytes = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      Buffer.byteLength(
        result.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
      );
    const before = http.calls.length;
    let cutPages = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 0, max: GENERATED_RESEARCHER_COUNT + 20 }),
        async (rows, start) => {
          const result = await runToolContract(orcidSearchResearchers, {
            family_name: 'Smith',
            rows,
            start,
          });
          const page = result.structuredContent as {
            results: { orcidId: string }[];
            rows: number;
            nextStart?: number;
          };

          if (page.results.length > 1) {
            expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(
              RESPONSE_BYTE_BUDGET,
            );
            expect(textBytes(result)).toBeLessThanOrEqual(RESPONSE_BYTE_BUDGET);
          }
          expect(page.rows).toBe(page.results.length);
          expect(page.rows).toBeLessThanOrEqual(rows);
          if (start < GENERATED_RESEARCHER_COUNT) expect(page.rows).toBeGreaterThan(0);
          const end = start + page.rows;
          if (end < Math.min(start + rows, GENERATED_RESEARCHER_COUNT)) cutPages++;
          expect(page.nextStart).toBe(end < GENERATED_RESEARCHER_COUNT ? end : undefined);
          expect(page.results.map((r) => r.orcidId)).toEqual(
            generatedResearchers.slice(start, end).map((r) => r['orcid-id']),
          );
        },
      ),
      { numRuns: 150, seed: SEED },
    );

    // The property reached the upstream and exercised the cut, not only whole pages.
    expect(http.calls.length).toBeGreaterThan(before);
    expect(cutPages).toBeGreaterThan(10);
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

  /**
   * One generated record's upstream contributors, built from its length and the indexes that
   * carry the requested iD: most named, some nameless, some linked to another iD.
   */
  function upstreamContributors(length: number, ownerIndexes: ReadonlySet<number>) {
    return Array.from({ length }, (_, i) => ({
      ...(i % 13 !== 0 && { name: ownerIndexes.has(i) ? 'Doudna JA' : `Contributor ${i}` }),
      ...(ownerIndexes.has(i)
        ? { orcidId: CAP_ORCID }
        : i % 7 === 0 && { orcidId: '0000-0002-1825-0097' }),
      ...(i % 2 === 0 && { role: 'author' }),
      sequence: i === 0 ? 'first' : 'additional',
    }));
  }

  /** A deposited citation of about `bytes` UTF-8 bytes, ASCII or two-byte. */
  const citationArb = fc
    .tuple(
      fc.oneof(fc.integer({ min: 1, max: 70_000 }), fc.integer({ min: 8_180, max: 8_200 })),
      fc.constantFrom('a', 'é', 'aé\n'),
    )
    .map(([bytes, chunk]) =>
      chunk.repeat(Math.max(1, Math.floor(bytes / Buffer.byteLength(chunk)))),
    );

  const recordArb = fc.record({
    contributorCount: fc.oneof(
      fc.constantFrom(0, 100, 101),
      fc.integer({ min: 0, max: 120 }),
      fc.integer({ min: 0, max: 5_000 }),
    ),
    ownerSeeds: fc.uniqueArray(fc.nat(), { maxLength: 4 }),
    citation: fc.option(citationArb, { nil: undefined }),
    abstract: fc.option(
      fc
        .tuple(fc.integer({ min: 1, max: 5_000 }), fc.constantFrom('a', 'é', 'a\n'))
        .map(([length, chunk]) => chunk.repeat(Math.ceil(length / chunk.length)).slice(0, length)),
      { nil: undefined },
    ),
    titleLength: fc.integer({ min: 1, max: 1_000 }),
  });

  it('orcid_get_work_detail: capped records keep the contributor and citation contract and fit the budget alone (#52)', async () => {
    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    let cutRecords = 0;
    let omittedCitations = 0;

    await fc.assert(
      fc.asyncProperty(fc.array(recordArb, { minLength: 1, maxLength: 4 }), async (specs) => {
        const records = specs.map((spec, i) => {
          // Owner indexes land both inside the first 100 and past it.
          const owners = new Set(
            spec.contributorCount === 0
              ? []
              : spec.ownerSeeds.map((seed) => seed % spec.contributorCount),
          );
          return {
            putCode: i + 1,
            spec,
            owners,
            contributors: upstreamContributors(spec.contributorCount, owners),
          };
        });
        capPayload = {
          bulk: records.map(({ putCode, spec, contributors }) => ({
            work: {
              'put-code': putCode,
              title: { title: { value: 't'.repeat(spec.titleLength) } },
              ...(spec.abstract !== undefined && { 'short-description': spec.abstract }),
              ...(spec.citation !== undefined && {
                citation: { 'citation-type': 'bibtex', 'citation-value': spec.citation },
              }),
              contributors: {
                contributor: contributors.map((c) => ({
                  ...(c.name !== undefined && { 'credit-name': { value: c.name } }),
                  ...(c.orcidId !== undefined && { 'contributor-orcid': { path: c.orcidId } }),
                  'contributor-attributes': {
                    ...(c.role !== undefined && { 'contributor-role': c.role }),
                    'contributor-sequence': c.sequence,
                  },
                })),
              },
            },
          })),
        };

        const result = await runToolContract(orcidGetWorkDetail, {
          orcid_id: CAP_ORCID,
          put_codes: records.map((r) => r.putCode),
        });
        expect(result.isError).toBeFalsy();
        // Every batch fits, one-record batches included: the caps bound a record on its own.
        expect(bytesOf(result.structuredContent)).toBeLessThanOrEqual(RESPONSE_BYTE_BUDGET);
        expect(Buffer.byteLength(textOf(result))).toBeLessThanOrEqual(RESPONSE_BYTE_BUDGET);

        const batch = result.structuredContent as {
          works: {
            putCode: number;
            contributors: unknown[];
            contributorCount?: number;
            contributorsTruncated?: boolean;
            citation?: { value: string };
            citationOmitted?: boolean;
          }[];
        };
        expect(batch.works.length).toBeGreaterThan(0);
        for (const work of batch.works) {
          const record = records[work.putCode - 1]!;
          const n = record.contributors.length;
          if (n <= 100) {
            expect(work.contributors).toEqual(record.contributors);
            expect(work).not.toHaveProperty('contributorCount');
            expect(work).not.toHaveProperty('contributorsTruncated');
          } else {
            cutRecords++;
            const laterOwners = [...record.owners]
              .filter((i) => i >= 100)
              .sort((a, b) => a - b)
              .map((i) => record.contributors[i]);
            expect(work.contributors).toEqual([
              ...record.contributors.slice(0, 100),
              ...laterOwners,
            ]);
            expect(work.contributorCount).toBe(n);
            expect(work.contributorsTruncated).toBe(true);
          }
          const citation = record.spec.citation;
          const kept = citation !== undefined && Buffer.byteLength(citation) <= 8_192;
          expect(work.citation?.value).toBe(kept ? citation : undefined);
          expect(work.citationOmitted).toBe(citation !== undefined && !kept ? true : undefined);
          if (citation !== undefined && !kept) omittedCitations++;
        }
      }),
      { numRuns: 60, seed: SEED },
    );

    // The property reached both sides of each cap, not only whole records.
    expect(cutRecords).toBeGreaterThan(5);
    expect(omittedCitations).toBeGreaterThan(5);
  });
});
