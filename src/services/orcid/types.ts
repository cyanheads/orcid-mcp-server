/**
 * @fileoverview Raw ORCID API response types and normalized domain types for orcid-mcp-server.
 * @module services/orcid/types
 */

// ---------------------------------------------------------------------------
// Raw API shapes — all fields optional because ORCID data is self-reported and
// visibility settings may suppress any section or field.
// ---------------------------------------------------------------------------

/** A date value returned by ORCID (year, month, day all optional). */
export type OrcidDate = {
  year?: { value?: string };
  month?: { value?: string };
  day?: { value?: string };
};

/** Disambiguated organization (may carry GRID, ROR, or Ringgold ID). */
export type RawDisambiguatedOrg = {
  'disambiguated-organization-identifier'?: string;
  'disambiguation-source'?: string;
};

/** Organization as returned in affiliation records. */
export type RawOrganization = {
  name?: string;
  address?: {
    city?: string;
    region?: string;
    country?: string;
  };
  'disambiguated-organization'?: RawDisambiguatedOrg;
};

/** Affiliation entry (employment, education, etc.). */
export type RawAffiliationSummary = {
  'put-code'?: number;
  'department-name'?: string;
  'role-title'?: string;
  'start-date'?: OrcidDate;
  'end-date'?: OrcidDate;
  organization?: RawOrganization;
  url?: { value?: string };
};

/** Container for a group of affiliation summaries. */
export type RawAffiliationGroup = {
  'affiliation-summary'?: RawAffiliationSummary[];
  summaries?: RawAffiliationSummary[];
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
  'external-id-url'?: { value?: string };
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
    title?: { value?: string };
    subtitle?: { value?: string };
  };
  'work-type'?: string;
  'publication-date'?: OrcidDate;
  'journal-title'?: { value?: string };
  url?: { value?: string };
  'external-ids'?: {
    'external-id'?: RawWorkExternalId[];
  };
  source?: {
    'source-name'?: { value?: string };
  };
  visibility?: string;
};

/** Works group (works are grouped by external ID intersection). */
export type RawWorksGroup = {
  'external-ids'?: {
    'external-id'?: RawWorkExternalId[];
  };
  'work-summary'?: RawWorkSummary[];
};

/** Top-level works response. */
export type RawWorksResponse = {
  group?: RawWorksGroup[];
  'last-modified-date'?: { value?: number };
};

/** Funding summary. */
export type RawFundingSummary = {
  'put-code'?: number;
  title?: { title?: { value?: string } };
  type?: string;
  'start-date'?: OrcidDate;
  'end-date'?: OrcidDate;
  organization?: RawOrganization;
  'external-ids'?: {
    'external-id'?: RawWorkExternalId[];
  };
  url?: { value?: string };
};

/** Funding group. */
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
  'convening-organization'?: RawOrganization;
  'review-url'?: { value?: string };
};

/** Peer review group (keyed by ISSN). */
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
};

/** Normalized work record. */
export type Work = {
  title?: string;
  workType?: string;
  publicationDate?: NormalizedDate;
  journalTitle?: string;
  url?: string;
  externalIds: ExternalIdentifier[];
};

/** Normalized funding record. */
export type FundingRecord = {
  title?: string;
  type?: string;
  funder?: Organization;
  startDate?: NormalizedDate;
  endDate?: NormalizedDate;
  grantNumbers: string[];
  url?: string;
};

/** Normalized peer review record. */
export type PeerReview = {
  reviewerRole?: string;
  reviewType?: string;
  completionDate?: NormalizedDate;
  conveningOrganization?: Organization;
  reviewUrl?: string;
  groupIssn?: string;
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
