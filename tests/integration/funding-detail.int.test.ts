/**
 * @fileoverview Selected funding detail through fetch, normalization and both tool surfaces.
 * @module tests/integration/funding-detail.int.test
 */
import { readFileSync } from 'node:fs';
import { config } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetFunding } from '@/mcp-server/tools/definitions/get-funding.tool.js';
import { initOrcidService } from '@/services/orcid/orcid-service.js';

const id = '0000-0001-9161-999X';
const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
beforeEach(() => initOrcidService(config, createInMemoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('selected funding detail', () => {
  it('characterizes summary grouping, own sources and distinct periods with one request', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        group: [
          {
            'funding-summary': [
              {
                'start-date': { year: { value: '2020' } },
                source: { 'source-name': { value: 'First' } },
              },
              {
                'start-date': { year: { value: '2021' } },
                source: {
                  'source-name': { value: 'Second' },
                  'source-client-id': { path: 'APP-2' },
                },
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await runToolContract(orcidGetFunding, { orcid_id: id });
    expect(result.structuredContent).toMatchObject({
      fundingCount: 1,
      funding: [
        {
          periods: [{ startDate: '2020' }, { startDate: '2021' }],
          sources: [{ name: 'First' }, { name: 'Second' }],
        },
      ],
    });
    expect(text(result)).toContain('2020; 2021');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('selects only the captured deposit and preserves decimal text and source', async () => {
    const award = JSON.parse(
      readFileSync(new URL('./funding-award.fixture.json', import.meta.url), 'utf8'),
    );
    const fetchMock = vi.fn(async (_url: unknown) => Response.json(award));
    vi.stubGlobal('fetch', fetchMock);
    const result = await runToolContract(orcidGetFunding, { orcid_id: id, put_code: 2329252 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      view: 'detail',
      fundingCount: 1,
      funding: [
        {
          putCode: 2329252,
          amount: { value: '330000.0', currency: 'USD' },
          description: award['short-description'],
        },
      ],
    });
    const record = (result.structuredContent as { funding: Record<string, unknown>[] }).funding[0];
    expect(record).not.toHaveProperty('descriptionOffset');
    expect(record).not.toHaveProperty('descriptionLength');
    expect(text(result)).toContain('330000.0');
    expect(result.structuredContent).toMatchObject({
      funding: [{ sources: [{ name: 'ProposalCentral', selfAsserted: false }] }],
    });
    expect(text(result)).toContain(JSON.stringify(award['short-description']));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/funding/2329252');
  });

  it('returns preferred put-code in summary without fetching detail', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ group: [{ 'funding-summary': [{ 'put-code': 10 }, { 'put-code': 11 }] }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await runToolContract(orcidGetFunding, { orcid_id: id });
    expect(result.structuredContent).toMatchObject({ view: 'summary', funding: [{ putCode: 10 }] });
    expect(text(result)).toContain('10');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([404, 403])(
    'maps selected %s to actionable funding errors on both surfaces',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status })),
      );
      const result = await runToolContract(orcidGetFunding, { orcid_id: id, put_code: 1 });
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: status === 404 ? 'funding_not_found' : 'funding_inaccessible',
            recovery: { hint: expect.stringContaining('put_code') },
          },
        },
      });
      expect(text(result)).toContain('put_code');
      expect(text(result)).not.toContain('profile_not_found');
    },
  );

  it('returns a 5,000-code-point description whole, CRLF included, on both surfaces', async () => {
    // ORCID's schema caps short-description at 5,000 characters; four-byte code points and
    // JSON-escaped characters make this the heaviest shape a schema-valid deposit can take.
    const description = '😀é\r\n山"\\😀'.repeat(625);
    expect(Array.from(description)).toHaveLength(5_000);
    const fetchMock = vi.fn(async () =>
      Response.json({
        'put-code': 1,
        title: { title: { value: 'Award' } },
        'short-description': description,
        amount: { value: '0.0000000000000000001', 'currency-code': 'USD' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await runToolContract(orcidGetFunding, { orcid_id: id, put_code: 1 });
    expect(result.isError).toBeFalsy();
    const record = orcidGetFunding.output.parse(result.structuredContent).funding[0]!;
    expect(record).toEqual({
      putCode: 1,
      title: 'Award',
      description,
      amount: { value: '0.0000000000000000001', currency: 'USD' },
      contributors: [],
      grantNumbers: [],
      sources: [],
    });
    expect(text(result)).toContain(`**Description (JSON string):** ${JSON.stringify(description)}`);
    expect(text(result)).not.toContain('Description offset');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, '', 'short'])(
    'keeps a missing, empty, or short description as deposited: %s',
    async (description) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({ 'put-code': 1, 'short-description': description, amount: null }),
        ),
      );
      const result = await runToolContract(orcidGetFunding, { orcid_id: id, put_code: 1 });
      expect(result.isError).toBeFalsy();
      const record = orcidGetFunding.output.parse(result.structuredContent).funding[0]!;
      expect(record.amount).toBeUndefined();
      expect(record.description).toBe(description ?? undefined);
      if (description == null) expect(text(result)).not.toContain('**Description');
      else
        expect(text(result)).toContain(
          `**Description (JSON string):** ${JSON.stringify(description)}`,
        );
    },
  );

  it('returns oversized award metadata whole, with no overflow field', async () => {
    const title = 'a'.repeat(64_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          'put-code': 1,
          title: { title: { value: title } },
          'short-description': '😀ab',
        }),
      ),
    );
    const result = await runToolContract(orcidGetFunding, { orcid_id: id, put_code: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('budgetOverflow');
    expect(result.structuredContent).toMatchObject({
      funding: [{ title, description: '😀ab' }],
    });
    expect(text(result)).toContain(title);
    expect(text(result)).not.toContain('Budget exception');
  });

  it.each([{ value: '0' }, { 'currency-code': 'JPY' }, { value: null, 'currency-code': null }])(
    'preserves independently sparse amount fields %#',
    async (amount) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ 'put-code': 1, amount })),
      );
      const result = await runToolContract(orcidGetFunding, { orcid_id: id, put_code: 1 });
      expect(result.isError).toBeFalsy();
      const record = orcidGetFunding.output.parse(result.structuredContent).funding[0]!;
      if (amount.value === '0') {
        expect(record.amount).toEqual({ value: '0' });
        expect(text(result)).toContain('**Amount:** 0');
      } else if (amount['currency-code'] === 'JPY') {
        expect(record.amount).toEqual({ currency: 'JPY' });
        expect(text(result)).toContain('JPY');
      } else expect(record.amount).toBeUndefined();
    },
  );

  it('keeps contributors and subtype out of summary view', async () => {
    // The summary carries both fields here, so a summary view that read either would show it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          group: [
            {
              'funding-summary': [
                {
                  'put-code': 10,
                  title: { title: { value: 'Grant' } },
                  'organization-defined-type': { value: 'BRIDGE Grant Program' },
                  contributors: {
                    contributor: [
                      {
                        'credit-name': { value: 'Sophia D. Espanola' },
                        'contributor-attributes': { 'contributor-role': 'supported-by' },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      ),
    );
    const result = await runToolContract(orcidGetFunding, { orcid_id: id });
    expect(result.isError).toBeFalsy();
    const record = (result.structuredContent as { funding: Record<string, unknown>[] }).funding[0];
    expect(record).not.toHaveProperty('contributors');
    expect(record).not.toHaveProperty('organizationDefinedType');
    expect(text(result)).not.toContain('**Contributors:**');
    expect(text(result)).not.toContain('**Funding subtype:**');
  });

  it.each([
    { description_offset: 0, put_code: 1 },
    { description_offset: 0 },
    { put_code: 0 },
    { put_code: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid selection %j before I/O', async (args) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // description_offset is no longer part of the input type; the call is what a stale client sends.
    const result = await runToolContract(orcidGetFunding, { orcid_id: id, ...args } as {
      orcid_id: string;
    });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    if ('description_offset' in args) expect(text(result)).toContain('description_offset');
  });
});

describe('selected funding detail: contributors and funding subtype (#86)', () => {
  /** Live deposits keyed `<iD>/<put-code>`, as ORCID served them. */
  const deposits: Record<string, unknown> = JSON.parse(
    readFileSync(new URL('./funding-contributors.fixture.json', import.meta.url), 'utf8'),
  );
  /** Select one deposit through the real service, with `body` as ORCID's answer. */
  async function select(orcidId: string, putCode: number, body: unknown) {
    const fetchMock = vi.fn(async (_url: unknown) => Response.json(body));
    vi.stubGlobal('fetch', fetchMock);
    const result = await runToolContract(orcidGetFunding, { orcid_id: orcidId, put_code: putCode });
    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/${orcidId}/funding/${putCode}`);
    const record = (result.structuredContent as { funding: Record<string, unknown>[] }).funding[0];
    return { record, text: text(result) };
  }

  it('returns a named, role-carrying contributor and the subtype on both surfaces', async () => {
    const { record, text } = await select(
      '0000-0001-9540-6625',
      173219,
      deposits['0000-0001-9540-6625/173219'],
    );
    expect(record).toMatchObject({
      putCode: 173219,
      contributors: [{ name: 'Sophia D. Espanola', role: 'supported-by' }],
      organizationDefinedType: 'BRIDGE Grant Program',
    });
    expect(record?.contributors).toStrictEqual([
      { name: 'Sophia D. Espanola', role: 'supported-by' },
    ]);
    expect(text).toContain('**Contributors:**\n- Sophia D. Espanola — supported-by\n');
    expect(text).toContain('**Type:** award\n**Funding subtype:** BRIDGE Grant Program\n');
  });

  it('renders a role-only entry as unnamed and leaves an unset subtype out', async () => {
    const { record, text } = await select(
      '0000-0002-4087-2589',
      216581,
      deposits['0000-0002-4087-2589/216581'],
    );
    expect(record?.contributors).toStrictEqual([{ role: 'lead' }]);
    expect(record).not.toHaveProperty('organizationDefinedType');
    expect(text).toContain('**Contributors:**\n- (unnamed) — lead\n');
    expect(text).not.toContain('**Funding subtype:**');
  });

  it('keeps every name-only entry, in upstream order, with no role', async () => {
    const { record, text } = await select(
      '0000-0002-4997-5031',
      866540,
      deposits['0000-0002-4997-5031/866540'],
    );
    expect(record?.contributors).toStrictEqual([
      { name: 'Anabela Pereira' },
      { name: 'Vitor Duque' },
    ]);
    expect(text).toContain('**Contributors:**\n- Anabela Pereira\n- Vitor Duque\n');
  });

  it('returns a deposited contributor iD and keeps an entry that carries nothing', async () => {
    const { record, text } = await select('0000-0001-9540-6625', 1, {
      'put-code': 1,
      contributors: {
        contributor: [
          {
            'contributor-orcid': {
              uri: 'https://orcid.org/0000-0002-1825-0097',
              path: '0000-0002-1825-0097',
              host: 'orcid.org',
            },
            'credit-name': { value: 'Josiah Carberry' },
            'contributor-email': null,
            'contributor-attributes': { 'contributor-role': 'co-lead' },
          },
          {
            'contributor-orcid': null,
            'credit-name': null,
            'contributor-email': null,
            'contributor-attributes': null,
          },
        ],
      },
    });
    expect(record?.contributors).toStrictEqual([
      { name: 'Josiah Carberry', orcidId: '0000-0002-1825-0097', role: 'co-lead' },
      {},
    ]);
    expect(text).toContain(
      '**Contributors:**\n- Josiah Carberry — co-lead [0000-0002-1825-0097]\n- (unnamed)\n',
    );
  });

  it('returns no contributors and the subtype when the deposit lists none', async () => {
    const { record, text } = await select(
      '0000-0001-7113-5488',
      550335,
      deposits['0000-0001-7113-5488/550335'],
    );
    expect(record?.contributors).toStrictEqual([]);
    expect(record?.organizationDefinedType).toBe('F31 - Predoctoral Fellowship');
    expect(text).toContain('**Funding subtype:** F31 - Predoctoral Fellowship\n');
    expect(text).not.toContain('**Contributors:**');
  });

  it.each([
    [
      'null contributors and subtype',
      { 'put-code': 1, contributors: null, 'organization-defined-type': null },
    ],
    ['absent contributors and subtype', { 'put-code': 1 }],
    [
      'an empty contributor list and a null subtype value',
      {
        'put-code': 1,
        contributors: { contributor: [] },
        'organization-defined-type': { value: null },
      },
    ],
  ])('gives an empty list, no subtype key, and neither line for %s', async (_, body) => {
    const { record, text } = await select(id, 1, body);
    expect(record?.contributors).toStrictEqual([]);
    expect(record).not.toHaveProperty('organizationDefinedType');
    expect(text).not.toContain('**Contributors:**');
    expect(text).not.toContain('**Funding subtype:**');
  });

  it('folds a line break in a contributor name or the subtype in text only', async () => {
    const name = 'Anabela\r\nPereira';
    const subtype = 'BRIDGE\r\nGrant\nProgram';
    const { record, text } = await select(id, 1, {
      'put-code': 1,
      contributors: {
        contributor: [
          {
            'credit-name': { value: name },
            'contributor-attributes': { 'contributor-role': 'lead' },
          },
        ],
      },
      'organization-defined-type': { value: subtype },
    });
    expect(record?.contributors).toStrictEqual([{ name, role: 'lead' }]);
    expect(record?.organizationDefinedType).toBe(subtype);
    expect(text).toContain('- Anabela Pereira — lead\n');
    expect(text).toContain('**Funding subtype:** BRIDGE Grant Program\n');
    expect(text).not.toMatch(/^(Pereira|Grant|Program)/m);
  });
});
