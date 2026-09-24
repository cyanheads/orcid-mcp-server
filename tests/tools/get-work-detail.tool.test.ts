/**
 * @fileoverview Tests for orcidGetWorkDetail tool (bulk put-codes).
 * @module tests/tools/get-work-detail.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { orcidGetWorkDetail } from '@/mcp-server/tools/definitions/get-work-detail.tool.js';

const mockGetWorkDetails = vi.fn();
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ getWorkDetails: mockGetWorkDetails }),
  normalizeOrcidId: (id: string) => id.replace(/^https?:\/\/orcid\.org\//, '').trim(),
}));

/** Canonical work detail returned by the service (normalized shape). */
const workDetailA = {
  putCode: 215949386,
  title: 'CRISPR-Cas9 Programmable Genome Editing',
  subtitle: 'A Versatile Tool for Genome Engineering',
  workType: 'journal-article',
  publicationDate: '2012-08',
  journalTitle: 'Science',
  abstract:
    'We describe the application of the type II CRISPR-Cas9 system for programmable genome editing.',
  citation: {
    type: 'bibtex',
    value: '@article{doudna2012,\n\ttitle = {CRISPR-Cas9}\n}',
  },
  url: 'https://doi.org/10.1126/science.1225829',
  externalIds: [
    {
      type: 'doi',
      value: '10.1126/science.1225829',
      url: 'https://doi.org/10.1126/science.1225829',
      relationship: 'self',
    },
    { type: 'pmid', value: '22745249' },
  ],
  contributors: [
    { name: 'Jinek M', role: 'author', sequence: 'first' },
    { name: 'Chylinski K', role: 'author', sequence: 'additional' },
    { name: 'Doudna JA', role: 'author', sequence: 'additional', orcidId: '0000-0001-9161-999X' },
  ],
  languageCode: 'en',
};

const workDetailB = {
  putCode: 99999,
  externalIds: [],
  contributors: [],
};

describe('orcidGetWorkDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  it('rejects invalid ORCID iD at input validation', () => {
    expect(() =>
      orcidGetWorkDetail.input.parse({ orcid_id: 'not-valid', put_codes: [123] }),
    ).toThrow();
  });

  it('rejects non-integer put_code in array', () => {
    expect(() =>
      orcidGetWorkDetail.input.parse({ orcid_id: '0000-0001-9161-999X', put_codes: [1.5] }),
    ).toThrow();
  });

  it('rejects empty put_codes array', () => {
    expect(() =>
      orcidGetWorkDetail.input.parse({ orcid_id: '0000-0001-9161-999X', put_codes: [] }),
    ).toThrow();
  });

  it('rejects put_codes array exceeding 100 entries', () => {
    const codes = Array.from({ length: 101 }, (_, i) => i + 1);
    expect(() =>
      orcidGetWorkDetail.input.parse({ orcid_id: '0000-0001-9161-999X', put_codes: codes }),
    ).toThrow();
  });

  it('accepts exactly 100 put-codes', () => {
    const codes = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(() =>
      orcidGetWorkDetail.input.parse({ orcid_id: '0000-0001-9161-999X', put_codes: codes }),
    ).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Single put-code (common case)
  // ---------------------------------------------------------------------------

  it('returns full work detail for a single put-code', async () => {
    mockGetWorkDetails.mockResolvedValueOnce([{ type: 'work', detail: workDetailA }]);

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [215949386],
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result.orcidId).toBe('0000-0001-9161-999X');
    expect(result.orcidUri).toBe('https://orcid.org/0000-0001-9161-999X');
    expect(result.works).toHaveLength(1);
    expect(result.errors).toHaveLength(0);

    const work = result.works[0];
    assert(work);
    expect(work.putCode).toBe(215949386);
    expect(work.title).toBe('CRISPR-Cas9 Programmable Genome Editing');
    expect(work.subtitle).toBe('A Versatile Tool for Genome Engineering');
    expect(work.workType).toBe('journal-article');
    expect(work.publicationDate).toBe('2012-08');
    expect(work.journalTitle).toBe('Science');
    expect(work.abstract).toContain('CRISPR-Cas9');
    expect(work.citation?.type).toBe('bibtex');
    expect(work.url).toBe('https://doi.org/10.1126/science.1225829');
    expect(work.externalIds).toHaveLength(2);
    expect(work.contributors).toHaveLength(3);
    expect(work.contributors[2]!.orcidId).toBe('0000-0001-9161-999X');
    expect(work.languageCode).toBe('en');
  });

  it('strips ORCID URI prefix from input', async () => {
    mockGetWorkDetails.mockResolvedValueOnce([{ type: 'work', detail: workDetailA }]);

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: 'https://orcid.org/0000-0001-9161-999X',
      put_codes: [215949386],
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);
    expect(result.orcidId).toBe('0000-0001-9161-999X');
  });

  // ---------------------------------------------------------------------------
  // Bulk put-codes
  // ---------------------------------------------------------------------------

  it('returns multiple work details for a bulk request', async () => {
    mockGetWorkDetails.mockResolvedValueOnce([
      { type: 'work', detail: workDetailA },
      { type: 'work', detail: workDetailB },
    ]);

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [215949386, 99999],
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result.works).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.works[0]!.putCode).toBe(215949386);
    expect(result.works[1]!.putCode).toBe(99999);
  });

  // ---------------------------------------------------------------------------
  // Sparse / minimal records
  // ---------------------------------------------------------------------------

  it('handles sparse work (no abstract, no contributors, no citation)', async () => {
    mockGetWorkDetails.mockResolvedValueOnce([{ type: 'work', detail: workDetailB }]);

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0002-1825-0097',
      put_codes: [99999],
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result.works).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    const work = result.works[0];
    assert(work);
    expect(work.putCode).toBe(99999);
    expect(work.title).toBeUndefined();
    expect(work.abstract).toBeUndefined();
    expect(work.citation).toBeUndefined();
    expect(work.journalTitle).toBeUndefined();
    expect(work.contributors).toEqual([]);
    expect(work.externalIds).toEqual([]);
    expect(() => orcidGetWorkDetail.output.parse(result)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Partial-error responses (mix of work + error entries)
  // ---------------------------------------------------------------------------

  it('surfaces per-record errors alongside successful records', async () => {
    mockGetWorkDetails.mockResolvedValueOnce([
      { type: 'work', detail: workDetailA },
      { type: 'error', putCode: 999, message: '404 Not Found — put-code 999 does not exist' },
    ]);

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [215949386, 999],
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result.works).toHaveLength(1);
    expect(result.works[0]!.putCode).toBe(215949386);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.putCode).toBe(999);
    expect(result.errors[0]!.message).toContain('Not Found');
  });

  it('returns all errors when all put-codes fail', async () => {
    mockGetWorkDetails.mockResolvedValueOnce([
      { type: 'error', putCode: 1, message: 'Not found' },
      { type: 'error', putCode: 2, message: 'Access denied' },
    ]);

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [1, 2],
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result.works).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]!.putCode).toBe(1);
    expect(result.errors[1]!.putCode).toBe(2);
  });

  it('handles error entries without a put-code', async () => {
    mockGetWorkDetails.mockResolvedValueOnce([
      { type: 'error', message: 'Unexpected server error' },
    ]);

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [123],
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result.works).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.putCode).toBeUndefined();
    expect(result.errors[0]!.message).toBe('Unexpected server error');
  });

  // ---------------------------------------------------------------------------
  // Profile-level failures (whole-request errors, not per-record bulk errors)
  // ---------------------------------------------------------------------------

  it('maps a whole-request 404 to profile_not_found and redacts transport details', async () => {
    // Confirmed live: a bulk request against a non-existent iD 404s the entire request.
    // The upstream McpError carries url/status/statusText in data — none may reach the client.
    mockGetWorkDetails.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.NotFound, 'ORCID returned HTTP 404 Not Found.', {
        url: 'https://pub.orcid.org/v3.0/9999-9999-9999-9994/works/1',
        status: 404,
        statusText: 'Not Found',
      }),
    );

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '9999-9999-9999-9994',
      put_codes: [1],
    });
    const error = await Promise.resolve(orcidGetWorkDetail.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);

    const data = (error as McpError).data as { reason?: string; recovery?: { hint?: string } };
    expect(data.reason).toBe('profile_not_found');
    expect(data.recovery?.hint).toBeDefined();

    // Redaction: fresh data must not inherit the caught error's transport fields.
    const raw = (error as McpError).data as Record<string, unknown>;
    expect(raw).not.toHaveProperty('url');
    expect(raw).not.toHaveProperty('status');
    expect(raw).not.toHaveProperty('statusText');
    expect(raw).not.toHaveProperty('body');
  });

  it('preserves the code for a transient ServiceUnavailable failure and redacts transport details', async () => {
    // A transient upstream failure (retries already exhausted by withRetry in the service
    // layer) must keep its original code — collapsing it to fetch_failed/InternalError would
    // downgrade the retryable signal consumers key on.
    mockGetWorkDetails.mockRejectedValueOnce(
      new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'ORCID returned HTTP 503 Service Unavailable.',
        {
          url: 'https://pub.orcid.org/v3.0/0000-0001-9161-999X/works/1',
          status: 503,
          statusText: 'Service Unavailable',
          retryable: true,
        },
      ),
    );

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [1],
    });
    const error = await Promise.resolve(orcidGetWorkDetail.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(McpError);
    // Code preserved — NOT downgraded to fetch_failed/InternalError.
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);

    const data = (error as McpError).data as Record<string, unknown>;
    expect(data).not.toHaveProperty('url');
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('statusText');
    expect(data).not.toHaveProperty('body');
    expect(data.retryable).toBe(true);
    expect((error as McpError).cause).toBeInstanceOf(Error);
  });

  it('keeps a 501 as ServiceUnavailable with retryable: false on both result surfaces', async () => {
    // An upstream 501 classifies as ServiceUnavailable carrying the retryable opt-out.
    // The tool must pass both through, so a client neither sees fetch_failed nor retries.
    mockGetWorkDetails.mockRejectedValueOnce(
      new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'ORCID returned HTTP 501 Not Implemented.',
        {
          status: 501,
          statusText: 'Not Implemented',
          retryable: false,
        },
      ),
    );

    const result = await runToolContract(orcidGetWorkDetail, {
      orcid_id: '0000-0001-9161-999X',
      put_codes: [1],
    });

    expect(result.isError).toBe(true);
    const envelope = (
      result.structuredContent as {
        error: { code: number; message: string; data?: Record<string, unknown> };
      }
    ).error;
    expect(envelope.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(envelope.data?.retryable).toBe(false);
    expect(envelope.data).not.toHaveProperty('reason');
    expect(envelope.data).not.toHaveProperty('status');

    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(text).toContain('ORCID bulk works endpoint is unavailable for 0000-0001-9161-999X.');
    expect(text).not.toContain('fetch_failed');
  });

  it('keeps a Timeout as Timeout with its sanitized message and forwarded retryable', async () => {
    mockGetWorkDetails.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.Timeout, 'ORCID returned HTTP 504 Gateway Timeout.', {
        status: 504,
        statusText: 'Gateway Timeout',
        body: '<html>upstream gateway page</html>',
        retryable: true,
      }),
    );

    const result = await runToolContract(orcidGetWorkDetail, {
      orcid_id: '0000-0001-9161-999X',
      put_codes: [1],
    });

    const envelope = (
      result.structuredContent as {
        error: { code: number; message: string; data?: Record<string, unknown> };
      }
    ).error;
    expect(envelope.code).toBe(JsonRpcErrorCode.Timeout);
    expect(envelope.message).toBe('ORCID bulk works endpoint timed out for 0000-0001-9161-999X.');
    expect(envelope.data).toStrictEqual({ retryable: true });
  });

  describe('an exhausted upstream rate limit', () => {
    /** Upstream 429 as the service raises it: transport fields ride on `data`. */
    const rateLimited = (retryData: Record<string, unknown>) =>
      new McpError(
        JsonRpcErrorCode.RateLimited,
        'ORCID returned HTTP 429 Too Many Requests. (failed after 4 attempts)',
        {
          url: 'https://pub.orcid.org/v3.0/0000-0001-9161-999X/works/1',
          status: 429,
          statusText: 'Too Many Requests',
          statusCode: 429,
          body: 'Rate limit exceeded for 203.0.113.7',
          retryAttempts: 4,
          ...retryData,
        },
      );

    it.each([
      ['retryAfter alone', { retryAfter: '30' }],
      ['retryable alone', { retryable: true }],
      ['both', { retryAfter: 45, retryable: true }],
      ['neither', {}],
    ])(
      'stays RateLimited and forwards exactly the retry metadata it carried (%s)',
      async (_, retryData) => {
        mockGetWorkDetails.mockRejectedValueOnce(rateLimited(retryData));

        const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
        const input = orcidGetWorkDetail.input.parse({
          orcid_id: '0000-0001-9161-999X',
          put_codes: [1],
        });
        const error = await Promise.resolve(orcidGetWorkDetail.handler(input, ctx)).catch(
          (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
        expect((error as McpError).message).toBe(
          'ORCID bulk works endpoint is rate-limited for 0000-0001-9161-999X.',
        );
        // Fresh data: only the retry signals survive — no URL, status, body, or attempt count.
        expect((error as McpError).data).toStrictEqual(retryData);
        expect((error as McpError).cause).toBeInstanceOf(McpError);
      },
    );

    it('reaches both result surfaces as RateLimited, not fetch_failed', async () => {
      mockGetWorkDetails.mockRejectedValueOnce(rateLimited({ retryAfter: '30' }));

      const result = await runToolContract(orcidGetWorkDetail, {
        orcid_id: '0000-0001-9161-999X',
        put_codes: [1],
      });

      expect(result.isError).toBe(true);
      const envelope = (
        result.structuredContent as {
          error: { code: number; message: string; data?: Record<string, unknown> };
        }
      ).error;
      expect(envelope.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(envelope.data).toStrictEqual({ retryAfter: '30' });
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      expect(text).toContain('ORCID bulk works endpoint is rate-limited for 0000-0001-9161-999X.');
      expect(text).not.toContain('fetch_failed');
      expect(text).not.toContain('pub.orcid.org');
      expect(text).not.toContain('203.0.113.7');
    });
  });

  it('forwards no retryable flag on a transient failure that carried none', async () => {
    mockGetWorkDetails.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'ORCID returned HTTP 503.', {
        status: 503,
      }),
    );

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [1],
    });
    const error = await Promise.resolve(orcidGetWorkDetail.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((error as McpError).data).toStrictEqual({});
  });

  it('wraps an unexpected (non-McpError) service failure as fetch_failed', async () => {
    mockGetWorkDetails.mockRejectedValueOnce(new Error('Network timeout'));

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [215949386],
    });
    const error = await Promise.resolve(orcidGetWorkDetail.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.InternalError);
    const data = (error as McpError).data as { reason?: string; recovery?: { hint?: string } };
    expect(data.reason).toBe('fetch_failed');
    expect(data.recovery?.hint).toBeDefined();
    // The original error is chained as cause for server-side debugging but never serialized.
    expect((error as McpError).cause).toBeInstanceOf(Error);
    expect(data).not.toHaveProperty('url');
  });

  it('wraps a non-NotFound McpError from the service as fetch_failed with fresh data', async () => {
    mockGetWorkDetails.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.InvalidParams, 'ORCID returned HTTP 400 Bad Request.', {
        url: 'https://pub.orcid.org/v3.0/x/works/1',
        status: 400,
      }),
    );

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [1],
    });
    const error = await Promise.resolve(orcidGetWorkDetail.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(McpError);
    const data = (error as McpError).data as { reason?: string };
    expect(data.reason).toBe('fetch_failed');
    // Even an McpError with a leaky data payload is re-wrapped with fresh, redacted data.
    expect(data).not.toHaveProperty('url');
    expect(data).not.toHaveProperty('status');
  });

  // ---------------------------------------------------------------------------
  // Responses under the byte budget
  // ---------------------------------------------------------------------------

  it('returns an under-budget response byte-identical on both surfaces', async () => {
    mockGetWorkDetails.mockResolvedValueOnce([
      { type: 'work', detail: workDetailA },
      { type: 'error', putCode: 999, message: "'999' is not a valid put code" },
    ]);

    const result = await runToolContract(orcidGetWorkDetail, {
      orcid_id: '0000-0001-9161-999X',
      put_codes: [215949386, 999],
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toStrictEqual({
      orcidId: '0000-0001-9161-999X',
      orcidUri: 'https://orcid.org/0000-0001-9161-999X',
      works: [workDetailA],
      errors: [{ putCode: 999, message: "'999' is not a valid put code" }],
    });
    expect(result.content).toHaveLength(1);
    expect(
      result.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
    ).toMatchInlineSnapshot(`
        "**ORCID iD:** 0000-0001-9161-999X | **URI:** https://orcid.org/0000-0001-9161-999X
        **Works resolved:** 1 | **Errors:** 1

        ---
        ## CRISPR-Cas9 Programmable Genome Editing
        **Put-code:** 215949386
        **Subtitle:** A Versatile Tool for Genome Engineering
        **Type:** journal-article
        **Date:** 2012-08
        **Journal:** Science
        **URL:** https://doi.org/10.1126/science.1225829
        **IDs:** doi:10.1126/science.1225829 (https://doi.org/10.1126/science.1225829) [self], pmid:22745249

        **Abstract:** We describe the application of the type II CRISPR-Cas9 system for programmable genome editing.

        **Contributors:**
        - Jinek M — author (first)
        - Chylinski K — author (additional)
        - Doudna JA — author (additional) [0000-0001-9161-999X]

        **Citation (bibtex):**
        \`\`\`
        @article{doudna2012,
        	title = {CRISPR-Cas9}
        }
        \`\`\`
        **Language:** en

        ---
        **Errors:**
        - '999' is not a valid put code (put-code 999)"
      `);
  });

  // ---------------------------------------------------------------------------
  // format()
  // ---------------------------------------------------------------------------

  it('formats a single work with all fields rendered', () => {
    const output = orcidGetWorkDetail.output.parse({
      orcidId: '0000-0001-9161-999X',
      orcidUri: 'https://orcid.org/0000-0001-9161-999X',
      works: [
        {
          putCode: 215949386,
          title: 'CRISPR-Cas9 Programmable Genome Editing',
          subtitle: 'A Versatile Tool',
          workType: 'journal-article',
          publicationDate: '2012-08',
          journalTitle: 'Science',
          abstract: 'Abstract text here.',
          citation: { type: 'bibtex', value: '@article{...}' },
          url: 'https://doi.org/10.1126/science.1225829',
          externalIds: [{ type: 'doi', value: '10.1126/science.1225829' }],
          contributors: [{ name: 'Jinek M', role: 'author', sequence: 'first' }],
          languageCode: 'en',
        },
      ],
      errors: [],
    });

    const blocks = orcidGetWorkDetail.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0000-0001-9161-999X');
    expect(text).toContain('CRISPR-Cas9 Programmable Genome Editing');
    expect(text).toContain('215949386');
    expect(text).toContain('A Versatile Tool');
    expect(text).toContain('journal-article');
    expect(text).toContain('2012-08');
    expect(text).toContain('Science');
    expect(text).toContain('Abstract text here.');
    expect(text).toContain('bibtex');
    expect(text).toContain('@article{...}');
    expect(text).toContain('doi:10.1126/science.1225829');
    expect(text).toContain('Jinek M');
    expect(text).toContain('author');
    expect(text).toContain('en');
    expect(text).toContain('Works resolved:** 1');
    expect(text).toContain('Errors:** 0');
  });

  it('formats multiple works with section separators', () => {
    const output = orcidGetWorkDetail.output.parse({
      orcidId: '0000-0001-9161-999X',
      orcidUri: 'https://orcid.org/0000-0001-9161-999X',
      works: [
        { putCode: 1, title: 'First Work', externalIds: [], contributors: [] },
        { putCode: 2, title: 'Second Work', externalIds: [], contributors: [] },
      ],
      errors: [],
    });

    const text = (orcidGetWorkDetail.format!(output)[0] as { text: string }).text;
    expect(text).toContain('First Work');
    expect(text).toContain('Second Work');
    expect(text).toContain('---');
  });

  it('formats an untitled work without crashing', () => {
    const output = orcidGetWorkDetail.output.parse({
      orcidId: '0000-0002-1825-0097',
      orcidUri: 'https://orcid.org/0000-0002-1825-0097',
      works: [{ putCode: 1, externalIds: [], contributors: [] }],
      errors: [],
    });

    const text = (orcidGetWorkDetail.format!(output)[0] as { text: string }).text;
    expect(text).toContain('(untitled)');
  });

  it('renders error section in formatted output', () => {
    const output = orcidGetWorkDetail.output.parse({
      orcidId: '0000-0001-9161-999X',
      orcidUri: 'https://orcid.org/0000-0001-9161-999X',
      works: [],
      errors: [{ putCode: 999, message: '404 Not Found' }, { message: 'Access denied' }],
    });

    const text = (orcidGetWorkDetail.format!(output)[0] as { text: string }).text;
    expect(text).toContain('Errors:');
    expect(text).toContain('404 Not Found');
    expect(text).toContain('put-code 999');
    expect(text).toContain('Access denied');
  });

  it('renders the deferred put-codes in formatted output', () => {
    const output = orcidGetWorkDetail.output.parse({
      orcidId: '0000-0001-9161-999X',
      orcidUri: 'https://orcid.org/0000-0001-9161-999X',
      works: [{ putCode: 1, title: 'First Work', externalIds: [], contributors: [] }],
      errors: [],
      deferredPutCodes: [2, 3],
    });

    const text = (orcidGetWorkDetail.format!(output)[0] as { text: string }).text;
    expect(text).toContain('**Deferred put-codes:** 2, 3');
  });

  // ---------------------------------------------------------------------------
  // Byte budget on structuredContent (#36)
  // ---------------------------------------------------------------------------

  describe('byte budget on structuredContent (#36)', () => {
    const BUDGET = 64_000;
    const ORCID = '0000-0001-9161-999X';
    const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const textOf = (result: { content: { type: string; text?: string }[] }) =>
      result.content.map((block) => block.text ?? '').join('');

    /** A detail record sized like the live abstract-bearing records (~2.2 KB structured). */
    const detailFor = (putCode: number, abstractLength: number) => ({
      putCode,
      title: `Work ${putCode}`,
      workType: 'journal-article',
      publicationDate: '2020-01',
      journalTitle: 'Nature Structural & Molecular Biology',
      abstract: 'ä'.repeat(abstractLength / 2),
      externalIds: [{ type: 'doi', value: `10.1038/${putCode}`, relationship: 'self' }],
      contributors: [{ name: 'Doudna JA', role: 'author', sequence: 'first' }],
    });

    /**
     * Fake the live bulk endpoint: one work per distinct put-code, in an order that is not the
     * request order (the live endpoint picks its own; reversed here), then an invalid-put-code
     * error entry for every repeated occurrence of a code.
     */
    function serveBulk(abstractLength: (putCode: number) => number = () => 1_800) {
      mockGetWorkDetails.mockImplementation(async (_id: string, putCodes: number[]) => {
        const distinct = [...new Set(putCodes)];
        const repeats = putCodes.filter((code, i) => putCodes.indexOf(code) !== i);
        return [
          ...distinct
            .toReversed()
            .map((code) => ({ type: 'work', detail: detailFor(code, abstractLength(code)) })),
          ...repeats.map((code) => ({
            type: 'error',
            putCode: code,
            message: `400 Bad Request: '${code}' is not a valid put code`,
          })),
        ];
      });
    }

    type Detail = {
      works: { putCode: number }[];
      errors: { putCode?: number }[];
      deferredPutCodes?: number[];
      notice?: string;
    };

    async function call(putCodes: number[]) {
      const result = await runToolContract(orcidGetWorkDetail, {
        orcid_id: ORCID,
        put_codes: putCodes,
      });
      expect(result.isError).toBeFalsy();
      return { result, structured: result.structuredContent as Detail };
    }

    const hundred = Array.from({ length: 100 }, (_, i) => 300_000 + i);

    beforeEach(() => {
      mockGetWorkDetails.mockReset();
    });

    it('defers every put-code past the budget and says so on both surfaces', async () => {
      serveBulk();
      const { result, structured } = await call(hundred);

      expect(bytesOf(result.structuredContent)).toBeLessThanOrEqual(BUDGET);
      const returned = structured.works.map((w) => w.putCode);
      expect(returned.length).toBeGreaterThan(0);
      expect(returned.length).toBeLessThan(100);
      expect(structured.errors).toEqual([]);
      // Records are kept in upstream order; what is deferred is the rest, in request order.
      expect(returned).toEqual(hundred.toReversed().slice(0, returned.length));
      expect(structured.deferredPutCodes).toEqual(hundred.slice(0, 100 - returned.length));
      expect(structured.notice).toContain(`${100 - returned.length} put-codes`);
      expect(structured.notice).toContain('deferredPutCodes');

      const text = textOf(result);
      expect(text).toContain(`> ${structured.notice}`);
      expect(text).toContain(`**Deferred put-codes:** ${structured.deferredPutCodes!.join(', ')}`);
    });

    it('resolves the rest when re-called with deferredPutCodes, each put-code exactly once', async () => {
      serveBulk();
      const resolved: number[] = [];
      let pending: number[] | undefined = hundred;
      let calls = 0;
      while (pending) {
        const { result, structured } = await call(pending);
        expect(bytesOf(result.structuredContent)).toBeLessThanOrEqual(BUDGET);
        resolved.push(...structured.works.map((w) => w.putCode));
        pending = structured.deferredPutCodes;
        calls++;
      }

      expect(resolved).toHaveLength(100);
      expect(resolved.toSorted((a, b) => a - b)).toEqual(hundred);
      expect(calls).toBeGreaterThan(1);
    });

    it('returns one record alone when it by itself exceeds the budget', async () => {
      // 300_002 comes back first from the fake endpoint.
      serveBulk((code) => (code === 300_002 ? 140_000 : 1_800));
      const { result, structured } = await call(hundred.slice(0, 3));

      expect(structured.works.map((w) => w.putCode)).toEqual([300_002]);
      expect(structured.deferredPutCodes).toEqual([300_000, 300_001]);
      expect(bytesOf(result.structuredContent)).toBeGreaterThan(BUDGET);
    });

    it('keeps the whole response under 130,000 bytes when the text outweighs the structured records', async () => {
      // Untitled records whose contributors carry no field: `{}` in JSON, `- (unnamed)` in text.
      mockGetWorkDetails.mockImplementation(async (_id: string, putCodes: number[]) =>
        putCodes.map((putCode) => ({
          type: 'work',
          detail: {
            putCode,
            externalIds: [],
            contributors: Array.from({ length: 200 }, () => ({})),
          },
        })),
      );
      const { result, structured } = await call(hundred);

      const textBytes = Buffer.byteLength(textOf(result));
      expect(bytesOf(result.structuredContent)).toBeLessThanOrEqual(BUDGET);
      expect(bytesOf(result.structuredContent) + textBytes).toBeLessThan(130_000);
      expect(structured.deferredPutCodes).toHaveLength(100 - structured.works.length);
    });

    describe('a repeated put-code (#49)', () => {
      it('resolves once and is never also reported as an error', async () => {
        serveBulk();
        const [a] = hundred;
        const { result, structured } = await call([a!, a!]);

        expect(structured.works.map((w) => w.putCode)).toEqual([a]);
        expect(structured.errors).toEqual([]);
        expect(structured).not.toHaveProperty('deferredPutCodes');
        const text = textOf(result);
        expect(text).toContain('**Works resolved:** 1 | **Errors:** 0');
        expect(text).not.toContain('not a valid put code');
      });

      it('resolves each put-code once in a batch that fits', async () => {
        serveBulk(() => 25_000);
        const [a, b] = hundred;
        const { result, structured } = await call([a!, b!, a!]);

        expect(structured.works.map((w) => w.putCode)).toEqual([b, a]);
        expect(structured.errors).toEqual([]);
        expect(structured).not.toHaveProperty('deferredPutCodes');
        expect(bytesOf(result.structuredContent)).toBeLessThanOrEqual(BUDGET);
      });

      it('is neither deferred nor an error in a cut batch when its record was returned', async () => {
        // Two ~25 KB records fit, the third does not; the fake endpoint returns c, b, a.
        serveBulk(() => 25_000);
        const [a, b, c] = hundred;
        const { structured } = await call([a!, b!, c!, c!]);

        expect(structured.works.map((w) => w.putCode)).toEqual([c, b]);
        expect(structured.errors).toEqual([]);
        expect(structured.deferredPutCodes).toEqual([a]);
      });

      it('is listed once when its record is deferred', async () => {
        serveBulk(() => 25_000);
        const [a, b, c] = hundred;
        const { structured } = await call([a!, a!, b!, c!, a!]);

        expect(structured.errors).toEqual([]);
        expect(structured.deferredPutCodes).toEqual([a]);
        expect(structured.notice).toContain('1 put-code was deferred');
      });
    });

    it('adds no deferral fields when the whole batch fits', async () => {
      serveBulk();
      const { result, structured } = await call(hundred.slice(0, 5));

      expect(structured.works).toHaveLength(5);
      expect(structured).not.toHaveProperty('deferredPutCodes');
      expect(structured).not.toHaveProperty('notice');
      expect(textOf(result)).not.toContain('Deferred');
    });
  });
});
