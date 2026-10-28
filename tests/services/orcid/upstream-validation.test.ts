/**
 * @fileoverview Endpoint validation at the real fetch/retry/normalization seam.
 * @module tests/services/orcid/upstream-validation.test
 */
import { config } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';
import { initOrcidService, OrcidService } from '@/services/orcid/orcid-service.js';

const id = '0000-0002-1825-0097';
const methods = [
  (s: OrcidService) => s.expandedSearch({ q: 'x' }, createMockContext()),
  (s: OrcidService) => s.getPerson(id, createMockContext()),
  (s: OrcidService) => s.getWorks(id, createMockContext()),
  (s: OrcidService) => s.getAffiliations(id, ['all'], createMockContext()),
  (s: OrcidService) => s.getFundings(id, createMockContext()),
  (s: OrcidService) => s.getPeerReviews(id, createMockContext()),
  (s: OrcidService) => s.getWorkDetails(id, [1], createMockContext()),
  (s: OrcidService) => s.getResearchResources(id, createMockContext()),
  (s: OrcidService) => s.getResearchResourceDetail(id, 1, createMockContext()),
  (s: OrcidService) => s.getFundingDetail(id, 1, createMockContext()),
];
afterEach(() => vi.unstubAllGlobals());

describe('ORCID endpoint boundaries', () => {
  it('characterizes empty search and sparse funding without inventing values', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ 'num-found': 0, 'expanded-result': null }))
        .mockResolvedValueOnce(Response.json({ group: [{ 'funding-summary': [{}] }] })),
    );
    const service = new OrcidService(config, createInMemoryStorage());
    expect(await service.expandedSearch({ q: 'x' }, createMockContext())).toEqual({
      results: [],
      numFound: 0,
    });
    expect(await service.getFundings(id, createMockContext())).toEqual({
      orcidId: id,
      data: [{ grantNumbers: [], sources: [] }],
    });
  });

  it.each(methods.map((call, index) => ({ call, index })))(
    'rejects error documents once at endpoint $index',
    async ({ call }) => {
      const fetchMock = vi.fn(async () =>
        Response.json({ 'response-code': 503, 'user-message': 'secret upstream body' }),
      );
      vi.stubGlobal('fetch', fetchMock);
      await expect(call(new OrcidService(config, createInMemoryStorage()))).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'invalid_upstream_response', retryable: false },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    null,
    [],
    'wrong',
    {},
    { name: {} },
    { group: [{ 'work-summary': [{ title: { title: { value: 'Sibling work' } } }] }] },
    { group: 'wrong' },
    { group: [{ 'funding-summary': [{ title: { title: { value: 12 } } }] }] },
  ])('rejects incompatible funding shape %#', async (payload) => {
    const fetchMock = vi.fn(async () => Response.json(payload));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new OrcidService(config, createInMemoryStorage()).getFundings(id, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'invalid_upstream_response', retryable: false } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the upstream reason through the actual tool error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ 'expanded-result': [{ 'institution-name': [12] }], 'num-found': 1 }),
      ),
    );
    initOrcidService(config, createInMemoryStorage());
    const result = await runToolContract(orcidSearchResearchers, { family_name: 'Test' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'invalid_upstream_response', retryable: false },
      },
    });
    expect(JSON.stringify(result)).not.toContain('pub.orcid.org');
    expect(JSON.stringify(result)).not.toContain('institution-name');
    expect(JSON.stringify(result.content)).toContain('ORCID');
  });

  it.each([
    [1, { name: { 'given-names': { value: 42 } } }],
    [
      2,
      {
        group: [
          {
            'work-summary': [{ 'external-ids': { 'external-id': [{ 'external-id-value': [] }] } }],
          },
        ],
      },
    ],
    [
      3,
      {
        employments: {
          'affiliation-group': [
            {
              summaries: [{ 'employment-summary': { organization: { address: { country: 42 } } } }],
            },
          ],
        },
      },
    ],
    [
      5,
      {
        group: [
          {
            'peer-review-group': [
              { 'peer-review-summary': [{ 'completion-date': { year: { value: 2020 } } }] },
            ],
          },
        ],
      },
    ],
    [
      6,
      {
        bulk: [{ work: { contributors: { contributor: [{ 'credit-name': { value: false } }] } } }],
      },
    ],
    [
      7,
      {
        group: [
          { 'research-resource-summary': [{ proposal: { hosts: { organization: [false] } } }] },
        ],
      },
    ],
    [8, { 'put-code': 1, 'resource-item': [{ hosts: { organization: [{ name: [] }] } }] }],
    [9, { 'put-code': 1, amount: { value: 0 } }],
    [9, { 'put-code': 1, 'short-description': { content: 'wrong' } }],
  ] as const)('rejects malformed nested consumed fields at endpoint %s', async (index, payload) => {
    const fetchMock = vi.fn(async () => Response.json(payload));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      methods[index]!(new OrcidService(config, createInMemoryStorage())),
    ).rejects.toMatchObject({ data: { reason: 'invalid_upstream_response', retryable: false } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts null leaves and unknown metadata and preserves per-record bulk errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            name: null,
            biography: { content: null },
            emails: null,
            extra: { future: true },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            bulk: [
              { work: { 'put-code': 1, title: null, contributors: null } },
              {
                error: { 'response-code': 404, 'developer-message': "'2' is not a valid put code" },
              },
            ],
          }),
        ),
    );
    const service = new OrcidService(config, createInMemoryStorage());
    expect(await service.getPerson(id, createMockContext())).toMatchObject({
      orcidId: id,
      data: { otherNames: [], emails: [] },
    });
    expect(await service.getWorkDetails(id, [1, 2], createMockContext())).toEqual({
      orcidId: id,
      data: [
        { type: 'work', detail: { putCode: 1, externalIds: [], contributors: [], sources: [] } },
        { type: 'error', putCode: 2, message: "'2' is not a valid put code" },
      ],
    });
  });
});
