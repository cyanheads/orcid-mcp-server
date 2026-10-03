/**
 * @fileoverview Normalization functions that convert raw ORCID API shapes to
 * typed domain objects. Preserves absence as unknown rather than inventing defaults.
 * Work, funding, and research-resource titles and work abstracts pass through the
 * `toPlainText` markup boundary; identifiers, URLs, and the deposited citation do not.
 * Every activity record carries `sources` — who asserted it — so the activity normalizers
 * take the requested ORCID iD to decide `selfAsserted`.
 * @module services/orcid/normalizers
 */

import { toPlainText } from './markup-text.js';
import type { AffiliationType } from './orcid-service.js';
import type {
  Affiliation,
  AffiliationSummaryKey,
  BulkWorkResult,
  ExpandedSearchResponse,
  ExpandedSearchResult,
  ExternalIdentifier,
  FundingPeriod,
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
  RawOrcidPathRef,
  RawOrganization,
  RawPeerReviewGroup,
  RawPeerReviewsResponse,
  RawPerson,
  RawResearchResourceGroup,
  RawResearchResourcesResponse,
  RawSource,
  RawWorkContributor,
  RawWorkDetail,
  RawWorkExternalId,
  RawWorkSummary,
  RawWorksGroup,
  RawWorksResponse,
  ResearchResource,
  Source,
  Work,
  WorkContributor,
  WorkDetail,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prefix ORCID uses on a peer-review group identifier whose value is an ISSN. */
const ISSN_PREFIX = 'issn:';

function normalizeDate(d: OrcidDate | null | undefined): NormalizedDate | undefined {
  if (!d?.year?.value) return;
  const y = d.year.value;
  const m = d.month?.value?.padStart(2, '0');
  const day = d.day?.value?.padStart(2, '0');
  if (m && day) return `${y}-${m}-${day}`;
  if (m) return `${y}-${m}`;
  return y;
}

function normalizeOrg(raw: RawOrganization | null | undefined): Organization | undefined {
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

/**
 * Who asserted an item, and whether that party is the requested iD. The asserting party is
 * the assertion origin when one is recorded, otherwise the source. Only an `-orcid` reference
 * can be the researcher: a member client's path can share the iD format (Crossref's does).
 */
function normalizeSource(raw: RawSource, orcidId: string): Source {
  const hasOrigin = Boolean(raw['assertion-origin-orcid'] || raw['assertion-origin-client-id']);
  const assertingOrcid = hasOrigin
    ? raw['assertion-origin-orcid']?.path
    : raw['source-orcid']?.path;
  const name = raw['source-name']?.value;
  const assertionOriginName = raw['assertion-origin-name']?.value;
  return {
    ...(name && { name }),
    ...(assertionOriginName && { assertionOriginName }),
    selfAsserted: assertingOrcid === orcidId,
  };
}

/** Identity of an asserting party: its source reference plus its assertion-origin reference. */
function sourceKey(raw: RawSource): string {
  const ref = (kind: string, r: RawOrcidPathRef | null | undefined) =>
    r?.path ? `${kind}:${r.path}` : undefined;
  return JSON.stringify([
    ref('orcid', raw['source-orcid']) ?? ref('client', raw['source-client-id']),
    ref('orcid', raw['assertion-origin-orcid']) ?? ref('client', raw['assertion-origin-client-id']),
  ]);
}

/**
 * The sources of one record's summaries in summary order, each asserting party once. A
 * summary with no `source` block contributes none.
 */
function normalizeSources(
  summaries: ReadonlyArray<{ source?: RawSource | null }>,
  orcidId: string,
): Source[] {
  const seen = new Set<string>();
  return summaries.flatMap(({ source }) => {
    if (!source) return [];
    const key = sourceKey(source);
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalizeSource(source, orcidId)];
  });
}

/** Identifier type whose value is local to the source that issued it. */
const SOURCE_WORK_ID = 'source-work-id';

/**
 * Identity of an external identifier for de-duplication: type, relationship, and ORCID's
 * normalized value (the trimmed raw value when absent). The normalized value folds the
 * spellings sources disagree on — DOI case, a `PMC` prefix.
 */
function externalIdKey(raw: RawWorkExternalId): string {
  const value = raw['external-id-normalized']?.value || raw['external-id-value']?.trim();
  return JSON.stringify([raw['external-id-type'], raw['external-id-relationship'], value]);
}

/**
 * A work group's identifiers: the representative summary's own list in upstream order,
 * then each group-level identifier not already present, in group order. A group-level
 * `source-work-id` is skipped — detached from its source it would read as the
 * representative's own.
 */
function workGroupExternalIds(
  group: RawWorksGroup,
  representative: RawWorkSummary,
): RawWorkExternalId[] {
  const own = representative['external-ids']?.['external-id'] ?? [];
  const seen = new Set(own.map(externalIdKey));
  const added = (group['external-ids']?.['external-id'] ?? []).filter((id) => {
    const key = externalIdKey(id);
    if (id['external-id-type'] === SOURCE_WORK_ID || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...own, ...added];
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

/** Requested section type → the `activities` key that holds it. */
const AFFILIATION_TYPE_KEYS: Record<NonAllAffiliationType, string> = {
  employment: 'employments',
  education: 'educations',
  'invited-positions': 'invited-positions',
  distinctions: 'distinctions',
  memberships: 'memberships',
  qualifications: 'qualifications',
  services: 'services',
};

/** Requested section type → the singular key each summary is wrapped under. */
const AFFILIATION_SUMMARY_KEYS: Record<NonAllAffiliationType, AffiliationSummaryKey> = {
  employment: 'employment-summary',
  education: 'education-summary',
  'invited-positions': 'invited-position-summary',
  distinctions: 'distinction-summary',
  memberships: 'membership-summary',
  qualifications: 'qualification-summary',
  services: 'service-summary',
};

function normalizeSummary(raw: RawAffiliationSummary, type: string, orcidId: string): Affiliation {
  const org = normalizeOrg(raw.organization);
  const aff: Affiliation = { type, sources: normalizeSources([raw], orcidId) };
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

/**
 * Unwrap a group's summaries. ORCID nests each entry under its singular-type key
 * (`{ "employment-summary": { ... } }`), so the wrapper must be opened before the
 * fields are readable.
 */
function extractSummariesFromGroup(
  group: RawAffiliationGroup | undefined,
  type: NonAllAffiliationType,
  orcidId: string,
): Affiliation[] {
  const key = AFFILIATION_SUMMARY_KEYS[type];
  return (group?.summaries ?? []).flatMap((entry) => {
    const summary = entry[key];
    return summary ? [normalizeSummary(summary, type, orcidId)] : [];
  });
}

function extractGroupSummaries(
  groups: RawAffiliationGroup[] | undefined,
  type: NonAllAffiliationType,
  orcidId: string,
): Affiliation[] {
  return (groups ?? []).flatMap((g) => extractSummariesFromGroup(g, type, orcidId));
}

// ---------------------------------------------------------------------------
// Normalization functions (exported)
// ---------------------------------------------------------------------------

/** Normalized person fields returned from /person endpoint. */
export type NormalizedPerson = {
  givenNames?: string;
  familyName?: string;
  creditName?: string;
  /** Other names in upstream order; entries blank after trimming dropped. */
  otherNames: string[];
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
    otherNames: [],
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

  // An entry blank after trimming carries nothing; every other value is kept verbatim.
  const nonBlank = (values: (string | undefined)[] | undefined) =>
    (values ?? []).filter((value): value is string => Boolean(value?.trim()));
  result.otherNames = nonBlank(raw['other-names']?.['other-name']?.map((n) => n.content));
  result.keywords = nonBlank(raw.keywords?.keyword?.map((k) => k.content));

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

function normalizeWorkSummary(
  raw: RawWorkSummary,
  rawIds: RawWorkExternalId[],
  sources: Source[],
): Work {
  const work: Work = { externalIds: normalizeExternalIds(rawIds), sources };
  if (raw['put-code'] != null) work.putCode = raw['put-code'];
  const title = toPlainText(raw.title?.title?.value);
  if (title) work.title = title;
  if (raw.type) work.workType = raw.type;
  const pubDate = normalizeDate(raw['publication-date']);
  if (pubDate) work.publicationDate = pubDate;
  const journalTitle = toPlainText(raw['journal-title']?.value);
  if (journalTitle) work.journalTitle = journalTitle;
  if (raw.url?.value) work.url = raw.url.value;
  return work;
}

/**
 * One record per ORCID work group, built from `work-summary[0]` — ORCID sorts each group
 * so its preferred version comes first — carrying the identifiers and sources of the
 * whole group. `orcidId` is the requested iD, which `selfAsserted` compares against.
 */
export function normalizeWorks(raw: RawWorksResponse, orcidId: string): Work[] {
  return (raw.group ?? []).flatMap((g: RawWorksGroup) => {
    const summaries = g['work-summary'] ?? [];
    const preferred = summaries[0];
    if (!preferred) return [];
    return [
      normalizeWorkSummary(
        preferred,
        workGroupExternalIds(g, preferred),
        normalizeSources(summaries, orcidId),
      ),
    ];
  });
}

export function normalizeActivities(
  raw: RawActivities,
  types: AffiliationType[],
  orcidId: string,
): Affiliation[] {
  const resolvedTypes = types.includes('all')
    ? ALL_AFFILIATION_TYPES
    : (types as NonAllAffiliationType[]);

  return resolvedTypes.flatMap((type) => {
    const key = AFFILIATION_TYPE_KEYS[type];
    const section = (
      raw as Record<string, { 'affiliation-group'?: RawAffiliationGroup[] } | undefined>
    )[key];
    return extractGroupSummaries(section?.['affiliation-group'], type, orcidId);
  });
}

function normalizeFundingSummary(raw: RawFundingSummary, sources: Source[]): FundingRecord {
  const funder = normalizeOrg(raw.organization);
  const grantNumbers = normalizeExternalIds(raw['external-ids']?.['external-id'])
    .filter((id) => id.type === 'grant_number')
    .map((id) => id.value);
  const record: FundingRecord = { grantNumbers, sources };
  const title = toPlainText(raw.title?.title?.value);
  if (title) record.title = title;
  if (raw.type) record.type = raw.type;
  if (funder) record.funder = funder;
  const startDate = normalizeDate(raw['start-date']);
  if (startDate) record.startDate = startDate;
  const endDate = normalizeDate(raw['end-date']);
  if (endDate) record.endDate = endDate;
  if (raw.url?.value) record.url = raw.url.value;
  return record;
}

/**
 * Every distinct dated period across a funding group's versions, ordered by start date
 * (a period with no start last), or undefined when fewer than two are distinct. A version
 * with neither date contributes none. One grant number can cover distinct award periods,
 * so differing versions stay visible rather than collapsing into a span none recorded.
 */
function fundingPeriods(summaries: RawFundingSummary[]): FundingPeriod[] | undefined {
  const distinct = new Map<string, FundingPeriod>();
  for (const s of summaries) {
    const startDate = normalizeDate(s['start-date']);
    const endDate = normalizeDate(s['end-date']);
    if (!startDate && !endDate) continue;
    distinct.set(JSON.stringify([startDate, endDate]), {
      ...(startDate && { startDate }),
      ...(endDate && { endDate }),
    });
  }
  if (distinct.size < 2) return;
  const startKey = (p: FundingPeriod) => p.startDate ?? '￿';
  return [...distinct.values()].sort((a, b) =>
    startKey(a) < startKey(b) ? -1 : startKey(a) > startKey(b) ? 1 : 0,
  );
}

/**
 * One record per ORCID funding group, built from `funding-summary[0]` (ORCID's preferred
 * version) with the sources of every version, plus `periods` when the versions record
 * distinct award periods. `orcidId` is the requested iD, which `selfAsserted` compares against.
 */
export function normalizeFundings(raw: RawFundingsResponse, orcidId: string): FundingRecord[] {
  return (raw.group ?? []).flatMap((g: RawFundingGroup) => {
    const summaries = g['funding-summary'] ?? [];
    const preferred = summaries[0];
    if (!preferred) return [];
    const record = normalizeFundingSummary(preferred, normalizeSources(summaries, orcidId));
    const periods = fundingPeriods(summaries);
    if (periods) record.periods = periods;
    return [record];
  });
}

export function normalizePeerReviews(raw: RawPeerReviewsResponse, orcidId: string): PeerReview[] {
  return (raw.group ?? []).flatMap((g: RawPeerReviewGroup) => {
    // ORCID types the group identifier `peer-review` and carries the ISSN inside the
    // value as `issn:1476-4687`. Non-journal groups use other prefixes (`orcid-generated:`),
    // so the prefix — not the type — is what gates an ISSN.
    const groupId = g['external-ids']?.['external-id']?.find((id) =>
      id['external-id-value']?.startsWith(ISSN_PREFIX),
    )?.['external-id-value'];
    const issn = groupId?.slice(ISSN_PREFIX.length);

    return (g['peer-review-group'] ?? []).flatMap((prg) =>
      (prg['peer-review-summary'] ?? []).map((s): PeerReview => {
        const org = normalizeOrg(s['convening-organization']);
        const review: PeerReview = { sources: normalizeSources([s], orcidId) };
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

export function normalizeWorkDetail(raw: RawWorkDetail, orcidId: string): WorkDetail {
  const externalIds = normalizeExternalIds(raw['external-ids']?.['external-id']);
  const contributors = (raw.contributors?.contributor ?? []).map(normalizeContributor);
  const detail: WorkDetail = {
    putCode: raw['put-code'] ?? 0,
    externalIds,
    contributors,
    sources: normalizeSources([raw], orcidId),
  };
  const titleVal = toPlainText(raw.title?.title?.value);
  if (titleVal) detail.title = titleVal;
  const subtitleVal = toPlainText(raw.title?.subtitle?.value);
  if (subtitleVal) detail.subtitle = subtitleVal;
  if (raw.type) detail.workType = raw.type;
  const pubDate = normalizeDate(raw['publication-date'] ?? undefined);
  if (pubDate) detail.publicationDate = pubDate;
  const journalTitle = toPlainText(raw['journal-title']?.value);
  if (journalTitle) detail.journalTitle = journalTitle;
  const abstract = toPlainText(raw['short-description']?.trim());
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
export function normalizeBulkWorks(raw: RawBulkWorksResponse, orcidId: string): BulkWorkResult[] {
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
    return { type: 'work', detail: normalizeWorkDetail(entry.work, orcidId) };
  });
}

export function normalizeResearchResources(
  raw: RawResearchResourcesResponse,
  orcidId: string,
): ResearchResource[] {
  return (raw.group ?? []).flatMap((g: RawResearchResourceGroup) =>
    (g['research-resource-summary'] ?? []).flatMap((s): ResearchResource[] => {
      const putCode = s['put-code'];
      if (!putCode) return [];
      const resource: ResearchResource = {
        putCode,
        externalIds: [],
        sources: normalizeSources([s], orcidId),
      };
      const titleVal = toPlainText(s.proposal?.title?.title?.value);
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
