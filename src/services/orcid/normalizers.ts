/**
 * @fileoverview Normalization functions that convert raw ORCID API shapes to
 * typed domain objects. Preserves absence as unknown rather than inventing defaults.
 * @module services/orcid/normalizers
 */

import type { AffiliationType } from './orcid-service.js';
import type {
  Affiliation,
  BulkWorkResult,
  ExpandedSearchResponse,
  ExpandedSearchResult,
  ExternalIdentifier,
  FundingRecord,
  NormalizedDate,
  OrcidDate,
  Organization,
  PeerReview,
  RawActivities,
  RawAffiliationGroup,
  RawAffiliationSummary,
  RawBulkWorksResponse,
  RawExpandedSearchResponse,
  RawExpandedSearchResult,
  RawFundingGroup,
  RawFundingSummary,
  RawFundingsResponse,
  RawOrganization,
  RawPeerReviewGroup,
  RawPeerReviewsResponse,
  RawPerson,
  RawResearchResourceGroup,
  RawResearchResourcesResponse,
  RawWorkContributor,
  RawWorkDetail,
  RawWorkExternalId,
  RawWorkSummary,
  RawWorksGroup,
  RawWorksResponse,
  ResearchResource,
  Work,
  WorkContributor,
  WorkDetail,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeDate(d: OrcidDate | undefined): NormalizedDate | undefined {
  if (!d?.year?.value) return;
  const y = d.year.value;
  const m = d.month?.value?.padStart(2, '0');
  const day = d.day?.value?.padStart(2, '0');
  if (m && day) return `${y}-${m}-${day}`;
  if (m) return `${y}-${m}`;
  return y;
}

function normalizeOrg(raw: RawOrganization | undefined): Organization | undefined {
  if (!raw) return;
  const dis = raw['disambiguated-organization'];
  const result: Organization = {};
  if (raw.name) result.name = raw.name;
  if (raw.address?.city) result.city = raw.address.city;
  if (raw.address?.country) result.country = raw.address.country;
  if (dis?.['disambiguated-organization-identifier']) {
    result.disambiguatedId = dis['disambiguated-organization-identifier'];
  }
  if (dis?.['disambiguation-source']) {
    result.disambiguationSource = dis['disambiguation-source'];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeExternalId(raw: RawWorkExternalId): ExternalIdentifier | undefined {
  if (!raw['external-id-type'] || !raw['external-id-value']) return;
  return {
    type: raw['external-id-type'],
    value: raw['external-id-value'],
    ...(raw['external-id-url']?.value && { url: raw['external-id-url'].value }),
    ...(raw['external-id-relationship'] && { relationship: raw['external-id-relationship'] }),
  };
}

function normalizeExternalIds(raw: RawWorkExternalId[] | undefined): ExternalIdentifier[] {
  if (!raw?.length) return [];
  return raw.map(normalizeExternalId).filter((id): id is ExternalIdentifier => id !== undefined);
}

function normalizeSummary(raw: RawAffiliationSummary, type: string): Affiliation {
  const org = normalizeOrg(raw.organization);
  const aff: Affiliation = { type };
  if (org) aff.organization = org;
  if (raw['department-name']) aff.department = raw['department-name'];
  if (raw['role-title']) aff.role = raw['role-title'];
  const start = normalizeDate(raw['start-date']);
  if (start) aff.startDate = start;
  const end = normalizeDate(raw['end-date']);
  if (end) aff.endDate = end;
  if (raw.url?.value) aff.url = raw.url.value;
  return aff;
}

function extractSummariesFromGroup(
  group: RawAffiliationGroup | undefined,
  type: string,
): Affiliation[] {
  if (!group) return [];
  const summaries = group['affiliation-summary'] ?? group.summaries ?? [];
  return summaries.map((s) => normalizeSummary(s, type));
}

function extractGroupSummaries(
  groups: RawAffiliationGroup[] | undefined,
  type: string,
): Affiliation[] {
  return (groups ?? []).flatMap((g) => extractSummariesFromGroup(g, type));
}

// ---------------------------------------------------------------------------
// Normalization functions (exported)
// ---------------------------------------------------------------------------

/** Normalized person fields returned from /person endpoint. */
export type NormalizedPerson = {
  givenNames?: string;
  familyName?: string;
  creditName?: string;
  biography?: string;
  keywords: string[];
  researcherUrls: Array<{ name?: string; url: string }>;
  externalIdentifiers: ExternalIdentifier[];
  emails: Array<{ email: string; primary?: boolean }>;
  countries: string[];
};

export function normalizePerson(raw: RawPerson): NormalizedPerson {
  const name = raw.name;
  const result: NormalizedPerson = {
    keywords: [],
    researcherUrls: [],
    externalIdentifiers: [],
    emails: [],
    countries: [],
  };

  const givenNames = name?.['given-names']?.value;
  if (givenNames) result.givenNames = givenNames;
  const familyName = name?.['family-name']?.value;
  if (familyName) result.familyName = familyName;
  const creditName = name?.['credit-name']?.value;
  if (creditName) result.creditName = creditName;
  const biography = raw.biography?.content?.trim() || undefined;
  if (biography) result.biography = biography;

  result.keywords = raw.keywords?.keyword?.map((k) => k.content ?? '').filter(Boolean) ?? [];

  result.researcherUrls =
    raw['researcher-urls']?.['researcher-url']?.flatMap((u) => {
      const url = u.url?.value;
      if (!url) return [];
      const entry: { name?: string; url: string } = { url };
      if (u['url-name']) entry.name = u['url-name'];
      return [entry];
    }) ?? [];

  result.externalIdentifiers = normalizeExternalIds(
    raw['external-identifiers']?.['external-identifier'],
  );

  result.emails =
    raw.emails?.email?.flatMap((e) => {
      if (!e.email) return [];
      const entry: { email: string; primary?: boolean } = { email: e.email };
      if (typeof e.primary === 'boolean') entry.primary = e.primary;
      return [entry];
    }) ?? [];

  result.countries =
    raw.addresses?.address?.flatMap((a) => {
      const c = a.country?.value;
      return c ? [c] : [];
    }) ?? [];

  return result;
}

function normalizeWorkSummary(raw: RawWorkSummary): Work {
  const externalIds = normalizeExternalIds(raw['external-ids']?.['external-id']);
  const work: Work = { externalIds };
  if (raw['put-code'] != null) work.putCode = raw['put-code'];
  const title = raw.title?.title?.value;
  if (title) work.title = title;
  if (raw['work-type']) work.workType = raw['work-type'];
  const pubDate = normalizeDate(raw['publication-date']);
  if (pubDate) work.publicationDate = pubDate;
  if (raw['journal-title']?.value) work.journalTitle = raw['journal-title'].value;
  if (raw.url?.value) work.url = raw.url.value;
  return work;
}

export function normalizeWorks(raw: RawWorksResponse): Work[] {
  return (raw.group ?? []).flatMap((g: RawWorksGroup) => {
    // Return the first (preferred) work summary per group
    const preferred = g['work-summary']?.[0];
    if (!preferred) return [];
    return [normalizeWorkSummary(preferred)];
  });
}

type NonAllAffiliationType = Exclude<AffiliationType, 'all'>;

const ALL_AFFILIATION_TYPES: NonAllAffiliationType[] = [
  'employment',
  'education',
  'invited-positions',
  'distinctions',
  'memberships',
  'qualifications',
  'services',
];

const AFFILIATION_TYPE_KEYS: Record<NonAllAffiliationType, string> = {
  employment: 'employments',
  education: 'educations',
  'invited-positions': 'invited-positions',
  distinctions: 'distinctions',
  memberships: 'memberships',
  qualifications: 'qualifications',
  services: 'services',
};

export function normalizeActivities(raw: RawActivities, types: AffiliationType[]): Affiliation[] {
  const resolvedTypes = types.includes('all')
    ? ALL_AFFILIATION_TYPES
    : (types as NonAllAffiliationType[]);

  return resolvedTypes.flatMap((type) => {
    const key = AFFILIATION_TYPE_KEYS[type];
    const section = (
      raw as Record<string, { 'affiliation-group'?: RawAffiliationGroup[] } | undefined>
    )[key];
    return extractGroupSummaries(section?.['affiliation-group'], type);
  });
}

function normalizeFundingSummary(raw: RawFundingSummary): FundingRecord {
  const funder = normalizeOrg(raw.organization);
  const grantNumbers = normalizeExternalIds(raw['external-ids']?.['external-id'])
    .filter((id) => id.type === 'grant_number')
    .map((id) => id.value);
  const record: FundingRecord = { grantNumbers };
  if (raw.title?.title?.value) record.title = raw.title.title.value;
  if (raw.type) record.type = raw.type;
  if (funder) record.funder = funder;
  const startDate = normalizeDate(raw['start-date']);
  if (startDate) record.startDate = startDate;
  const endDate = normalizeDate(raw['end-date']);
  if (endDate) record.endDate = endDate;
  if (raw.url?.value) record.url = raw.url.value;
  return record;
}

export function normalizeFundings(raw: RawFundingsResponse): FundingRecord[] {
  return (raw.group ?? []).flatMap((g: RawFundingGroup) =>
    (g['funding-summary'] ?? []).map((s) => normalizeFundingSummary(s)),
  );
}

export function normalizePeerReviews(raw: RawPeerReviewsResponse): PeerReview[] {
  return (raw.group ?? []).flatMap((g: RawPeerReviewGroup) => {
    // Extract ISSN from group-level external IDs
    const issn = g['external-ids']?.['external-id']?.find(
      (id) => id['external-id-type'] === 'issn',
    )?.['external-id-value'];

    return (g['peer-review-group'] ?? []).flatMap((prg) =>
      (prg['peer-review-summary'] ?? []).map((s): PeerReview => {
        const org = normalizeOrg(s['convening-organization']);
        const review: PeerReview = {};
        if (s['reviewer-role']) review.reviewerRole = s['reviewer-role'];
        if (s['review-type']) review.reviewType = s['review-type'];
        const completionDate = normalizeDate(s['completion-date']);
        if (completionDate) review.completionDate = completionDate;
        if (org) review.conveningOrganization = org;
        if (s['review-url']?.value) review.reviewUrl = s['review-url'].value;
        if (issn) review.groupIssn = issn;
        return review;
      }),
    );
  });
}

export function normalizeExpandedSearch(raw: RawExpandedSearchResponse): ExpandedSearchResponse {
  const results: ExpandedSearchResult[] = (raw['expanded-result'] ?? []).flatMap(
    (r: RawExpandedSearchResult) => {
      const orcidId = r['orcid-id'];
      if (!orcidId) return [];
      const result: ExpandedSearchResult = {
        orcidId,
        otherNames: r['other-name'] ?? [],
        emails: r.email ?? [],
        institutionNames: r['institution-name'] ?? [],
      };
      if (r['given-names']) result.givenNames = r['given-names'];
      if (r['family-names']) result.familyNames = r['family-names'];
      if (r['credit-name']) result.creditName = r['credit-name'];
      return [result];
    },
  );
  return { results, numFound: raw['num-found'] ?? 0 };
}

function normalizeContributor(raw: RawWorkContributor): WorkContributor {
  const contributor: WorkContributor = {};
  const name = raw['credit-name']?.value;
  if (name) contributor.name = name;
  const orcidPath = raw['contributor-orcid']?.path;
  if (orcidPath) contributor.orcidId = orcidPath;
  const role = raw['contributor-attributes']?.['contributor-role'];
  if (role) contributor.role = role;
  const sequence = raw['contributor-attributes']?.['contributor-sequence'];
  if (sequence) contributor.sequence = sequence;
  return contributor;
}

export function normalizeWorkDetail(raw: RawWorkDetail): WorkDetail {
  const externalIds = normalizeExternalIds(raw['external-ids']?.['external-id']);
  const contributors = (raw.contributors?.contributor ?? []).map(normalizeContributor);
  const detail: WorkDetail = {
    putCode: raw['put-code'] ?? 0,
    externalIds,
    contributors,
  };
  const titleVal = raw.title?.title?.value;
  if (titleVal) detail.title = titleVal;
  const subtitleVal = raw.title?.subtitle?.value;
  if (subtitleVal) detail.subtitle = subtitleVal;
  if (raw.type) detail.workType = raw.type;
  const pubDate = normalizeDate(raw['publication-date'] ?? undefined);
  if (pubDate) detail.publicationDate = pubDate;
  const journalTitle = raw['journal-title']?.value;
  if (journalTitle) detail.journalTitle = journalTitle;
  const abstract = raw['short-description']?.trim() || undefined;
  if (abstract) detail.abstract = abstract;
  const citationType = raw.citation?.['citation-type'];
  const citationValue = raw.citation?.['citation-value'];
  if (citationType && citationValue) detail.citation = { type: citationType, value: citationValue };
  const urlVal = raw.url?.value;
  if (urlVal) detail.url = urlVal;
  if (raw['language-code']) detail.languageCode = raw['language-code'];
  return detail;
}

/**
 * Extract the failing put-code from a bulk-error developer message.
 * The live bulk endpoint never populates a `put-code` field for the invalid-put-code
 * error class — the failing code appears only inside the validation text
 * (e.g. `'999999999' is not a valid put code`). Returns the code only on a single
 * unambiguous match; messages with no embedded code (access denied, generic 4xx)
 * leave it undefined.
 */
function extractInvalidPutCode(message: string): number | undefined {
  const matches = [...message.matchAll(/'(\d+)' is not a valid put code/g)];
  const captured = matches.length === 1 ? matches[0]?.[1] : undefined;
  return captured === undefined ? undefined : Number(captured);
}

/**
 * Normalize the bulk works endpoint response.
 * Each entry is either a `work` (full detail) or an `error` (not-found or access denied).
 * Error entries are surfaced as BulkWorkResult errors rather than failing the whole call.
 */
export function normalizeBulkWorks(raw: RawBulkWorksResponse): BulkWorkResult[] {
  return (raw.bulk ?? []).map((entry): BulkWorkResult => {
    if (entry.error) {
      const msg =
        entry.error['developer-message'] ??
        `ORCID error code ${entry.error['error-code'] ?? entry.error['response-code'] ?? 'unknown'}`;
      // The upstream `put-code` field is authoritative when present, but the live API
      // omits it for the invalid-put-code class — fall back to extracting from `msg`.
      const putCode = entry.error['put-code'] ?? extractInvalidPutCode(msg);
      return { type: 'error', ...(putCode !== undefined && { putCode }), message: msg };
    }
    return { type: 'work', detail: normalizeWorkDetail(entry.work) };
  });
}

export function normalizeResearchResources(raw: RawResearchResourcesResponse): ResearchResource[] {
  return (raw.group ?? []).flatMap((g: RawResearchResourceGroup) =>
    (g['research-resource-summary'] ?? []).flatMap((s): ResearchResource[] => {
      const putCode = s['put-code'];
      if (!putCode) return [];
      const resource: ResearchResource = { putCode, externalIds: [] };
      const titleVal = s.proposal?.title?.title?.value;
      if (titleVal) resource.title = titleVal;
      const firstOrg = s.proposal?.hosts?.organization?.[0];
      const hostOrg = normalizeOrg(firstOrg);
      if (hostOrg) resource.hostOrganization = hostOrg;
      const rawIds = s.proposal?.['external-ids']?.['external-id'];
      resource.externalIds = normalizeExternalIds(rawIds);
      const startDate = normalizeDate(s.proposal?.['start-date'] ?? undefined);
      if (startDate) resource.startDate = startDate;
      const endDate = normalizeDate(s.proposal?.['end-date'] ?? undefined);
      if (endDate) resource.endDate = endDate;
      const urlVal = s.proposal?.url?.value;
      if (urlVal) resource.url = urlVal;
      return [resource];
    }),
  );
}
