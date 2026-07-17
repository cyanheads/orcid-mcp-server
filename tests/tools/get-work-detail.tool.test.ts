/**
 * @fileoverview Tests for orcidGetWorkDetail tool (bulk put-codes).
 * @module tests/tools/get-work-detail.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

    const ctx = createMockContext();
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
    expect(work.contributors[2].orcidId).toBe('0000-0001-9161-999X');
    expect(work.languageCode).toBe('en');
  });

  it('strips ORCID URI prefix from input', async () => {
    mockGetWorkDetails.mockResolvedValueOnce([{ type: 'work', detail: workDetailA }]);

    const ctx = createMockContext();
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

    const ctx = createMockContext();
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [215949386, 99999],
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result.works).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.works[0].putCode).toBe(215949386);
    expect(result.works[1].putCode).toBe(99999);
  });

  // ---------------------------------------------------------------------------
  // Sparse / minimal records
  // ---------------------------------------------------------------------------

  it('handles sparse work (no abstract, no contributors, no citation)', async () => {
    mockGetWorkDetails.mockResolvedValueOnce([{ type: 'work', detail: workDetailB }]);

    const ctx = createMockContext();
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0002-1825-0097',
      put_codes: [99999],
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result.works).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    const work = result.works[0];
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

    const ctx = createMockContext();
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [215949386, 999],
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result.works).toHaveLength(1);
    expect(result.works[0].putCode).toBe(215949386);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].putCode).toBe(999);
    expect(result.errors[0].message).toContain('Not Found');
  });

  it('returns all errors when all put-codes fail', async () => {
    mockGetWorkDetails.mockResolvedValueOnce([
      { type: 'error', putCode: 1, message: 'Not found' },
      { type: 'error', putCode: 2, message: 'Access denied' },
    ]);

    const ctx = createMockContext();
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [1, 2],
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result.works).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].putCode).toBe(1);
    expect(result.errors[1].putCode).toBe(2);
  });

  it('handles error entries without a put-code', async () => {
    mockGetWorkDetails.mockResolvedValueOnce([
      { type: 'error', message: 'Unexpected server error' },
    ]);

    const ctx = createMockContext();
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [123],
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result.works).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].putCode).toBeUndefined();
    expect(result.errors[0].message).toBe('Unexpected server error');
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
    const error = await orcidGetWorkDetail.handler(input, ctx).catch((e: unknown) => e);

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
    const error = await orcidGetWorkDetail.handler(input, ctx).catch((e: unknown) => e);

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

  it('wraps an unexpected (non-McpError) service failure as fetch_failed', async () => {
    mockGetWorkDetails.mockRejectedValueOnce(new Error('Network timeout'));

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [215949386],
    });
    const error = await orcidGetWorkDetail.handler(input, ctx).catch((e: unknown) => e);

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
      new McpError(JsonRpcErrorCode.InternalError, 'Service unavailable', {
        url: 'https://pub.orcid.org/v3.0/x/works/1',
        status: 500,
      }),
    );

    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: '0000-0001-9161-999X',
      put_codes: [1],
    });
    const error = await orcidGetWorkDetail.handler(input, ctx).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    const data = (error as McpError).data as { reason?: string };
    expect(data.reason).toBe('fetch_failed');
    // Even an McpError with a leaky data payload is re-wrapped with fresh, redacted data.
    expect(data).not.toHaveProperty('url');
    expect(data).not.toHaveProperty('status');
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
});
