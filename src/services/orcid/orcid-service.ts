/**
 * @fileoverview ORCID Public API v3.0 service. Provides search and record-section
 * fetchers with retry, backoff, and JSON normalization. Uses init/accessor pattern.
 * @module services/orcid/orcid-service
 */

import type { Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, type McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  httpErrorFromResponse,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { NormalizedPerson } from './normalizers.js';
import {
  normalizeActivities,
  normalizeBulkWorks,
  normalizeExpandedSearch,
  normalizeFundingDetail,
  normalizeFundings,
  normalizePeerReviews,
  normalizePerson,
  normalizeResearchResourceDetail,
  normalizeResearchResources,
  normalizeWorks,
} from './normalizers.js';
import { isValidOrcidId, normalizeOrcidId } from './orcid-id.js';
import type {
  Affiliation,
  BulkWorkResult,
  ExpandedSearchResponse,
  FundingRecord,
  PeerReview,
  RawExpandedSearchResponse,
  ResearchResource,
  ResearchResourceDetail,
  Work,
} from './types.js';
import { upstreamSchemas } from './upstream-schemas.js';

/**
 * Marker in ORCID's error body when its Solr backend rejected the query. ORCID relays a
 * malformed or unknown-field query as HTTP 500 carrying this exception name, so the status
 * alone cannot tell a bad query from an outage.
 */
const SOLR_QUERY_REJECTION = 'RemoteSolrException';

/**
 * Wall-clock budget for every ORCID request one tool call makes, covering each attempt,
 * backoff, honored `Retry-After`, and body read. A request ORCID never answers ends here as
 * `Timeout` instead of at the runtime's fetch idle timeout, once per attempt, and a call that
 * makes several requests (`orcid_resolve_researcher`'s fallback stages) shares the one budget
 * rather than spending it per request. The fast-failure retry ladder (about 9 s of backoff)
 * fits inside it, and the call ends inside a 60 s client timeout.
 */
const CALL_DEADLINE_MS = 25_000;

/** Re-exported from the shared ORCID iD parser/validator (`./orcid-id.js`). */
export { normalizeOrcidId };

/** The accepted affiliation types as a union for type-safety. */
export type AffiliationType =
  | 'employment'
  | 'education'
  | 'invited-positions'
  | 'distinctions'
  | 'memberships'
  | 'qualifications'
  | 'services'
  | 'all';

/** Search parameters for expanded-search endpoint. */
export type SearchParams = {
  q: string;
  rows?: number;
  start?: number;
};

/**
 * A record-section result and the iD ORCID served it under: the requested iD, or the primary
 * iD ORCID merged a deprecated one into.
 */
export type RecordResult<T> = { orcidId: string; data: T };

/** Thrown when an ORCID response cannot be what the request asked for. */
function incompatibleResponse(): McpError {
  return serviceUnavailable(
    'ORCID returned an incompatible response. Try again later; if this persists, report the failing tool and ORCID iD.',
    { reason: 'invalid_upstream_response', retryable: false },
  );
}

export class OrcidService {
  private readonly baseUrl: string;
  /** The version the server reports in `initialize`, resolved by the framework from package.json. */
  private readonly version: string;
  /** When each tool call's {@link CALL_DEADLINE_MS} budget ends, keyed by its handler Context. */
  private readonly callDeadlines = new WeakMap<Context, number>();

  constructor(config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().orcidApiBaseUrl.replace(/\/$/, '');
    this.version = config.mcpServerVersion;
  }

  /**
   * Build base request headers required by the ORCID Public API. The product token stays
   * literal: `config.mcpServerName` is the scoped npm name, and `@` and `/` are not valid in a
   * User-Agent product token.
   */
  private headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      'User-Agent': `orcid-mcp-server/${this.version} (https://github.com/cyanheads/orcid-mcp-server)`,
    };
  }

  /**
   * Detect HTML error pages masquerading as JSON responses (rate-limit or maintenance pages).
   * Neither the warning nor the client-facing error carries the upstream URL or body.
   */
  private assertNotHtml(text: string, endpoint: string, ctx: Context): void {
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      ctx.log.warning(
        'ORCID returned HTML instead of JSON — likely rate-limited or under maintenance.',
        {
          endpoint,
        },
      );
      throw serviceUnavailable(
        'ORCID API returned HTML instead of JSON — likely rate-limited or under maintenance.',
      );
    }
  }

  /**
   * Convert a non-2xx ORCID response into a client-safe `McpError`.
   *
   * `httpErrorFromResponse` keeps the upstream request URL off `error.data` unless
   * `includeUrl` is passed, and `service: 'ORCID'` keeps the host out of the message, so
   * the endpoint URL never reaches the client (#31). Logs use a fixed endpoint label.
   * The error carries what the framework and `withRetry` classify on: the status →
   * JSON-RPC code mapping, `status`/`statusText`/`statusCode`, and any
   * `retryAfter`/`retryable` signal.
   *
   * A 500 classifies as transient `ServiceUnavailable`, which `withRetry` retries. A 500
   * whose body names a Solr query rejection is reclassified `InvalidParams`: the same query
   * fails on every attempt, so retrying it only delays the caller's recovery hint.
   */
  private async upstreamError(
    response: Response,
    endpoint: string,
    ctx: Context,
  ): Promise<McpError> {
    const queryRejected =
      response.status === 500 &&
      (await response.text().catch(() => '')).includes(SOLR_QUERY_REJECTION);
    // captureBody: false — ORCID's Solr error body echoes its internal Solr host
    // and Java exception classes; keep that upstream diagnostic text off the wire.
    const error = await httpErrorFromResponse(response, {
      service: 'ORCID',
      captureBody: false,
      ...(queryRejected && { codeOverride: () => JsonRpcErrorCode.InvalidParams }),
    });
    ctx.log.warning('ORCID request failed.', { endpoint, status: response.status });
    return error;
  }

  /**
   * Milliseconds left of the call's {@link CALL_DEADLINE_MS} budget. The clock starts at the
   * call's first ORCID request; every later request on the same `ctx` gets what remains.
   */
  private remainingBudgetMs(ctx: Context): number {
    let endsAt = this.callDeadlines.get(ctx);
    if (endsAt === undefined) {
      endsAt = Date.now() + CALL_DEADLINE_MS;
      this.callDeadlines.set(ctx, endsAt);
    }
    return Math.max(0, endsAt - Date.now());
  }

  /**
   * Fetch a URL with retry under what remains of the call's {@link CALL_DEADLINE_MS} budget,
   * returning parsed JSON.
   *
   * Each attempt runs on `withRetry`'s attempt signal, so the deadline or a caller abort stops a
   * request already in flight, body read included. Expiry surfaces as `withRetry`'s `Timeout`
   * (`data.reason: 'retry_deadline_exceeded'`); a caller abort rethrows as-is and outranks it.
   * A transport rejection while that signal is live (refused, reset, DNS) and a 2xx body that
   * is not JSON (empty, cut off, a proxy page) each become a transient `ServiceUnavailable` that
   * names ORCID only, retried like an outage. The runtime's message can carry the request URL
   * and the parser's quotes the body, so both stay on `cause`; logs use a fixed endpoint
   * label (#28, #31). Redirects are followed; `finalUrl` is set only when one was.
   */
  private async fetchJson<T>(
    url: string,
    endpoint: string,
    ctx: Context,
    schema: z.ZodType<T>,
  ): Promise<{ data: T; finalUrl?: string }> {
    // Create a RequestContext from the handler Context for withRetry's structured logging.
    const reqCtx = requestContextService.createRequestContext({
      operation: 'OrcidService.fetchJson',
      parentContext: { requestId: ctx.requestId, tenantId: ctx.tenantId, traceId: ctx.traceId },
    });
    const { json, finalUrl } = await withRetry(
      async ({ signal }) => {
        const unreachable = (error: unknown): never => {
          if (signal.aborted) throw error;
          ctx.log.warning('ORCID request failed in transport.', { endpoint });
          throw serviceUnavailable('The ORCID API could not be reached.', undefined, {
            cause: error,
          });
        };
        const response = await fetch(url, { headers: this.headers(), signal }).catch(unreachable);
        if (!response.ok) {
          throw await this.upstreamError(response, endpoint, ctx);
        }
        const text = await response.text().catch(unreachable);
        this.assertNotHtml(text, endpoint, ctx);
        try {
          return {
            json: JSON.parse(text) as unknown,
            finalUrl: response.redirected ? response.url : undefined,
          };
        } catch (error) {
          ctx.log.warning('ORCID returned a 2xx body that is not JSON.', {
            endpoint,
            status: response.status,
            bodyBytes: text.length,
          });
          throw serviceUnavailable(
            'ORCID API returned a response that is not valid JSON.',
            undefined,
            { cause: error },
          );
        }
      },
      {
        // Embedded in the deadline-expiry message the client sees, so it names the upstream.
        operation: 'ORCID request',
        context: reqCtx,
        baseDelayMs: 1000,
        deadlineMs: this.remainingBudgetMs(ctx),
        signal: ctx.signal,
      },
    );
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw incompatibleResponse();
    return { data: parsed.data, ...(finalUrl !== undefined && { finalUrl }) };
  }

  /**
   * Fetch one section of the record at `id` (a canonical bare iD) and normalize it. ORCID
   * answers a deprecated (merged) iD with a 301 to the primary iD's same endpoint, which
   * `fetch` follows; the record is then the primary's, and its iD — the one the normalizers
   * compare `selfAsserted` against, passed to `normalize` — is the final URL's iD segment. A
   * redirect that leaves the configured API base, or whose final URL carries no valid iD
   * there, fails as `invalid_upstream_response`.
   */
  private async fetchRecord<T, R>(
    id: string,
    section: string,
    endpoint: string,
    ctx: Context,
    schema: z.ZodType<T>,
    normalize: (raw: T, orcidId: string) => R,
  ): Promise<RecordResult<R>> {
    const { data, finalUrl } = await this.fetchJson(
      `${this.baseUrl}/${id}/${section}`,
      endpoint,
      ctx,
      schema,
    );
    if (finalUrl === undefined) return { orcidId: id, data: normalize(data, id) };
    const base = new URL(this.baseUrl);
    const final = new URL(finalUrl);
    const prefix = `${base.pathname.replace(/\/$/, '')}/`;
    const segment =
      final.origin === base.origin && final.pathname.startsWith(prefix)
        ? final.pathname.slice(prefix.length).split('/')[0]
        : undefined;
    if (segment === undefined || !isValidOrcidId(segment)) {
      ctx.log.warning('ORCID redirected to a URL that is not an ORCID record.', { endpoint });
      throw incompatibleResponse();
    }
    const orcidId = normalizeOrcidId(segment);
    return { orcidId, data: normalize(data, orcidId) };
  }

  /**
   * Search the ORCID expanded-search endpoint.
   * Returns inline name and institution data in one call.
   */
  async expandedSearch(params: SearchParams, ctx: Context): Promise<ExpandedSearchResponse> {
    const qs = new URLSearchParams({ q: params.q });
    if (params.rows != null) qs.set('rows', String(params.rows));
    if (params.start != null) qs.set('start', String(params.start));
    const url = `${this.baseUrl}/expanded-search/?${qs}`;
    ctx.log.debug('ORCID expanded-search', { q: params.q, rows: params.rows, start: params.start });
    const { data: raw } = await this.fetchJson<RawExpandedSearchResponse>(
      url,
      'expanded-search',
      ctx,
      upstreamSchemas.search,
    );
    return normalizeExpandedSearch(raw);
  }

  /**
   * Fetch the person section for an ORCID iD.
   * Returns name, biography, keywords, researcher URLs, external IDs.
   */
  async getPerson(orcidId: string, ctx: Context): Promise<RecordResult<NormalizedPerson>> {
    const id = normalizeOrcidId(orcidId);
    ctx.log.debug('ORCID getPerson', { orcidId: id });
    return await this.fetchRecord(
      id,
      'person',
      'person',
      ctx,
      upstreamSchemas.person,
      normalizePerson,
    );
  }

  /**
   * Fetch the works summary list for an ORCID iD.
   * Returns titles, types, dates, journal names, and external IDs (DOIs, PMIDs, etc.).
   */
  async getWorks(orcidId: string, ctx: Context): Promise<RecordResult<Work[]>> {
    const id = normalizeOrcidId(orcidId);
    ctx.log.debug('ORCID getWorks', { orcidId: id });
    return await this.fetchRecord(id, 'works', 'works', ctx, upstreamSchemas.works, normalizeWorks);
  }

  /**
   * Fetch activities and return affiliation sections filtered by types.
   * Uses a single /activities call instead of per-section fetches.
   */
  async getAffiliations(
    orcidId: string,
    types: AffiliationType[],
    ctx: Context,
  ): Promise<RecordResult<Affiliation[]>> {
    const id = normalizeOrcidId(orcidId);
    ctx.log.debug('ORCID getAffiliations', { orcidId: id, types });
    return await this.fetchRecord(
      id,
      'activities',
      'activities',
      ctx,
      upstreamSchemas.activities,
      (raw, primaryId) => normalizeActivities(raw, types, primaryId),
    );
  }

  /**
   * Fetch funding records for an ORCID iD.
   */
  async getFundings(orcidId: string, ctx: Context): Promise<RecordResult<FundingRecord[]>> {
    const id = normalizeOrcidId(orcidId);
    ctx.log.debug('ORCID getFundings', { orcidId: id });
    return await this.fetchRecord(
      id,
      'fundings',
      'fundings',
      ctx,
      upstreamSchemas.fundings,
      normalizeFundings,
    );
  }

  /** Fetch only the selected award deposit under the shared call deadline. */
  async getFundingDetail(
    orcidId: string,
    putCode: number,
    ctx: Context,
  ): Promise<RecordResult<FundingRecord>> {
    return await this.fetchRecord(
      normalizeOrcidId(orcidId),
      `funding/${putCode}`,
      'funding-detail',
      ctx,
      upstreamSchemas.fundingDetail,
      normalizeFundingDetail,
    );
  }

  /**
   * Fetch peer review records for an ORCID iD.
   */
  async getPeerReviews(orcidId: string, ctx: Context): Promise<RecordResult<PeerReview[]>> {
    const id = normalizeOrcidId(orcidId);
    ctx.log.debug('ORCID getPeerReviews', { orcidId: id });
    return await this.fetchRecord(
      id,
      'peer-reviews',
      'peer-reviews',
      ctx,
      upstreamSchemas.peerReviews,
      normalizePeerReviews,
    );
  }

  /**
   * Fetch full detail records for up to 100 works in a single bulk round-trip.
   * Uses GET /v3.0/{orcid}/works/{putCode1},{putCode2},...
   * Per-record errors (not-found put-codes) are returned as error entries rather
   * than failing the entire call. ORCID does not redirect this endpoint for a deprecated
   * iD: it answers 200 with an invalid-put-code error per code.
   */
  async getWorkDetails(
    orcidId: string,
    putCodes: number[],
    ctx: Context,
  ): Promise<RecordResult<BulkWorkResult[]>> {
    const id = normalizeOrcidId(orcidId);
    ctx.log.debug('ORCID getWorkDetails (bulk)', { orcidId: id, count: putCodes.length });
    return await this.fetchRecord(
      id,
      `works/${putCodes.join(',')}`,
      'work-detail',
      ctx,
      upstreamSchemas.bulkWorks,
      normalizeBulkWorks,
    );
  }

  /**
   * Fetch research resources (equipment, facilities, compute allocations, etc.)
   * associated with an ORCID iD. ORCID does not redirect this endpoint for a deprecated iD:
   * it answers 200 with an empty group, as it does for an iD that does not exist.
   */
  async getResearchResources(
    orcidId: string,
    ctx: Context,
  ): Promise<RecordResult<ResearchResource[]>> {
    const id = normalizeOrcidId(orcidId);
    ctx.log.debug('ORCID getResearchResources', { orcidId: id });
    return await this.fetchRecord(
      id,
      'research-resources',
      'research-resources',
      ctx,
      upstreamSchemas.resources,
      normalizeResearchResources,
    );
  }

  /**
   * Fetch one allocation's full proposal and items; the existing call deadline applies.
   * ORCID does not redirect this endpoint for a deprecated iD: it answers 404.
   */
  async getResearchResourceDetail(
    orcidId: string,
    putCode: number,
    ctx: Context,
  ): Promise<RecordResult<ResearchResourceDetail>> {
    return await this.fetchRecord(
      normalizeOrcidId(orcidId),
      `research-resource/${putCode}`,
      'research-resource-detail',
      ctx,
      upstreamSchemas.resourceDetail,
      normalizeResearchResourceDetail,
    );
  }
}

// ---------------------------------------------------------------------------
// Init / accessor pattern
// ---------------------------------------------------------------------------

let _service: OrcidService | undefined;

export function initOrcidService(config: AppConfig, storage: StorageService): void {
  _service = new OrcidService(config, storage);
}

export function getOrcidService(): OrcidService {
  if (!_service) {
    throw new Error('OrcidService not initialized — call initOrcidService() in setup()');
  }
  return _service;
}
