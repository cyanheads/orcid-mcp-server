/**
 * @fileoverview Captured ORCID allocation detail through the real service and tool.
 * @module tests/integration/research-resource-detail.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orcidGetResearchResources } from '@/mcp-server/tools/definitions/get-research-resources.tool.js';
import type { RawResearchResourceDetail } from '@/services/orcid/types.js';
import captured from './fixtures/research-resource-detail.json' with { type: 'json' };
import { initOrcidServiceForTests } from './orcid-api-fixtures.js';

const id = '0000-0001-6866-9833';
let payload: RawResearchResourceDetail = captured;
let status = 200;
const http = createFetchMock([
  {
    method: 'GET',
    match: (r) => r.url.endsWith(`/${id}/research-resource/5724`),
    respond: (request) => {
      request.signal.throwIfAborted();
      return Response.json(payload, { status });
    },
  },
  // A missing allocation probes /person for a deprecated iD; this one is served as requested.
  {
    method: 'GET',
    match: (r) => r.url.endsWith(`/${id}/person`),
    respond: (request) => person(request),
  },
]);
const servedAsRequested = () => Response.json({ name: null });
let person: (request: Request) => Response = servedAsRequested;
beforeEach(() => {
  payload = captured;
  status = 200;
  person = servedAsRequested;
  http.install();
  initOrcidServiceForTests();
});
afterEach(() => http.restore());

const call = (extra: Record<string, unknown> = {}) =>
  runToolContract(orcidGetResearchResources, { orcid_id: id, put_code: 5724, ...extra });

describe('allocation detail contract', () => {
  it('preserves caller cancellation as an error rather than a partial allocation', async () => {
    const result = await runToolContract(
      orcidGetResearchResources,
      { orcid_id: id, put_code: 5724 },
      { context: { signal: AbortSignal.abort(new Error('cancelled')) } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(JSON.stringify(result.content)).toContain('cancelled');
  });

  it('keeps sparse and multiple proposal/item hosts in upstream order without inferring operators', async () => {
    payload = {
      'put-code': 5724,
      proposal: { hosts: { organization: [{}, { name: 'Proposal B' }] } },
      'resource-item': [
        { 'resource-name': 'Sparse' },
        {
          'resource-name': 'Multiple',
          hosts: {
            organization: [
              {},
              {
                name: 'Operator B',
                address: { country: 'GB' },
                'disambiguated-organization': { 'disambiguation-source': 'ROR' },
              },
            ],
          },
          'external-ids': {
            'external-id': [
              {
                'external-id-type': 'uri',
                'external-id-value': 'CaseSensitive',
                'external-id-url': { value: 'https://example.org/id' },
                'external-id-relationship': 'part-of',
              },
            ],
          },
          url: { value: 'https://example.org/item' },
        },
      ],
    };
    const result = await call();
    expect(result.isError).toBeFalsy();
    const resource = (result.structuredContent as { resources: Record<string, unknown>[] })
      .resources[0]!;
    expect(resource.hostOrganization).toBeUndefined();
    expect(resource.proposalHosts).toEqual([{}, { name: 'Proposal B' }]);
    expect(resource.items).toEqual([
      { name: 'Sparse', hosts: [], externalIds: [] },
      {
        name: 'Multiple',
        hosts: [{}, { name: 'Operator B', country: 'GB', disambiguationSource: 'ROR' }],
        externalIds: [
          {
            type: 'uri',
            value: 'CaseSensitive',
            url: 'https://example.org/id',
            relationship: 'part-of',
          },
        ],
        url: 'https://example.org/item',
      },
    ]);
    const text = JSON.stringify(result.content);
    for (const value of [
      'Proposal B',
      'Operator B',
      'CaseSensitive',
      'part-of',
      'https://example.org/item',
      'ROR',
    ])
      expect(text).toContain(value);
  });

  it('applies default and effective item caps and terminates empty pages', async () => {
    payload = {
      'put-code': 5724,
      'resource-item': Array.from({ length: 150 }, (_, i) => ({ 'resource-name': `item ${i}` })),
    };
    const normal = await call();
    expect(normal.structuredContent).toMatchObject({
      truncated: true,
      resources: [{ returnedItemCount: 25, nextItemOffset: 25, itemsTruncated: true }],
    });
    expect(normal.structuredContent).not.toHaveProperty('itemLimitNotice');
    const full = await call({ item_limit: 100 });
    expect(full.structuredContent).toMatchObject({
      truncated: true,
      resources: [{ returnedItemCount: 100, nextItemOffset: 100, itemCount: 150 }],
    });
    expect(full.structuredContent).not.toHaveProperty('itemLimitNotice');
    for (const itemLimit of [101, 10_000]) {
      const capped = await call({ item_limit: itemLimit });
      const notice = `Requested item_limit ${itemLimit}; effective maximum is 100 items per page.`;
      expect(capped.structuredContent).toMatchObject({
        itemLimitNotice: notice,
        resources: [{ returnedItemCount: 100, nextItemOffset: 100 }],
      });
      expect(JSON.stringify(capped.content)).toContain(notice);
    }
    const last = await call({ item_offset: 100, item_limit: 100 });
    expect(last.structuredContent).toMatchObject({
      truncated: false,
      resources: [{ returnedItemCount: 50, itemOffset: 100, itemsTruncated: false }],
    });
    for (const offset of [150, 151]) {
      const result = await call({ item_offset: offset });
      expect(result.structuredContent).toMatchObject({
        truncated: false,
        resources: [{ items: [], returnedItemCount: 0, itemsTruncated: false }],
      });
      expect(
        (result.structuredContent as { resources: { nextItemOffset?: number }[] }).resources[0],
      ).not.toHaveProperty('nextItemOffset');
      expect(JSON.stringify(result.content)).not.toContain('Next item offset');
    }
    payload = { 'put-code': 5724 };
    expect((await call()).structuredContent).toMatchObject({
      resources: [{ items: [], itemCount: 0, itemsTruncated: false }],
    });
  });

  it('pages large items by count alone, repeating proposal metadata on every page', async () => {
    const title = 'Metadata '.repeat(500);
    payload = {
      ...captured,
      proposal: { ...captured.proposal, title: { title: { value: title } } },
      'resource-item': Array.from({ length: 30 }, (_, i) => ({
        ...captured['resource-item'][i % 14],
        'resource-name': `item ${i} ${'é\\"'.repeat(i === 3 ? 30_000 : 900)}`,
      })),
    };
    let offset = 0;
    const seen: string[] = [];
    const pageSizes: number[] = [];
    while (offset < 30) {
      const result = await call({ item_offset: offset, item_limit: 12 });
      expect(result.isError).toBeFalsy();
      const page = (
        result.structuredContent as {
          resources: { title: string; items: { name: string }[]; nextItemOffset?: number }[];
        }
      ).resources[0]!;
      expect(page.title).toBe(title);
      const text = JSON.stringify(result.content);
      for (const item of page.items) expect(text).toContain(JSON.stringify(item.name).slice(1, -1));
      seen.push(...page.items.map((x) => x.name));
      pageSizes.push(page.items.length);
      offset = page.nextItemOffset ?? 30;
    }
    expect(pageSizes).toEqual([12, 12, 6]);
    expect(seen).toEqual(payload['resource-item']!.map((x) => x['resource-name']));
    payload = {
      'put-code': 5724,
      'resource-item': [{ 'resource-name': 'x'.repeat(70_000) }, { 'resource-name': 'next' }],
    };
    const oversized = await call();
    expect(oversized.structuredContent).toMatchObject({
      resources: [{ returnedItemCount: 2, itemsTruncated: false }],
    });
    expect(oversized.structuredContent).not.toHaveProperty('budgetOverflow');
    expect(JSON.stringify(oversized.content)).not.toContain('Budget exception');
  });

  it('reports paging-without-selector and missing detail with recovery on both surfaces', async () => {
    for (const extra of [{ item_offset: 0 }, { item_limit: 1 }]) {
      const result = await runToolContract(orcidGetResearchResources, { orcid_id: id, ...extra });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'detail_required',
            recovery: { hint: expect.stringContaining('put_code') },
          },
        },
      });
      expect(JSON.stringify(result.content)).toContain('put_code');
    }
    status = 404;
    const before = http.calls.length;
    const result = await call();
    // One /person probe finds the iD is not deprecated; nothing is re-fetched.
    expect(http.calls.slice(before).map((c) => c.request.url.split(`/${id}/`)[1])).toEqual([
      'research-resource/5724',
      'person',
    ]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'resource_not_found',
          recovery: { hint: expect.stringContaining('summary') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('summary');
  });

  it.each([
    ['a non-transient HTTP error', () => new Response('', { status: 400 })],
    ['an incompatible body', () => Response.json([])],
  ])('keeps resource_not_found when the /person probe fails with %s', async (_label, respond) => {
    status = 404;
    person = respond;
    const before = http.calls.length;
    const result = await call();
    expect(http.calls.slice(before).map((c) => c.request.url.split(`/${id}/`)[1])).toEqual([
      'research-resource/5724',
      'person',
    ]);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'resource_not_found',
          recovery: { hint: expect.stringContaining('summary') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('resource_not_found');
  });

  it('rethrows caller cancellation that lands during the /person probe', async () => {
    status = 404;
    const controller = new AbortController();
    person = (request) => {
      controller.abort();
      request.signal.throwIfAborted();
      return servedAsRequested();
    };
    const ctx = createMockContext({
      errors: orcidGetResearchResources.errors,
      signal: controller.signal,
    });
    const input = orcidGetResearchResources.input.parse({ orcid_id: id, put_code: 5724 });
    await expect(orcidGetResearchResources.handler(input, ctx)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it.each([
    { item_limit: 0 },
    { item_limit: 10_001 },
    { item_offset: -1 },
    { put_code: 0 },
    { item_offset: 1.1 },
  ])('rejects invalid detail arguments %j', async (extra) => {
    expect((await call(extra)).isError).toBe(true);
  });

  it('walks all captured items through first, second, last, and past-end pages', async () => {
    const names: string[] = [];
    for (const offset of [0, 5, 10, 14]) {
      const result = await runToolContract(orcidGetResearchResources, {
        orcid_id: id,
        put_code: 5724,
        item_offset: offset,
        item_limit: 5,
      });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as {
        view: string;
        putCode: number;
        resources: {
          items: { name?: string; hosts: { name?: string }[] }[];
          itemCount: number;
          nextItemOffset?: number;
          sources: unknown[];
        }[];
      };
      expect(data.view).toBe('detail');
      expect(data.putCode).toBe(5724);
      const resource = data.resources[0]!;
      expect(resource.itemCount).toBe(14);
      expect(resource.nextItemOffset).toBe(offset < 10 ? offset + 5 : undefined);
      expect(resource.sources).toEqual([{ name: 'ACCESS', selfAsserted: false }]);
      names.push(...resource.items.map((x) => x.name!));
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      for (const item of resource.items) {
        expect(text).toContain(item.name);
        for (const host of item.hosts) expect(text).toContain(host.name);
      }
    }
    expect(names).toEqual(captured['resource-item'].map((x) => x['resource-name']));
  });
});
