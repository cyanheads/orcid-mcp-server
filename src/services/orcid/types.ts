/**
 * @fileoverview Raw ORCID API response types and normalized domain types for orcid-mcp-server.
 * @module services/orcid/types
 */

// ---------------------------------------------------------------------------
// Raw API shapes — all fields optional because each item carries only what its source
// (the researcher or a member organization) recorded, and visibility settings may
// suppress any section or field.
// ---------------------------------------------------------------------------

/** An ORCID iD or member client reference inside a `source` block. */
export type RawOrcidPathRef = { uri?: string; path?: string; host?: string };

/**
 * Who added an activity item. Exactly one of `source-orcid` (a person, or a legacy client)
 * and `source-client-id` (a member organization system) is set. `assertion-origin-*` names
 * the party the source asserted on behalf of; when absent the source is the assertion origin.
 */
export type RawSource = {
  'source-orcid'?: RawOrcidPathRef | null;
  'source-client-id'?: RawOrcidPathRef | null;
  'source-name'?: { value?: string } | null;
  'assertion-origin-orcid'?: RawOrcidPathRef | null;
  'assertion-origin-client-id'?: RawOrcidPathRef | null;
  'assertion-origin-name'?: { value?: string } | null;
};

/** A date value returned by ORCID (year, month, day all optional). */
export type OrcidDate = {
  year?: { value?: string } | null;
  month?: { value?: string } | null;
  day?: { value?: string } | null;
};

/** Disambiguated organization (may carry GRID, ROR, or Ringgold ID). */
export type RawDisambiguatedOrg = {
  'disambiguated-organization-identifier'?: string;
  'disambiguation-source'?: string;
};

/**
 * Organization as returned in affiliation records.
 * ORCID emits explicit `null` for unset fields rather than omitting them.
 */
export type RawOrganization = {
  name?: string;
  address?: {
    city?: string | null;
    region?: string | null;
    country?: string | null;
  } | null;
  'disambiguated-organization'?: RawDisambiguatedOrg | null;
};

/** Affiliation entry (employment, education, etc.). */
export type RawAffiliationSummary = {
  'put-code'?: number;
  'department-name'?: string | null;
  'role-title'?: string | null;
  'start-date'?: OrcidDate | null;
  'end-date'?: OrcidDate | null;
  organization?: RawOrganization | null;
  url?: { value?: string } | null;
  source?: RawSource | null;
};

/**
 * Singular wrapper key ORCID nests each affiliation summary under, one per section.
 * The section names are plural-ish (`invited-positions`, `distinctions`, `services`)
 * while the wrapper keys are singular, so the two never line up by string surgery.
 */
export type AffiliationSummaryKey =
  | 'employment-summary'
  | 'education-summary'
  | 'invited-position-summary'
  | 'distinction-summary'
  | 'membership-summary'
  | 'qualification-summary'
  | 'service-summary';

/** One `summaries[]` entry — a single-key object wrapping the summary. */
export type RawAffiliationSummaryEntry = Partial<
  Record<AffiliationSummaryKey, RawAffiliationSummary>
>;

/** Container for a group of affiliation summaries. */
export type RawAffiliationGroup = {
  summaries?: RawAffiliationSummaryEntry[];
};

/** Activities response sections. */
export type RawActivities = {
  'last-modified-date'?: { value?: number };
  employments?: {
    'affiliation-group'?: RawAffiliationGroup[];
    'last-modified-date'?: { value?: number };
  };
  educations?: {
    'affiliation-group'?: RawAffiliationGroup[];
    'last-modified-date'?: { value?: number };
  };
  'invited-positions'?: {
    'affiliation-group'?: RawAffiliationGroup[];
    'last-modified-date'?: { value?: number };
  };
  distinctions?: {
    'affiliation-group'?: RawAffiliationGroup[];
    'last-modified-date'?: { value?: number };
  };
  memberships?: {
    'affiliation-group'?: RawAffiliationGroup[];
    'last-modified-date'?: { value?: number };
  };
  qualifications?: {
    'affiliation-group'?: RawAffiliationGroup[];
    'last-modified-date'?: { value?: number };
  };
  services?: {
    'affiliation-group'?: RawAffiliationGroup[];
    'last-modified-date'?: { value?: number };
  };
};

/** External identifier (used in both person and work records). */
export type RawWorkExternalId = {
  'external-id-type'?: string;
  'external-id-value'?: string;
  /** ORCID's canonical form of the value (lower-cased DOI, `PMC` prefix stripped). */
  'external-id-normalized'?: { value?: string; transient?: boolean } | null;
  'external-id-url'?: { value?: string } | null;
  'external-id-relationship'?: string;
};

/** Alias for RawWorkExternalId — same shape, used in person records. */
export type RawExternalId = RawWorkExternalId;

/** Person section from ORCID. */
export type RawPerson = {
  name?: {
    'given-names'?: { value?: string };
    'family-name'?: { value?: string };
    'credit-name'?: { value?: string };
  };
  /** Listed by descending `display-index`, the order the ORCID record shows them. */
  'other-names'?: {
    'other-name'?: Array<{ content?: string; 'display-index'?: number }>;
  };
  biography?: { content?: string };
  keywords?: {
    keyword?: Array<{ content?: string }>;
  };
  'researcher-urls'?: {
    'researcher-url'?: Array<{
      'url-name'?: string;
      url?: { value?: string };
    }>;
  };
  'external-identifiers'?: {
    'external-identifier'?: RawExternalId[];
  };
  emails?: {
    email?: Array<{
      email?: string;
      primary?: boolean;
      verified?: boolean;
    }>;
  };
  addresses?: {
    address?: Array<{
      country?: { value?: string };
      primary?: boolean;
    }>;
  };
};

/** Work summary as returned by /works. */
export type RawWorkSummary = {
  'put-code'?: number;
  title?: {
    title?: { value?: string } | null;
    subtitle?: { value?: string } | null;
    'translated-title'?: { value?: string } | null;
  };
  type?: string;
  'publication-date'?: OrcidDate;
  'journal-title'?: { value?: string } | null;
  url?: { value?: string } | null;
  'external-ids'?: {
    'external-id'?: RawWorkExternalId[];
  };
  source?: RawSource | null;
  visibility?: string;
};

/**
 * Works group — one work, holding one summary per source, preferred version first.
 * The group-level `external-ids` union the `self` identifiers of every summary.
 */
export type RawWorksGroup = {
  'external-ids'?: {
    'external-id'?: RawWorkExternalId[];
  } | null;
  'work-summary'?: RawWorkSummary[];
};

/** Top-level works response. */
export type RawWorksResponse = {
  group?: RawWorksGroup[];
  'last-modified-date'?: { value?: number };
};

/** Full work detail, as each `work` entry of the bulk `/works/{putCodes}` response carries it. */
export type RawWorkDetail = {
  'put-code'?: number;
  path?: string;
  title?: {
    title?: { value?: string } | null;
    subtitle?: { value?: string } | null;
    'translated-title'?: { value?: string } | null;
  };
  'journal-title'?: { value?: string } | null;
  /** Abstract or short description — stored in short-description by ORCID. */
  'short-description'?: string | null;
  citation?: {
    'citation-type'?: string | null;
    'citation-value'?: string | null;
  } | null;
  type?: string | null;
  'publication-date'?: OrcidDate | null;
  'external-ids'?: {
    'external-id'?: RawWorkExternalId[];
  } | null;
  url?: { value?: string } | null;
  contributors?: {
    contributor?: RawWorkContributor[];
  } | null;
  'language-code'?: string | null;
  country?: { value?: string } | null;
  visibility?: string | null;
  source?: RawSource | null;
};

/** Contributor entry from a full work detail record. */
export type RawWorkContributor = {
  'contributor-orcid'?: { path?: string } | null;
  'credit-name'?: { value?: string } | null;
  'contributor-email'?: string | null;
  'contributor-attributes'?: {
    'contributor-sequence'?: string | null;
    'contributor-role'?: string | null;
  } | null;
};

/** Funding summary. */
export type RawFundingSummary = {
  'put-code'?: number;
  title?: { title?: { value?: string } };
  type?: string;
  'start-date'?: OrcidDate | null;
  'end-date'?: OrcidDate | null;
  organization?: RawOrganization;
  'external-ids'?: {
    'external-id'?: RawWorkExternalId[];
  };
  url?: { value?: string };
  source?: RawSource | null;
};

/**
 * Funding group — one funding item, holding one summary per source or deposit sharing a
 * grant identifier, preferred version first.
 */
export type RawFundingGroup = {
  'funding-summary'?: RawFundingSummary[];
};

/** Top-level fundings response. */
export type RawFundingsResponse = {
  group?: RawFundingGroup[];
};

/** Peer review summary. */
export type RawPeerReviewSummary = {
  'put-code'?: number;
  'reviewer-role'?: string;
  'review-type'?: string;
  'completion-date'?: OrcidDate;
  'convening-organization'?: RawOrganization | null;
  'review-url'?: { value?: string } | null;
  source?: RawSource | null;
};

/**
 * Peer review group. The group-level external id is typed `peer-review`; its value
 * carries the key, prefixed — `issn:1476-4687` for journals, `orcid-generated:…` otherwise.
 */
export type RawPeerReviewGroup = {
  'peer-review-group'?: Array<{
    'peer-review-summary'?: RawPeerReviewSummary[];
  }>;
  'external-ids'?: {
    'external-id'?: RawWorkExternalId[];
  };
};

/** Top-level peer-reviews response. */
export type RawPeerReviewsResponse = {
  group?: RawPeerReviewGroup[];
};

/** Expanded search result entry. */
export type RawExpandedSearchResult = {
  'orcid-id'?: string;
  'given-names'?: string;
  'family-names'?: string;
  'credit-name'?: string;
  'other-name'?: string[];
  email?: string[];
  'institution-name'?: string[];
};

/** Expanded search response. */
export type RawExpandedSearchResponse = {
  'expanded-result'?: RawExpandedSearchResult[];
  'num-found'?: number;
};

/** Research resource summary as returned by /research-resources. */
export type RawResearchResourceSummary = {
  'put-code'?: number;
  path?: string;
  visibility?: string | null;
  'display-index'?: string | null;
  'created-date'?: { value?: number } | null;
  'last-modified-date'?: { value?: number } | null;
  source?: RawSource | null;
  proposal?: {
    title?: {
      title?: { value?: string } | null;
    } | null;
    hosts?: {
      organization?: RawOrganization[];
    } | null;
    'external-ids'?: {
      'external-id'?: RawWorkExternalId[];
    } | null;
    'start-date'?: OrcidDate | null;
    'end-date'?: OrcidDate | null;
    url?: { value?: string } | null;
  } | null;
};

/**
 * Bulk works endpoint — each entry is either a successful `work` or an `error`.
 * GET /v3.0/{orcid}/works/{putCode1},{putCode2},...
 */
export type RawBulkWorkEntry =
  | { work: RawWorkDetail; error?: undefined }
  | {
      error: {
        'put-code'?: number;
        'response-code'?: number;
        'developer-message'?: string;
        'error-code'?: number;
      };
      work?: undefined;
    };

/** Top-level bulk works response. */
export type RawBulkWorksResponse = {
  bulk?: RawBulkWorkEntry[];
};

/** Normalized result from the bulk endpoint — either a full detail or an error. */
export type BulkWorkResult =
  | { type: 'work'; detail: WorkDetail }
  | { type: 'error'; putCode?: number; message: string };

/** Research resource group (grouped by external ID). */
export type RawResearchResourceGroup = {
  'last-modified-date'?: { value?: number } | null;
  'external-ids'?: {
    'external-id'?: RawWorkExternalId[];
  } | null;
  'research-resource-summary'?: RawResearchResourceSummary[];
};

/** Top-level research-resources response. */
export type RawResearchResourcesResponse = {
  'last-modified-date'?: { value?: number } | null;
  group?: RawResearchResourceGroup[];
  path?: string;
};

// ---------------------------------------------------------------------------
// Normalized domain types — camelCase, optional fields preserved
// ---------------------------------------------------------------------------

/** Normalized date string (YYYY, YYYY-MM, or YYYY-MM-DD). */
export type NormalizedDate = string;

/** Normalized external identifier. */
export type ExternalIdentifier = {
  type: string;
  value: string;
  url?: string;
  relationship?: string;
};

/** Who asserted an item on the ORCID record. */
export type Source = {
  /** `source-name`: the person or member system that added the item. */
  name?: string;
  /** `assertion-origin-name`: set when the source added the item on that party's behalf. */
  assertionOriginName?: string;
  /** The asserting party (assertion origin when recorded, else the source) is the requested iD. */
  selfAsserted: boolean;
};

/** Normalized organization with optional disambiguator. */
export type Organization = {
  name?: string;
  city?: string;
  country?: string;
  disambiguatedId?: string;
  disambiguationSource?: string;
};

/** Normalized affiliation record. */
export type Affiliation = {
  type: string;
  organization?: Organization;
  department?: string;
  role?: string;
  startDate?: NormalizedDate;
  endDate?: NormalizedDate;
  url?: string;
  sources: Source[];
};

/** Normalized work record — one per ORCID work group. */
export type Work = {
  putCode?: number;
  title?: string;
  workType?: string;
  publicationDate?: NormalizedDate;
  journalTitle?: string;
  url?: string;
  externalIds: ExternalIdentifier[];
  /** Every distinct source in the work group, the representative summary's first. */
  sources: Source[];
};

/** Normalized contributor from a full work detail. */
export type WorkContributor = {
  name?: string;
  orcidId?: string;
  role?: string;
  sequence?: string;
};

/** Normalized full work detail record. */
export type WorkDetail = {
  putCode: number;
  title?: string;
  subtitle?: string;
  workType?: string;
  publicationDate?: NormalizedDate;
  journalTitle?: string;
  abstract?: string;
  citation?: { type: string; value: string };
  url?: string;
  externalIds: ExternalIdentifier[];
  contributors: WorkContributor[];
  languageCode?: string;
  sources: Source[];
};

/** One award period recorded by a version of a funding item. */
export type FundingPeriod = {
  startDate?: NormalizedDate;
  endDate?: NormalizedDate;
};

/** Normalized funding record — one per ORCID funding group, from its preferred version. */
export type FundingRecord = {
  title?: string;
  type?: string;
  funder?: Organization;
  startDate?: NormalizedDate;
  endDate?: NormalizedDate;
  grantNumbers: string[];
  url?: string;
  /** Every distinct dated period across the group's versions, when there are two or more. */
  periods?: FundingPeriod[];
  /** Every distinct source in the funding group, the representative summary's first. */
  sources: Source[];
};

/** Normalized peer review record. */
export type PeerReview = {
  reviewerRole?: string;
  reviewType?: string;
  completionDate?: NormalizedDate;
  conveningOrganization?: Organization;
  reviewUrl?: string;
  groupIssn?: string;
  sources: Source[];
};

/** Normalized expanded search result. */
export type ExpandedSearchResult = {
  orcidId: string;
  givenNames?: string;
  familyNames?: string;
  creditName?: string;
  otherNames: string[];
  emails: string[];
  institutionNames: string[];
};

/** Expanded search response normalized. */
export type ExpandedSearchResponse = {
  results: ExpandedSearchResult[];
  numFound: number;
};

/** Normalized research resource record. */
export type ResearchResource = {
  putCode: number;
  title?: string;
  hostOrganization?: Organization;
  externalIds: ExternalIdentifier[];
  startDate?: NormalizedDate;
  endDate?: NormalizedDate;
  url?: string;
  sources: Source[];
};
