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

/** Full work detail as returned by /work/{putCode}. */
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
  'convening-organization'?: RawOrganization | null;
  'review-url'?: { value?: string } | null;
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
  putCode?: number;
  title?: string;
  workType?: string;
  publicationDate?: NormalizedDate;
  journalTitle?: string;
  url?: string;
  externalIds: ExternalIdentifier[];
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

/** Normalized research resource record. */
export type ResearchResource = {
  putCode: number;
  title?: string;
  hostOrganization?: Organization;
  externalIds: ExternalIdentifier[];
  startDate?: NormalizedDate;
  endDate?: NormalizedDate;
  url?: string;
};
