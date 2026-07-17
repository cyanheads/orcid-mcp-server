/**
 * @fileoverview Service-level test: upstream ORCID/Solr error bodies must not leak their
 * internal host or exception text into client-visible error data (#18 info-leak fix).
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
