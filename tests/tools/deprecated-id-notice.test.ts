/**
 * @fileoverview How a record tool reports a deprecated iD: the notice naming both iDs, the
 * `/person` merge check the endpoints ORCID never redirects rely on, and the sentence an answer
 * opens with when that check could not run. The check runs the real service against a stubbed
 * upstream, so retry, status mapping, and the wait bound are all in the path; the tools'
 * own tests prove only the wiring.
 * @module tests/tools/deprecated-id-notice.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import {
  checkMerge,
  deprecatedIdNotice,
  mergeCheckFailedNotice,
} from '@/mcp-server/tools/deprecated-id-notice.js';
import { OrcidService } from '@/services/orcid/orcid-service.js';

describe('deprecatedIdNotice', () => {
  it('is empty when the record was served under the requested iD', () => {
    expect(deprecatedIdNotice('0000-0002-1825-0097', '0000-0002-1825-0097')).toBe('');
  });

  it('names the deprecated iD and the primary iD that replaces it', () => {
    expect(deprecatedIdNotice('0000-0002-7759-8499', '0000-0001-8143-9338')).toBe(
      'ORCID iD 0000-0002-7759-8499 is deprecated: ORCID merged it into 0000-0001-8143-9338, and this response reports that primary record. Use 0000-0001-8143-9338 in later calls.',
    );
  });
});

describe('mergeCheckFailedNotice', () => {
  it.each([
    [
      'empty-summary',
      'ORCID iD 0000-0002-7759-8499 could not be checked for a merge into another iD, so its existence and this empty result are unconfirmed; call again before relying on this answer.',
    ],
    [
      'unresolved-works',
      'ORCID iD 0000-0002-7759-8499 could not be checked for a merge into another iD, so the put-codes that did not resolve are unconfirmed; call again before relying on this answer.',
    ],
    [
      'missing-allocation',
      'ORCID iD 0000-0002-7759-8499 could not be checked for a merge into another iD, so this not-found answer is unconfirmed; call again before relying on this answer.',
    ],
  ] as const)('names the iD, the unconfirmed %s, and the call to make again', (answer, text) => {
    expect(mergeCheckFailedNotice('0000-0002-7759-8499', answer)).toBe(text);
  });
});

describe('checkMerge', () => {
  const realFetch = globalThis.fetch;
  const BASE = getServerConfig().orcidApiBaseUrl.replace(/\/$/, '');
  const REQUESTED = '0000-0002-7759-8499';
  const PRIMARY = '0000-0001-8143-9338';
  const appConfig = { mcpServerVersion: '9.9.9' } as unknown as AppConfig;
  const service = new OrcidService(appConfig, {} as unknown as StorageService);

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  /** Serve every request from `respond`; the mock records each one. */
  function stub(respond: (init?: RequestInit) => Promise<Response> | Response) {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      respond(init),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  /** An upstream that accepts the request and never answers. */
  const stall = (init?: RequestInit) =>
    new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
    );

  /** Track a check's settlement so a test can assert it is still pending at an instant. */
  function track(call: Promise<unknown>) {
    const state: { settled: boolean; value?: unknown; error?: unknown } = { settled: false };
    call.then(
      (value) => {
        state.settled = true;
        state.value = value;
      },
      (error: unknown) => {
        state.settled = true;
        state.error = error;
      },
    );
    return state;
  }

  const FAILED_WARNING = 'Merge check on /person failed; returning the answer unconfirmed.';
  /** Messages of the warnings `ctx` logged, the service's own included. */
  const warnings = (ctx: ReturnType<typeof createMockContext>) =>
    (ctx.log as MockContextLogger).calls
      .filter((record) => record.level === 'warning')
      .map((record) => record.msg);

  it('answers with the requested iD when /person is served as requested', async () => {
    const fetchMock = stub(() => Response.json({ name: null }));
    expect(await checkMerge(service, REQUESTED, createMockContext())).toEqual({
      status: 'answered',
      orcidId: REQUESTED,
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${BASE}/${REQUESTED}/person`]);
  });

  it('answers with the primary iD when /person redirects', async () => {
    stub(() => {
      const response = Response.json({ name: null });
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: `${BASE}/${PRIMARY}/person` },
      });
      return response;
    });
    expect(await checkMerge(service, REQUESTED, createMockContext())).toEqual({
      status: 'answered',
      orcidId: PRIMARY,
    });
  });

  it('reports a /person 404 as not_found, not as a failed check', async () => {
    const fetchMock = stub(() => new Response('', { status: 404 }));
    const ctx = createMockContext();
    expect(await checkMerge(service, REQUESTED, ctx)).toEqual({ status: 'not_found' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings(ctx)).not.toContain(FAILED_WARNING);
  });

  it.each([
    ['a 503 on every attempt', () => new Response('', { status: 503 }), 4],
    [
      'a 429 whose Retry-After outlasts the wait',
      () => new Response('', { status: 429, headers: { 'Retry-After': '20' } }),
      1,
    ],
    ['a 400', () => new Response('', { status: 400 }), 1],
    ['an incompatible body', () => Response.json([]), 1],
  ])('reports %s as failed and logs it', async (_label, respond, attempts) => {
    vi.useFakeTimers();
    const fetchMock = stub(respond);
    const ctx = createMockContext();
    const state = track(checkMerge(service, REQUESTED, ctx));

    await vi.advanceTimersByTimeAsync(10_000);

    expect(state).toMatchObject({ settled: true, value: { status: 'failed' } });
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
    expect((ctx.log as MockContextLogger).calls).toContainEqual(
      expect.objectContaining({
        level: 'warning',
        msg: FAILED_WARNING,
        data: { orcidId: REQUESTED },
      }),
    );
  });

  it('stops waiting on a /person that never answers after 10 s, well inside the 25 s call deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = stub(stall);
    const state = track(checkMerge(service, REQUESTED, createMockContext()));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(state).toMatchObject({ settled: true, value: { status: 'failed' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the call deadline has no time left', async () => {
    vi.useFakeTimers();
    // The call's first request answers after 20 s; 5 s later its 25 s budget is spent.
    const answerLate = () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(Response.json({ name: null })), 20_000);
      });
    const fetchMock = stub(answerLate);
    const ctx = createMockContext();
    const first = track(service.getPerson(REQUESTED, ctx));
    await vi.advanceTimersByTimeAsync(25_000);
    expect(first.settled).toBe(true);

    const state = track(checkMerge(service, REQUESTED, ctx));
    await vi.advanceTimersByTimeAsync(0);

    expect(state).toMatchObject({ settled: true, value: { status: 'failed' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows caller cancellation instead of reporting a failed check', async () => {
    vi.useFakeTimers();
    stub(stall);
    const controller = new AbortController();
    const ctx = createMockContext({ signal: controller.signal });
    const state = track(checkMerge(service, REQUESTED, ctx));

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(state.settled).toBe(true);
    expect((state.error as DOMException).name).toBe('AbortError');
    expect(warnings(ctx)).not.toContain(FAILED_WARNING);
  });
});
