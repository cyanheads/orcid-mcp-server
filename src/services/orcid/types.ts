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
export type RawOrcidPathRef = {
  uri?: undefined | string;
  path?: undefined | string;
  host?: undefined | string;
};

/**
 * Who added an activity item. Exactly one of `source-orcid` (a person, or a legacy client)
 * and `source-client-id` (a member organization system) is set. `assertion-origin-*` names
 * the party the source asserted on behalf of; when absent the source is the assertion origin.
 */
export type RawSource = {
  'source-orcid'?: undefined | RawOrcidPathRef | null;
  'source-client-id'?: undefined | RawOrcidPathRef | null;
  'source-name'?: undefined | { value?: undefined | string } | null;
  'assertion-origin-orcid'?: undefined | RawOrcidPathRef | null;
  'assertion-origin-client-id'?: undefined | RawOrcidPathRef | null;
  'assertion-origin-name'?: undefined | { value?: undefined | string } | null;
};

/** A date value returned by ORCID (year, month, day all optional). */
export type OrcidDate = {
  year?: undefined | { value?: undefined | string } | null;
  month?: undefined | { value?: undefined | string } | null;
  day?: undefined | { value?: undefined | string } | null;
};

/** Disambiguated organization (may carry GRID, ROR, or Ringgold ID). */
export type RawDisambiguatedOrg = {
  'disambiguated-organization-identifier'?: undefined | string;
  'disambiguation-source'?: undefined | string;
};

/**
 * Organization as returned in affiliation records.
 * ORCID emits explicit `null` for unset fields rather than omitting them.
 */
export type RawOrganization = {
  name?: undefined | string;
  address?:
    | undefined
    | {
        city?: undefined | string | null;
        region?: undefined | string | null;
        country?: undefined | string | null;
      }
    | null;
  'disambiguated-organization'?: undefined | RawDisambiguatedOrg | null;
};

/** Affiliation entry (employment, education, etc.). */
export type RawAffiliationSummary = {
  'put-code'?: undefined | number;
  'department-name'?: undefined | string | null;
  'role-title'?: undefined | string | null;
  'start-date'?: undefined | OrcidDate | null;
  'end-date'?: undefined | OrcidDate | null;
  organization?: undefined | RawOrganization | null;
  url?: undefined | { value?: undefined | string } | null;
  source?: undefined | RawSource | null;
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
  Record<AffiliationSummaryKey, RawAffiliationSummary | undefined>
>;

/** Container for a group of affiliation summaries. */
export type RawAffiliationGroup = {
  summaries?: undefined | RawAffiliationSummaryEntry[];
};

/** Activities response sections. */
export type RawActivities = {
  'last-modified-date'?: undefined | { value?: undefined | number };
  employments?:
    | undefined
    | {
        'affiliation-group'?: undefined | RawAffiliationGroup[];
        'last-modified-date'?: undefined | { value?: undefined | number };
      };
  educations?:
    | undefined
    | {
        'affiliation-group'?: undefined | RawAffiliationGroup[];
        'last-modified-date'?: undefined | { value?: undefined | number };
      };
  'invited-positions'?:
    | undefined
    | {
        'affiliation-group'?: undefined | RawAffiliationGroup[];
        'last-modified-date'?: undefined | { value?: undefined | number };
      };
  distinctions?:
    | undefined
    | {
        'affiliation-group'?: undefined | RawAffiliationGroup[];
        'last-modified-date'?: undefined | { value?: undefined | number };
      };
  memberships?:
    | undefined
    | {
        'affiliation-group'?: undefined | RawAffiliationGroup[];
        'last-modified-date'?: undefined | { value?: undefined | number };
      };
  qualifications?:
    | undefined
    | {
        'affiliation-group'?: undefined | RawAffiliationGroup[];
        'last-modified-date'?: undefined | { value?: undefined | number };
      };
  services?:
    | undefined
    | {
        'affiliation-group'?: undefined | RawAffiliationGroup[];
        'last-modified-date'?: undefined | { value?: undefined | number };
      };
};

/** External identifier (used in both person and work records). */
export type RawWorkExternalId = {
  'external-id-type'?: undefined | string;
  'external-id-value'?: undefined | string;
  /** ORCID's canonical form of the value (lower-cased DOI, `PMC` prefix stripped). */
  'external-id-normalized'?:
    | undefined
    | { value?: undefined | string; transient?: undefined | boolean }
    | null;
  'external-id-url'?: undefined | { value?: undefined | string } | null;
  'external-id-relationship'?: undefined | string;
};

/** Alias for RawWorkExternalId — same shape, used in person records. */
export type RawExternalId = RawWorkExternalId;

/** Person section from ORCID. */
export type RawPerson = {
  name?:
    | undefined
    | {
        'given-names'?: undefined | { value?: undefined | string };
        'family-name'?: undefined | { value?: undefined | string };
        'credit-name'?: undefined | { value?: undefined | string };
      };
  /** Listed by descending `display-index`, the order the ORCID record shows them. */
  'other-names'?:
    | undefined
    | {
        'other-name'?:
          | undefined
          | Array<{ content?: undefined | string; 'display-index'?: undefined | number }>;
      };
  biography?: undefined | { content?: undefined | string };
  keywords?:
    | undefined
    | {
        keyword?: undefined | Array<{ content?: undefined | string }>;
      };
  'researcher-urls'?:
    | undefined
    | {
        'researcher-url'?:
          | undefined
          | Array<{
              'url-name'?: undefined | string;
              url?: undefined | { value?: undefined | string };
            }>;
      };
  'external-identifiers'?:
    | undefined
    | {
        'external-identifier'?: undefined | RawExternalId[];
      };
  emails?:
    | undefined
    | {
        email?:
          | undefined
          | Array<{
              email?: undefined | string;
              primary?: undefined | boolean;
              verified?: undefined | boolean;
            }>;
      };
  addresses?:
    | undefined
    | {
        address?:
          | undefined
          | Array<{
              country?: undefined | { value?: undefined | string };
              primary?: undefined | boolean;
            }>;
      };
};

/** Work summary as returned by /works. */
export type RawWorkSummary = {
  'put-code'?: undefined | number;
  title?:
    | undefined
    | {
        title?: undefined | { value?: undefined | string } | null;
        subtitle?: undefined | { value?: undefined | string } | null;
        'translated-title'?: undefined | { value?: undefined | string } | null;
      };
  type?: undefined | string;
  'publication-date'?: undefined | OrcidDate;
  'journal-title'?: undefined | { value?: undefined | string } | null;
  url?: undefined | { value?: undefined | string } | null;
  'external-ids'?:
    | undefined
    | {
        'external-id'?: undefined | RawWorkExternalId[];
      };
  source?: undefined | RawSource | null;
  visibility?: undefined | string;
};

/**
 * Works group — one work, holding one summary per source, preferred version first.
 * The group-level `external-ids` union the `self` identifiers of every summary.
 */
export type RawWorksGroup = {
  'external-ids'?:
    | undefined
    | {
        'external-id'?: undefined | RawWorkExternalId[];
      }
    | null;
  'work-summary'?: undefined | RawWorkSummary[];
};

/** Top-level works response. */
export type RawWorksResponse = {
  group?: undefined | RawWorksGroup[];
  'last-modified-date'?: undefined | { value?: undefined | number };
};

/** Full work detail, as each `work` entry of the bulk `/works/{putCodes}` response carries it. */
export type RawWorkDetail = {
  'put-code'?: undefined | number;
  path?: undefined | string;
  title?:
    | undefined
    | {
        title?: undefined | { value?: undefined | string } | null;
        subtitle?: undefined | { value?: undefined | string } | null;
        'translated-title'?: undefined | { value?: undefined | string } | null;
      };
  'journal-title'?: undefined | { value?: undefined | string } | null;
  /** Abstract or short description — stored in short-description by ORCID. */
  'short-description'?: undefined | string | null;
  citation?:
    | undefined
    | {
        'citation-type'?: undefined | string | null;
        'citation-value'?: undefined | string | null;
      }
    | null;
  type?: undefined | string | null;
  'publication-date'?: undefined | OrcidDate | null;
  'external-ids'?:
    | undefined
    | {
        'external-id'?: undefined | RawWorkExternalId[];
      }
    | null;
  url?: undefined | { value?: undefined | string } | null;
  contributors?:
    | undefined
    | {
        contributor?: undefined | RawWorkContributor[];
      }
    | null;
  'language-code'?: undefined | string | null;
  country?: undefined | { value?: undefined | string } | null;
  visibility?: undefined | string | null;
  source?: undefined | RawSource | null;
};

/** Contributor entry from a full work detail record. */
export type RawWorkContributor = {
  'contributor-orcid'?: undefined | { path?: undefined | string } | null;
  'credit-name'?: undefined | { value?: undefined | string } | null;
  'contributor-email'?: undefined | string | null;
  'contributor-attributes'?:
    | undefined
    | {
        'contributor-sequence'?: undefined | string | null;
        'contributor-role'?: undefined | string | null;
      }
    | null;
};

/** Funding summary. */
export type RawFundingSummary = {
  'put-code'?: undefined | number;
  title?: undefined | { title?: undefined | { value?: undefined | string } };
  type?: undefined | string;
  'start-date'?: undefined | OrcidDate | null;
  'end-date'?: undefined | OrcidDate | null;
  organization?: undefined | RawOrganization;
  'external-ids'?:
    | undefined
    | {
        'external-id'?: undefined | RawWorkExternalId[];
      };
  url?: undefined | { value?: undefined | string };
  source?: undefined | RawSource | null;
};

/**
 * Funding group — one funding item, holding one summary per source or deposit sharing a
 * grant identifier, preferred version first.
 */
export type RawFundingGroup = {
  'funding-summary'?: undefined | RawFundingSummary[];
};

/** One deposited award returned by the selected funding endpoint. */
export type RawFundingDetail = RawFundingSummary & {
  'short-description'?: string | undefined | null;
  amount?: { value?: string | undefined; 'currency-code'?: string | undefined } | undefined | null;
};

/** Top-level fundings response. */
export type RawFundingsResponse = {
  group?: undefined | RawFundingGroup[];
};

/** Peer review summary. */
export type RawPeerReviewSummary = {
  'put-code'?: undefined | number;
  'reviewer-role'?: undefined | string;
  'review-type'?: undefined | string;
  'completion-date'?: undefined | OrcidDate;
  'convening-organization'?: undefined | RawOrganization | null;
  'review-url'?: undefined | { value?: undefined | string } | null;
  source?: undefined | RawSource | null;
};

/**
 * Peer review group. The group-level external id is typed `peer-review`; its value
 * carries the key, prefixed — `issn:1476-4687` for journals, `orcid-generated:…` otherwise.
 */
export type RawPeerReviewGroup = {
  'peer-review-group'?:
    | undefined
    | Array<{
        'peer-review-summary'?: undefined | RawPeerReviewSummary[];
      }>;
  'external-ids'?:
    | undefined
    | {
        'external-id'?: undefined | RawWorkExternalId[];
      };
};

/** Top-level peer-reviews response. */
export type RawPeerReviewsResponse = {
  group?: undefined | RawPeerReviewGroup[];
};

/** Expanded search result entry. */
export type RawExpandedSearchResult = {
  'orcid-id'?: undefined | string;
  'given-names'?: undefined | string;
  'family-names'?: undefined | string;
  'credit-name'?: undefined | string;
  'other-name'?: undefined | string[];
  email?: undefined | string[];
  'institution-name'?: undefined | string[];
};

/** Expanded search response. */
export type RawExpandedSearchResponse = {
  'expanded-result'?: undefined | RawExpandedSearchResult[];
  'num-found'?: undefined | number;
};

/** Research resource summary as returned by /research-resources. */
export type RawResearchResourceSummary = {
  'put-code'?: undefined | number;
  path?: undefined | string;
  visibility?: undefined | string | null;
  'display-index'?: undefined | string | null;
  'created-date'?: undefined | { value?: undefined | number } | null;
  'last-modified-date'?: undefined | { value?: undefined | number } | null;
  source?: undefined | RawSource | null;
  proposal?:
    | undefined
    | {
        title?:
          | undefined
          | {
              title?: undefined | { value?: undefined | string } | null;
            }
          | null;
        hosts?:
          | undefined
          | {
              organization?: undefined | RawOrganization[];
            }
          | null;
        'external-ids'?:
          | undefined
          | {
              'external-id'?: undefined | RawWorkExternalId[];
            }
          | null;
        'start-date'?: undefined | OrcidDate | null;
        'end-date'?: undefined | OrcidDate | null;
        url?: undefined | { value?: undefined | string } | null;
      }
    | null;
};

/** Full allocation record; item keys follow the ORCID research-resource v3 schema. */
export type RawResearchResourceDetail = RawResearchResourceSummary & {
  'resource-item'?:
    | undefined
    | {
        'resource-name'?: undefined | string | null;
        'resource-type'?: undefined | string | null;
        hosts?: undefined | { organization?: undefined | RawOrganization[] } | null;
        'external-ids'?: undefined | { 'external-id'?: undefined | RawWorkExternalId[] } | null;
        url?: undefined | { value?: undefined | string } | null;
      }[]
    | null;
};

/**
 * Bulk works endpoint — each entry is either a successful `work` or an `error`.
 * GET /v3.0/{orcid}/works/{putCode1},{putCode2},...
 */
export type RawBulkWorkEntry =
  | { work: RawWorkDetail; error?: undefined }
  | {
      error: {
        'put-code'?: undefined | number;
        'response-code'?: undefined | number;
        'developer-message'?: undefined | string;
        'error-code'?: undefined | number;
      };
      work?: undefined;
    };

/** Top-level bulk works response. */
export type RawBulkWorksResponse = {
  bulk?: undefined | RawBulkWorkEntry[];
};

/** Normalized result from the bulk endpoint — either a full detail or an error. */
export type BulkWorkResult =
  | { type: 'work'; detail: WorkDetail }
  | { type: 'error'; putCode?: undefined | number; message: string };

/** Research resource group (grouped by external ID). */
export type RawResearchResourceGroup = {
  'last-modified-date'?: undefined | { value?: undefined | number } | null;
  'external-ids'?:
    | undefined
    | {
        'external-id'?: undefined | RawWorkExternalId[];
      }
    | null;
  'research-resource-summary'?: undefined | RawResearchResourceSummary[];
};

/** Top-level research-resources response. */
export type RawResearchResourcesResponse = {
  'last-modified-date'?: undefined | { value?: undefined | number } | null;
  group?: undefined | RawResearchResourceGroup[];
  path?: undefined | string;
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
  /** The asserting party (assertion origin when recorded, else the source) is the record's iD. */
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

/** Preferred funding group summary or one selected deposit's detail. */
export type FundingRecord = {
  putCode?: number;
  description?: string;
  amount?: { value?: string; currency?: string };
  title?: string;
  type?: string;
  funder?: Organization;
  startDate?: NormalizedDate;
  endDate?: NormalizedDate;
  grantNumbers: string[];
  url?: string;
  /** Every distinct dated period across the group's versions, when there are two or more. */
  periods?: FundingPeriod[];
  /** Group sources in summary mode; the selected deposit's own source in detail mode. */
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
  proposalHosts?: Organization[];
  externalIds: ExternalIdentifier[];
  startDate?: NormalizedDate;
  endDate?: NormalizedDate;
  url?: string;
  sources: Source[];
};

/** One allocated resource, with its operators kept separate from the proposal hosts. */
export type ResearchResourceItem = {
  name?: string;
  type?: string;
  hosts: Organization[];
  externalIds: ExternalIdentifier[];
  url?: string;
};

/** Full research-resource proposal and its deposited allocation items. */
export type ResearchResourceDetail = ResearchResource & { items: ResearchResourceItem[] };
