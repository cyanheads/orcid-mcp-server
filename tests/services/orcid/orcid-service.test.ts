/**
 * @fileoverview Service-level tests: upstream ORCID/Solr error bodies must not leak their
 * internal host or exception text into client-visible error data (#18 info-leak fix),
 * upstream 5xx responses classify and retry by whether a retry can succeed, one deadline
 * bounds every request a tool call makes (#64), and the User-Agent carries the server's
 * version (#65).
 * @module tests/services/orcid/orcid-service.test
 */

import { readFileSync } from 'node:fs';
import type { Context } from '@cyanheads/mcp-ts-core';
import { type AppConfig, config } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';
import { initOrcidService, OrcidService } from '@/services/orcid/orcid-service.js';

/** The only `AppConfig` field the service reads. */
const appConfig = { mcpServerVersion: '9.9.9' } as unknown as AppConfig;
const storage = {} as unknown as StorageService;

describe('OrcidService — endpoint labels in client-visible warnings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(['http', 'html', 'json', 'transport'] as const)(
    'labels %s failures without a request URL or transport message',
    async (failure) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (failure === 'transport') throw new TypeError(`Request failed at ${url}`);
          return new Response(failure === 'html' ? '<html>maintenance</html>' : 'not JSON', {
            status: failure === 'http' ? 400 : 200,
          });
        }),
      );
      const ctx = createMockContext();
      const call = new OrcidService(appConfig, storage)
        .expandedSearch({ q: 'family-name:"Carberry"', rows: 1 }, ctx)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await call).toBeInstanceOf(McpError);
      const warnings = (ctx.log as MockContextLogger).calls.filter(
        (record) => record.level === 'warning',
      );
      expect(warnings.length).toBeGreaterThan(0);
      for (const warning of warnings) {
        expect(warning.data).toMatchObject({ endpoint: 'expanded-search' });
        expect(warning.data).not.toHaveProperty('url');
        expect(warning.data).not.toHaveProperty('error');
      }
      expect(JSON.stringify(warnings)).not.toContain('https://');
      expect(JSON.stringify(warnings)).not.toContain('Request failed at');
    },
  );
});

describe('OrcidService — User-Agent version (#65)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  /** Make one call through `service` and return the User-Agent it sent. */
  async function userAgentSentBy(service: OrcidService): Promise<string | undefined> {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ name: null }));
    globalThis.fetch = fetchMock as typeof fetch;
    await service.getPerson('0000-0002-1825-0097', createMockContext());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    return (init.headers as Record<string, string>)['User-Agent'];
  }

  it('sends the version from the config it was built with', async () => {
    expect(await userAgentSentBy(new OrcidService(appConfig, storage))).toBe(
      'orcid-mcp-server/9.9.9 (https://github.com/cyanheads/orcid-mcp-server)',
    );
  });

  it("sends package.json's version when built from the framework config", async () => {
    const { version } = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(config.mcpServerVersion).toBe(version);
    expect(await userAgentSentBy(new OrcidService(config, storage))).toBe(
      `orcid-mcp-server/${version} (https://github.com/cyanheads/orcid-mcp-server)`,
    );
  });
});

describe('OrcidService — upstream error-body redaction (#18)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('keeps the ORCID Solr error body and internal host out of error.data', async () => {
    // A 400 mirrors ORCID's malformed-query response and is non-retryable (single call).
    // Its body echoes ORCID's internal Solr host — exactly what must not reach the client.
    const leakyBody =
      'org.apache.solr.search.SyntaxError at http://localhost:7983/solr/profile: undefined field 17';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(leakyBody, { status: 400, statusText: 'Bad Request' }));
    globalThis.fetch = fetchMock as typeof fetch;

    const service = new OrcidService(appConfig, storage);
    const ctx = createMockContext();

    const err = (await service
      .expandedSearch({ q: 'family-name:"O\\"Connor"', rows: 1 }, ctx)
      .catch((e: unknown) => e)) as { data?: Record<string, unknown> };

    const dataStr = JSON.stringify(err.data ?? {});
    // The internal Solr host and exception text live only in the response body — redacted.
    expect(dataStr).not.toContain('localhost:7983');
    expect(dataStr).not.toContain('SyntaxError');
    expect(err.data?.body).toBeUndefined();
    // 400 is non-transient — a single upstream call, no retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('OrcidService — upstream URL redaction on non-2xx (#31)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  // A 400 keeps the run to a single upstream call — InvalidParams is non-transient, so
  // withRetry fails fast instead of sleeping through its backoff schedule.
  // `new Response()` leaves `url` empty, so it is pinned explicitly: that getter is the
  // field httpErrorFromResponse copies into `data.url` when `includeUrl` is set, so an
  // empty one would let these assertions pass without exercising the redaction.
  function stubBadRequest(url: string): void {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      const res = new Response('bad request', { status: 400, statusText: 'Bad Request' });
      Object.defineProperty(res, 'url', { value: url });
      return Promise.resolve(res);
    }) as typeof fetch;
  }

  const url = 'https://pub.orcid.org/v3.0/0000-0002-1825-0097/person';

  it('keeps url off the thrown error data while keeping the status fields', async () => {
    stubBadRequest(url);

    const service = new OrcidService(appConfig, storage);
    const err = (await service
      .getPerson('0000-0002-1825-0097', createMockContext())
      .catch((e: unknown) => e)) as McpError;

    expect(err).toBeInstanceOf(McpError);
    // response.url is set, so a url key here would put the upstream endpoint on client-facing data.
    expect(err.data).toBeDefined();
    expect(Object.keys(err.data as Record<string, unknown>)).not.toContain('url');
    expect(JSON.stringify(err.data)).not.toContain('pub.orcid.org');
    // Everything withRetry and the framework classify on survives the redaction.
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data?.status).toBe(400);
    expect(err.data?.statusText).toBe('Bad Request');
    expect(err.data?.statusCode).toBe(400);
    // The message was already clean via `service: 'ORCID'` — assert it stays that way.
    expect(err.message).toBe('ORCID returned HTTP 400 Bad Request.');
  });

  it('logs the endpoint label without the upstream URL', async () => {
    stubBadRequest(url);

    const service = new OrcidService(appConfig, storage);
    const ctx = createMockContext();
    const log = ctx.log as MockContextLogger;

    await service.getPerson('0000-0002-1825-0097', ctx).catch(() => undefined);

    expect(
      log.calls.some(
        (c) =>
          c.level === 'warning' &&
          (c.data as Record<string, unknown> | undefined)?.endpoint === 'person',
      ),
    ).toBe(true);
  });
});

describe('OrcidService — assertNotHtml message redaction (#28)', () => {
  // assertNotHtml is private; access it through a narrow structural cast rather than `any`.
  // Exercised directly (not via fetchJson) — the code it throws is transient, so routing
  // through the public surface would mean waiting out withRetry's real backoff delays.
  type AssertNotHtmlHost = { assertNotHtml(text: string, endpoint: string, ctx: Context): void };

  const url = 'https://pub.orcid.org/v3.0/0000-0001-9161-999X/person';
  const html = '<!DOCTYPE html><html><body>Rate limited</body></html>';

  function newService(): OrcidService {
    return new OrcidService(appConfig, storage);
  }

  it('does not leak the upstream URL into the thrown message or data', () => {
    const ctx = createMockContext();

    let thrown: unknown;
    try {
      (newService() as unknown as AssertNotHtmlHost).assertNotHtml(html, 'person', ctx);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(McpError);
    const err = thrown as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).not.toContain(url);
    expect(err.message).not.toContain('pub.orcid.org');
    expect(err.message).toContain('ORCID');

    // No data argument is ever passed to the factory — nothing to redact, nothing to leak.
    expect(err.data).toBeUndefined();
  });

  it('logs the endpoint label without the upstream URL', () => {
    const ctx = createMockContext();
    const log = ctx.log as MockContextLogger;

    expect(() =>
      (newService() as unknown as AssertNotHtmlHost).assertNotHtml(html, 'person', ctx),
    ).toThrow(McpError);

    expect(
      log.calls.some(
        (c) =>
          c.level === 'warning' &&
          (c.data as Record<string, unknown> | undefined)?.endpoint === 'person',
      ),
    ).toBe(true);
  });
});

describe('OrcidService — upstream 5xx classification and retry', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** ORCID's body for a query its Solr backend rejects — captured from the live API. */
  const solrRejectionBody = JSON.stringify({
    'response-code': 500,
    'developer-message':
      "org.apache.solr.client.solrj.impl.HttpSolrClient.RemoteSolrException Full validation error: Error from server at http://localhost:7983/solr/profile: org.apache.solr.search.SyntaxError: Cannot parse 'family-name:[unclosed'",
    'user-message': 'Something went wrong in ORCID.',
    'error-code': 9008,
  });

  function stubStatus(status: number, statusText: string, body: string) {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(body, { status, statusText })));
    globalThis.fetch = fetchMock as typeof fetch;
    return fetchMock;
  }

  /** Run a service call to settlement while fake timers drain withRetry's backoff sleeps. */
  async function settle(call: Promise<unknown>): Promise<McpError> {
    const caught = call.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    return (await caught) as McpError;
  }

  const newService = () => new OrcidService(appConfig, storage);

  it('retries an upstream 500 outage as ServiceUnavailable until the retry budget is spent', async () => {
    vi.useFakeTimers();
    const fetchMock = stubStatus(500, 'Internal Server Error', 'upstream exploded');

    const err = await settle(newService().getPerson('0000-0002-1825-0097', createMockContext()));

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    // One initial attempt plus withRetry's default three retries.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(err.data?.retryAttempts).toBe(4);
    expect(err.data?.status).toBe(500);
    expect(err.data).not.toHaveProperty('url');
  });

  it('classifies a 500 carrying a Solr query rejection as InvalidParams without retrying', async () => {
    vi.useFakeTimers();
    const fetchMock = stubStatus(500, 'Internal Server Error', solrRejectionBody);

    const err = await settle(
      newService().expandedSearch({ q: 'family-name:[unclosed', rows: 1 }, createMockContext()),
    );

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.data?.status).toBe(500);
    // The body is read to classify, never forwarded — its Solr host and exception stay server-side.
    const dataStr = JSON.stringify(err.data ?? {});
    expect(dataStr).not.toContain('localhost:7983');
    expect(dataStr).not.toContain('SyntaxError');
    expect(err.message).not.toContain('RemoteSolrException');
  });

  it('fails a 501 on the first attempt with retryable: false', async () => {
    vi.useFakeTimers();
    const fetchMock = stubStatus(501, 'Not Implemented', 'not implemented');

    const err = await settle(newService().getWorks('0000-0002-1825-0097', createMockContext()));

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data?.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a short wait, honored on every retry', '2', 4],
    ['a wait the 25 s deadline cannot cover twice', '20', 2],
  ])("keeps a 429's retryAfter on the final error: %s", async (_, retryAfter, attempts) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response('slow down', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Retry-After': retryAfter },
        }),
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const err = await settle(newService().getPerson('0000-0002-1825-0097', createMockContext()));

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data?.retryAfter).toBe(retryAfter);
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
  });
});

describe('OrcidService — one deadline across the retry ladder, and transport failures (#64)', () => {
  const realFetch = globalThis.fetch;
  const ORCID_ID = '0000-0002-1825-0097';

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const newService = () => new OrcidService(appConfig, storage);

  /** Rejects the way a runtime fetch does when its signal aborts: with the signal's reason. */
  const rejectOnAbort = (signal: AbortSignal | null | undefined, reject: (e: unknown) => void) =>
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });

  /** An upstream that accepts the request and never answers. */
  function stubStall() {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => rejectOnAbort(init?.signal, reject)),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  /** Track a call's settlement so a test can assert it is still pending at a given instant. */
  function track(call: Promise<unknown>) {
    const state: { settled: boolean; error?: unknown } = { settled: false };
    call.then(
      () => {
        state.settled = true;
      },
      (error: unknown) => {
        state.settled = true;
        state.error = error;
      },
    );
    return state;
  }

  /** No upstream URL or host reaches the error a client is shown. */
  function expectNoUpstreamUrl(err: McpError) {
    const surface = JSON.stringify({ message: err.message, data: err.data ?? {} });
    expect(surface).not.toContain('pub.orcid.org');
    expect(surface).not.toContain('/v3.0/');
  }

  it('fails a stalled request as Timeout exactly when the 25 s budget runs out', async () => {
    vi.useFakeTimers();
    const fetchMock = stubStall();
    const state = track(newService().getPerson(ORCID_ID, createMockContext()));

    await vi.advanceTimersByTimeAsync(24_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);

    const err = state.error as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.message).toBe('ORCID request exceeded its 25000ms retry deadline after 1 attempt.');
    expect(err.data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      deadlineMs: 25_000,
      retryAttempts: 1,
    });
    expectNoUpstreamUrl(err);
    // The stalled attempt held the whole budget; the deadline aborted the signal it was given.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('bounds a response body that stops arriving by the same deadline', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"name":'));
          rejectOnAbort(init?.signal, (reason) => controller.error(reason));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;
    const state = track(newService().getPerson(ORCID_ID, createMockContext()));

    await vi.advanceTimersByTimeAsync(24_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const err = state.error as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data?.reason).toBe('retry_deadline_exceeded');
  });

  it('reports a refused connection as ServiceUnavailable after four attempts, with no URL', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((url: string | URL | Request) =>
      Promise.reject(new TypeError(`Unable to connect to ${String(url)}`)),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const state = track(
      newService().expandedSearch({ q: 'family-name:"Carberry"', rows: 1 }, createMockContext()),
    );

    await vi.advanceTimersByTimeAsync(25_000);

    const err = state.error as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe('The ORCID API could not be reached. (failed after 4 attempts)');
    expect(err.data?.retryAttempts).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expectNoUpstreamUrl(err);
    // The runtime's rejection stays on the cause, server-side only.
    expect((err.cause as McpError).cause).toBeInstanceOf(TypeError);
  });

  it('reports a connection reset mid-body as ServiceUnavailable', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError('Connection reset by peer'));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const state = track(newService().getWorks(ORCID_ID, createMockContext()));

    await vi.advanceTimersByTimeAsync(25_000);

    const err = state.error as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe('The ORCID API could not be reached. (failed after 4 attempts)');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('ends on a caller abort mid-attempt with the abort itself and no further attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = stubStall();
    const controller = new AbortController();
    const state = track(
      newService().getPerson(ORCID_ID, createMockContext({ signal: controller.signal })),
    );

    // Abort just before the deadline: the call must still end as a cancellation, never a Timeout.
    await vi.advanceTimersByTimeAsync(24_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(state.settled).toBe(true);
    expect(state.error).not.toBeInstanceOf(McpError);
    expect((state.error as DOMException).name).toBe('AbortError');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('a 2xx body that is not JSON', () => {
    /** Every attempt answers 200 with `body`. */
    function stubOk(body: string) {
      const fetchMock = vi.fn(() => Promise.resolve(new Response(body, { status: 200 })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      return fetchMock;
    }

    it('keeps an HTML page classified as ServiceUnavailable and retried', async () => {
      vi.useFakeTimers();
      const fetchMock = stubOk('<html>maintenance</html>');
      const state = track(
        newService().expandedSearch({ q: 'family-name:"Carberry"', rows: 1 }, createMockContext()),
      );

      await vi.advanceTimersByTimeAsync(25_000);

      const err = state.error as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toBe(
        'ORCID API returned HTML instead of JSON — likely rate-limited or under maintenance. (failed after 4 attempts)',
      );
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expectNoUpstreamUrl(err);
    });

    it.each([
      ['an empty body', ''],
      ['a body cut off mid-object', '{"num-found":3,"expanded-result":[{"orcid-id":"0000-'],
      ['an HTML fragment with no <html> tag', '<head><title>502 Bad Gateway</title></head>'],
      ['plain text', 'Service Temporarily Unavailable'],
    ])('classifies %s as ServiceUnavailable, retried four times', async (_, body) => {
      vi.useFakeTimers();
      const fetchMock = stubOk(body);
      const ctx = createMockContext();
      const state = track(
        newService().expandedSearch({ q: 'family-name:"Carberry"', rows: 1 }, ctx),
      );

      await vi.advanceTimersByTimeAsync(25_000);

      const err = state.error as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toBe(
        'ORCID API returned a response that is not valid JSON. (failed after 4 attempts)',
      );
      expect(err.data?.retryAttempts).toBe(4);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expectNoUpstreamUrl(err);
      if (body) expect(JSON.stringify({ m: err.message, d: err.data })).not.toContain(body);
      // A fixed endpoint label identifies the operation without its query or URL.
      expect(
        (ctx.log as MockContextLogger).calls.some(
          (c) =>
            c.level === 'warning' &&
            (c.data as Record<string, unknown> | undefined)?.endpoint === 'expanded-search',
        ),
      ).toBe(true);
    });

    it('is bounded by the same deadline when each answer is slow', async () => {
      vi.useFakeTimers();
      // Each attempt answers an empty 200 after 10 s, so the third attempt is in flight at 25 s.
      const fetchMock = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => resolve(new Response('', { status: 200 })), 10_000);
            rejectOnAbort(init?.signal, (reason) => {
              clearTimeout(timer);
              reject(reason);
            });
          }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const state = track(newService().getPerson(ORCID_ID, createMockContext()));

      await vi.advanceTimersByTimeAsync(25_000);

      const err = state.error as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data).toMatchObject({ reason: 'retry_deadline_exceeded', retryAttempts: 3 });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('ends on a caller abort during the backoff after it, with no further attempt', async () => {
      vi.useFakeTimers();
      const fetchMock = stubOk('');
      const controller = new AbortController();
      const state = track(
        newService().getPerson(ORCID_ID, createMockContext({ signal: controller.signal })),
      );

      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      expect(state.settled).toBe(true);
      expect(state.error).not.toBeInstanceOf(McpError);
      expect((state.error as DOMException).name).toBe('AbortError');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('one budget across every request of a tool call', () => {
    const NO_MATCHES = '{"num-found":0,"expanded-result":null}';

    /** Every request answers 200 with `body` after `delayMs`, unless its signal aborts first. */
    function stubSlow(delayMs: number, body: string) {
      const fetchMock = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => resolve(new Response(body, { status: 200 })), delayMs);
            rejectOnAbort(init?.signal, (reason) => {
              clearTimeout(timer);
              reject(reason);
            });
          }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      return fetchMock;
    }

    /** A byline name with an affiliation and both anchors: seven stages when nothing matches. */
    function resolveNobody(ctx = createMockContext({ errors: orcidResolveResearcher.errors })) {
      const input = orcidResolveResearcher.input.parse({
        name: 'J. Nobody',
        affiliation: 'Nowhere Institute',
        doi: '10.1234/none',
        pmid: '1',
      });
      return Promise.resolve(orcidResolveResearcher.handler(input, ctx));
    }

    it('gives a later request of the same call only what is left of the 25 s budget', async () => {
      vi.useFakeTimers();
      const fetchMock = stubSlow(20_000, '{"name":null}');
      const service = newService();
      const ctx = createMockContext();
      const state = track(
        service.getPerson(ORCID_ID, ctx).then(() => service.getPerson(ORCID_ID, ctx)),
      );

      await vi.advanceTimersByTimeAsync(24_999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(state.settled).toBe(true);
      const err = state.error as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data?.reason).toBe('retry_deadline_exceeded');
      expectNoUpstreamUrl(err);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('ends an orcid_resolve_researcher call whose stages each answer slowly at 25 s', async () => {
      initOrcidService(appConfig, storage);
      vi.useFakeTimers();
      // Each stage answers "no matches" after 6 s, so the fifth stage is in flight at 25 s.
      const fetchMock = stubSlow(6_000, NO_MATCHES);
      const state = track(resolveNobody());

      await vi.advanceTimersByTimeAsync(24_999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(state.settled).toBe(true);
      const err = state.error as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data?.reason).toBe('retry_deadline_exceeded');
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('runs every orcid_resolve_researcher stage when ORCID answers within the budget', async () => {
      initOrcidService(appConfig, storage);
      vi.useFakeTimers();
      const fetchMock = stubSlow(3_000, NO_MATCHES);
      const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
      const state = track(resolveNobody(ctx));

      await vi.advanceTimersByTimeAsync(21_000);

      expect(state.settled).toBe(true);
      expect(state.error).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(7);
      expect(getEnrichment(ctx)).toMatchObject({ queryUsed: 'pmid-self:"1"', totalFound: 0 });
    });
  });
});

describe('OrcidService — a deprecated iD resolves to its primary record (#80)', () => {
  const realFetch = globalThis.fetch;
  const BASE = getServerConfig().orcidApiBaseUrl.replace(/\/$/, '');
  /** Deprecated iD ORCID merged into PRIMARY; every redirecting section 301s to PRIMARY's. */
  const DEPRECATED = '0000-0002-7759-8499';
  const PRIMARY = '0000-0001-8143-9338';
  /** A source block for an item the researcher behind PRIMARY added themselves. */
  const byPrimary = { 'source-orcid': { path: PRIMARY }, 'source-name': { value: 'Researcher' } };
  /** The sparsest person section ORCID serves. */
  const PERSON = { name: null };

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /**
   * A `Response` as `fetch` returns it: when `finalUrl` is set, after following a redirect
   * there — `redirected: true` and `url` on the final location — otherwise unredirected.
   */
  function answer(body: unknown, finalUrl?: string): Response {
    const response = Response.json(body);
    if (finalUrl !== undefined)
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: finalUrl },
      });
    return response;
  }

  function stub(body: unknown, finalUrl?: string) {
    const fetchMock = vi.fn(async (_url: string) => answer(body, finalUrl));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  /** Every record method: its call, the section path, a body, and its first source. */
  type Case = {
    name: string;
    path: string;
    body: unknown;
    call: (s: OrcidService, id: string) => Promise<{ orcidId: string; data: unknown }>;
    source?: (data: never) => { selfAsserted: boolean } | undefined;
  };
  const cases: Case[] = [
    {
      name: 'getPerson',
      path: 'person',
      body: { name: null },
      call: (s, id) => s.getPerson(id, ctx()),
    },
    {
      name: 'getWorks',
      path: 'works',
      body: { group: [{ 'work-summary': [{ 'put-code': 1, source: byPrimary }] }] },
      call: (s, id) => s.getWorks(id, ctx()),
      source: (data: { sources: { selfAsserted: boolean }[] }[]) => data[0]?.sources[0],
    },
    {
      name: 'getAffiliations',
      path: 'activities',
      body: {
        employments: {
          'affiliation-group': [{ summaries: [{ 'employment-summary': { source: byPrimary } }] }],
        },
      },
      call: (s, id) => s.getAffiliations(id, ['employment'], ctx()),
      source: (data: { sources: { selfAsserted: boolean }[] }[]) => data[0]?.sources[0],
    },
    {
      name: 'getFundings',
      path: 'fundings',
      body: { group: [{ 'funding-summary': [{ 'put-code': 1, source: byPrimary }] }] },
      call: (s, id) => s.getFundings(id, ctx()),
      source: (data: { sources: { selfAsserted: boolean }[] }[]) => data[0]?.sources[0],
    },
    {
      name: 'getFundingDetail',
      path: 'funding/1',
      body: { 'put-code': 1, source: byPrimary },
      call: (s, id) => s.getFundingDetail(id, 1, ctx()),
      source: (data: { sources: { selfAsserted: boolean }[] }) => data.sources[0],
    },
    {
      name: 'getPeerReviews',
      path: 'peer-reviews',
      body: {
        group: [
          {
            'peer-review-group': [
              { 'peer-review-summary': [{ 'put-code': 1, source: byPrimary }] },
            ],
          },
        ],
      },
      call: (s, id) => s.getPeerReviews(id, ctx()),
      source: (data: { sources: { selfAsserted: boolean }[] }[]) => data[0]?.sources[0],
    },
    {
      name: 'getWorkDetails',
      path: 'works/1',
      body: { bulk: [{ work: { 'put-code': 1, source: byPrimary } }] },
      call: (s, id) => s.getWorkDetails(id, [1], ctx()),
      source: (data: { detail?: { sources: { selfAsserted: boolean }[] } }[]) =>
        data[0]?.detail?.sources[0],
    },
    {
      name: 'getResearchResources',
      path: 'research-resources',
      body: { group: [{ 'research-resource-summary': [{ 'put-code': 1, source: byPrimary }] }] },
      call: (s, id) => s.getResearchResources(id, ctx()),
      source: (data: { sources: { selfAsserted: boolean }[] }[]) => data[0]?.sources[0],
    },
    {
      name: 'getResearchResourceDetail',
      path: 'research-resource/1',
      body: { 'put-code': 1, source: byPrimary },
      call: (s, id) => s.getResearchResourceDetail(id, 1, ctx()),
      source: (data: { sources: { selfAsserted: boolean }[] }) => data.sources[0],
    },
  ];
  const ctx = () => createMockContext();
  const service = () => new OrcidService(appConfig, storage);

  it.each(cases)(
    '$name reports the redirect target as the record iD and compares selfAsserted to it',
    async ({ path, body, call, source }) => {
      const fetchMock = stub(body, `${BASE}/${PRIMARY}/${path}`);
      const result = await call(service(), DEPRECATED);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/${DEPRECATED}/${path}`);
      expect(result.orcidId).toBe(PRIMARY);
      if (source)
        expect(source(result.data as never)).toEqual({ name: 'Researcher', selfAsserted: true });
    },
  );

  it.each(cases)(
    '$name reports the requested iD of an unredirected response and compares selfAsserted to it',
    async ({ path, body, call, source }) => {
      const fetchMock = stub(body);
      const result = await call(service(), `https://orcid.org/${DEPRECATED}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/${DEPRECATED}/${path}`);
      expect(result.orcidId).toBe(DEPRECATED);
      // The item's asserting party is PRIMARY, not the iD the record was served under.
      if (source)
        expect(source(result.data as never)).toEqual({ name: 'Researcher', selfAsserted: false });
    },
  );

  it('keeps the iD of a redirect that stays on the same record', async () => {
    stub(PERSON, `${BASE}/${DEPRECATED}/person`);
    expect((await service().getPerson(DEPRECATED, ctx())).orcidId).toBe(DEPRECATED);
  });

  it('canonicalizes a lowercase check digit in the redirect target', async () => {
    stub(PERSON, `${BASE}/0000-0002-9999-111x/person`);
    expect((await service().getPerson(DEPRECATED, ctx())).orcidId).toBe('0000-0002-9999-111X');
  });

  it.each([
    ['another origin', `https://orcid.example/v3.0/${PRIMARY}/person`],
    ['another port on the API host', `${BASE.replace('.org', '.org:8443')}/${PRIMARY}/person`],
    ['another path on the API origin', `${new URL(BASE).origin}/v2.1/${PRIMARY}/person`],
    ['no iD segment', `${BASE}/person`],
    ['an iD with a bad check digit', `${BASE}/0000-0001-8143-9339/person`],
    ['a prefixed iD segment', `${BASE}/orcid.org${PRIMARY}/person`],
  ])('fails a redirect to %s as invalid_upstream_response without a retry', async (_, finalUrl) => {
    const fetchMock = stub(PERSON, finalUrl);
    const context = createMockContext();
    const error = (await service()
      .getPerson(DEPRECATED, context)
      .catch((e: unknown) => e)) as McpError;
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'invalid_upstream_response', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Neither the error nor its log line carries the redirect target.
    const warnings = (context.log as MockContextLogger).calls.filter((r) => r.level === 'warning');
    expect(warnings).toEqual([expect.objectContaining({ data: { endpoint: 'person' } })]);
    expect(JSON.stringify([error.message, error.data, warnings])).not.toContain(finalUrl);
  });
});
