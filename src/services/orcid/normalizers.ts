/**
 * @fileoverview Normalization functions that convert raw ORCID API shapes to
 * typed domain objects. Preserves absence as unknown rather than inventing defaults.
 * @module services/orcid/normalizers
 */

import type { AffiliationType } from './orcid-service.js';
import type {
  Affiliation,
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
  RawExpandedSearchResponse,
  RawExpandedSearchResult,
  RawFundingGroup,
  RawFundingSummary,
  RawFundingsResponse,
  RawOrganization,
  RawPeerReviewGroup,
  RawPeerReviewsResponse,
  RawPerson,
  RawWorkExternalId,
  RawWorkSummary,
  RawWorksGroup,
  RawWorksResponse,
  Work,
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
