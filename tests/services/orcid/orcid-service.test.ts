/**
 * @fileoverview Service-level tests: upstream ORCID/Solr error bodies must not leak their
 * internal host or exception text into client-visible error data (#18 info-leak fix), and
 * upstream 5xx responses classify and retry by whether a retry can succeed.
 * @module tests/services/orcid/orcid-service.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrcidService } from '@/services/orcid/orcid-service.js';

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

    const service = new OrcidService({} as unknown as AppConfig, {} as unknown as StorageService);
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

    const service = new OrcidService({} as unknown as AppConfig, {} as unknown as StorageService);
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

  it('still logs the URL server-side for operators', async () => {
    stubBadRequest(url);

    const service = new OrcidService({} as unknown as AppConfig, {} as unknown as StorageService);
    const ctx = createMockContext();
    const log = ctx.log as MockContextLogger;

    await service.getPerson('0000-0002-1825-0097', ctx).catch(() => undefined);

    expect(
      log.calls.some(
        (c) =>
          c.level === 'warning' && (c.data as Record<string, unknown> | undefined)?.url === url,
      ),
    ).toBe(true);
  });
});

describe('OrcidService — assertNotHtml message redaction (#28)', () => {
  // assertNotHtml is private; access it through a narrow structural cast rather than `any`.
  // Exercised directly (not via fetchJson) — the code it throws is transient, so routing
  // through the public surface would mean waiting out withRetry's real backoff delays.
  type AssertNotHtmlHost = { assertNotHtml(text: string, url: string, ctx: Context): void };

  const url = 'https://pub.orcid.org/v3.0/0000-0001-9161-999X/person';
  const html = '<!DOCTYPE html><html><body>Rate limited</body></html>';

  function newService(): OrcidService {
    return new OrcidService({} as unknown as AppConfig, {} as unknown as StorageService);
  }

  it('does not leak the upstream URL into the thrown message or data', () => {
    const ctx = createMockContext();

    let thrown: unknown;
    try {
      (newService() as unknown as AssertNotHtmlHost).assertNotHtml(html, url, ctx);
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

  it('still logs the URL server-side for operators', () => {
    const ctx = createMockContext();
    const log = ctx.log as MockContextLogger;

    expect(() =>
      (newService() as unknown as AssertNotHtmlHost).assertNotHtml(html, url, ctx),
    ).toThrow(McpError);

    expect(
      log.calls.some(
        (c) =>
          c.level === 'warning' && (c.data as Record<string, unknown> | undefined)?.url === url,
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

  const newService = () =>
    new OrcidService({} as unknown as AppConfig, {} as unknown as StorageService);

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
});
