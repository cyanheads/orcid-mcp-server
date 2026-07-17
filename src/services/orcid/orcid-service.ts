/**
 * @fileoverview ORCID Public API v3.0 service. Provides search and record-section
 * fetchers with retry, backoff, and JSON normalization. Uses init/accessor pattern.
 * @module services/orcid/orcid-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
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
  normalizeFundings,
  normalizePeerReviews,
  normalizePerson,
  normalizeResearchResources,
  normalizeWorkDetail,
  normalizeWorks,
} from './normalizers.js';
import { normalizeOrcidId } from './orcid-id.js';
import type {
  Affiliation,
  BulkWorkResult,
  ExpandedSearchResponse,
  FundingRecord,
  PeerReview,
  RawActivities,
  RawBulkWorksResponse,
  RawExpandedSearchResponse,
  RawFundingsResponse,
  RawPeerReviewsResponse,
  RawPerson,
  RawResearchResourcesResponse,
  RawWorkDetail,
  RawWorksResponse,
  ResearchResource,
  Work,
  WorkDetail,
} from './types.js';

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

/** Common fetch options forwarded to network layer. */
export type FetchOptions = {
  signal?: AbortSignal;
};

/** Search parameters for expanded-search endpoint. */
export type SearchParams = {
  q: string;
  rows?: number;
  start?: number;
};

export class OrcidService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().orcidApiBaseUrl.replace(/\/$/, '');
  }

  /** Build base request headers required by the ORCID Public API. */
  private headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      'User-Agent': 'orcid-mcp-server/0.2.11 (https://github.com/cyanheads/orcid-mcp-server)',
    };
  }

  /**
   * Detect HTML error pages masquerading as JSON responses (rate-limit or maintenance pages).
   * The endpoint URL is logged server-side for operators but never enters the thrown message
   * or `data` — the client-facing error must not leak the upstream API URL (see #28).
   */
  private assertNotHtml(text: string, url: string, ctx: Context): void {
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      ctx.log.warning(
        'ORCID returned HTML instead of JSON — likely rate-limited or under maintenance.',
        {
          url,
        },
      );
      throw serviceUnavailable(
        'ORCID API returned HTML instead of JSON — likely rate-limited or under maintenance.',
      );
    }
  }

  /** Fetch a URL with retry and timeout, returning parsed JSON. */
  private fetchJson<T>(url: string, ctx: Context, options?: FetchOptions): Promise<T> {
    const signal = options?.signal ?? ctx.signal;
    // Create a RequestContext from the handler Context for withRetry's structured logging.
    const reqCtx = requestContextService.createRequestContext({
      operation: 'OrcidService.fetchJson',
      parentContext: { requestId: ctx.requestId, tenantId: ctx.tenantId, traceId: ctx.traceId },
    });
    return withRetry(
      async () => {
        const response = await fetch(url, {
          headers: this.headers(),
          signal,
        });
        if (!response.ok) {
          // captureBody: false — ORCID's Solr error body echoes its internal Solr host
          // and Java exception classes; keep that upstream diagnostic text off the wire.
          throw await httpErrorFromResponse(response, {
            service: 'ORCID',
            data: { url },
            captureBody: false,
          });
        }
        const text = await response.text();
        this.assertNotHtml(text, url, ctx);
        return JSON.parse(text) as T;
      },
      {
        operation: 'OrcidService.fetchJson',
        context: reqCtx,
        baseDelayMs: 1000,
        signal,
      },
    );
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
    const raw = await this.fetchJson<RawExpandedSearchResponse>(url, ctx);
    return normalizeExpandedSearch(raw);
  }

  /**
   * Fetch the person section for an ORCID iD.
   * Returns name, biography, keywords, researcher URLs, external IDs.
   */
  async getPerson(orcidId: string, ctx: Context): Promise<NormalizedPerson> {
    const id = normalizeOrcidId(orcidId);
    const url = `${this.baseUrl}/${id}/person`;
    ctx.log.debug('ORCID getPerson', { orcidId: id });
    const raw = await this.fetchJson<RawPerson>(url, ctx);
    return normalizePerson(raw);
  }

  /**
   * Fetch the works summary list for an ORCID iD.
   * Returns titles, types, dates, journal names, and external IDs (DOIs, PMIDs, etc.).
   */
  async getWorks(orcidId: string, ctx: Context): Promise<Work[]> {
    const id = normalizeOrcidId(orcidId);
    const url = `${this.baseUrl}/${id}/works`;
    ctx.log.debug('ORCID getWorks', { orcidId: id });
    const raw = await this.fetchJson<RawWorksResponse>(url, ctx);
    return normalizeWorks(raw);
  }

  /**
   * Fetch activities and return affiliation sections filtered by types.
   * Uses a single /activities call instead of per-section fetches.
   */
  async getAffiliations(
    orcidId: string,
    types: AffiliationType[],
    ctx: Context,
  ): Promise<Affiliation[]> {
    const id = normalizeOrcidId(orcidId);
    const url = `${this.baseUrl}/${id}/activities`;
    ctx.log.debug('ORCID getAffiliations', { orcidId: id, types });
    const raw = await this.fetchJson<RawActivities>(url, ctx);
    return normalizeActivities(raw, types);
  }

  /**
   * Fetch funding records for an ORCID iD.
   */
  async getFundings(orcidId: string, ctx: Context): Promise<FundingRecord[]> {
    const id = normalizeOrcidId(orcidId);
    const url = `${this.baseUrl}/${id}/fundings`;
    ctx.log.debug('ORCID getFundings', { orcidId: id });
    const raw = await this.fetchJson<RawFundingsResponse>(url, ctx);
    return normalizeFundings(raw);
  }

  /**
   * Fetch peer review records for an ORCID iD.
   */
  async getPeerReviews(orcidId: string, ctx: Context): Promise<PeerReview[]> {
    const id = normalizeOrcidId(orcidId);
    const url = `${this.baseUrl}/${id}/peer-reviews`;
    ctx.log.debug('ORCID getPeerReviews', { orcidId: id });
    const raw = await this.fetchJson<RawPeerReviewsResponse>(url, ctx);
    return normalizePeerReviews(raw);
  }

  /**
   * Fetch the full detail for a single work by its put-code.
   * Returns abstract, all contributors with roles, full external IDs, and citation.
   */
  async getWorkDetail(orcidId: string, putCode: number, ctx: Context): Promise<WorkDetail> {
    const id = normalizeOrcidId(orcidId);
    const url = `${this.baseUrl}/${id}/work/${putCode}`;
    ctx.log.debug('ORCID getWorkDetail', { orcidId: id, putCode });
    const raw = await this.fetchJson<RawWorkDetail>(url, ctx);
    return normalizeWorkDetail(raw);
  }

  /**
   * Fetch full detail records for up to 100 works in a single bulk round-trip.
   * Uses GET /v3.0/{orcid}/works/{putCode1},{putCode2},...
   * Per-record errors (not-found put-codes) are returned as error entries rather
   * than failing the entire call.
   */
  async getWorkDetails(
    orcidId: string,
    putCodes: number[],
    ctx: Context,
  ): Promise<BulkWorkResult[]> {
    const id = normalizeOrcidId(orcidId);
    const codesStr = putCodes.join(',');
    const url = `${this.baseUrl}/${id}/works/${codesStr}`;
    ctx.log.debug('ORCID getWorkDetails (bulk)', { orcidId: id, count: putCodes.length });
    const raw = await this.fetchJson<RawBulkWorksResponse>(url, ctx);
    return normalizeBulkWorks(raw);
  }

  /**
   * Fetch research resources (equipment, facilities, compute allocations, etc.)
   * associated with an ORCID iD.
   */
  async getResearchResources(orcidId: string, ctx: Context): Promise<ResearchResource[]> {
    const id = normalizeOrcidId(orcidId);
    const url = `${this.baseUrl}/${id}/research-resources`;
    ctx.log.debug('ORCID getResearchResources', { orcidId: id });
    const raw = await this.fetchJson<RawResearchResourcesResponse>(url, ctx);
    return normalizeResearchResources(raw);
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
