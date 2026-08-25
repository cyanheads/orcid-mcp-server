/**
 * @fileoverview Tests for ORCID normalizer functions. Pure unit tests — no external calls.
 * @module tests/services/orcid/normalizers.test
 */

import { assert, describe, expect, it } from 'vitest';
import {
  normalizeActivities,
  normalizeBulkWorks,
  normalizeExpandedSearch,
  normalizeFundings,
  normalizePeerReviews,
  normalizePerson,
  normalizeWorks,
} from '@/services/orcid/normalizers.js';
import type {
  RawActivities,
  RawBulkWorksResponse,
  RawExpandedSearchResponse,
  RawFundingsResponse,
  RawPeerReviewsResponse,
  RawPerson,
  RawWorksResponse,
} from '@/services/orcid/types.js';

// ---------------------------------------------------------------------------
// normalizePerson
// ---------------------------------------------------------------------------

describe('normalizePerson', () => {
  it('extracts all fields from a full person record', () => {
    const raw: RawPerson = {
      name: {
        'given-names': { value: 'Jennifer' },
        'family-name': { value: 'Doudna' },
        'credit-name': { value: 'Jennifer A. Doudna' },
      },
      biography: { content: 'Biochemist at UC Berkeley.' },
      keywords: { keyword: [{ content: 'CRISPR' }, { content: 'RNA biology' }] },
      'researcher-urls': {
        'researcher-url': [{ 'url-name': 'Lab', url: { value: 'https://doudnalab.org' } }],
      },
      'external-identifiers': {
        'external-identifier': [
          {
            'external-id-type': 'Scopus Author ID',
            'external-id-value': '6603342255',
            'external-id-url': {
              value: 'https://www.scopus.com/authid/detail.uri?authorId=6603342255',
            },
            'external-id-relationship': 'self',
          },
        ],
      },
      emails: {
        email: [{ email: 'jdoudna@berkeley.edu', primary: true, verified: true }],
      },
      addresses: {
        address: [{ country: { value: 'US' }, primary: true }],
      },
    };

    const result = normalizePerson(raw);

    expect(result.givenNames).toBe('Jennifer');
    expect(result.familyName).toBe('Doudna');
    expect(result.creditName).toBe('Jennifer A. Doudna');
    expect(result.biography).toBe('Biochemist at UC Berkeley.');
    expect(result.keywords).toEqual(['CRISPR', 'RNA biology']);
    expect(result.researcherUrls).toEqual([{ name: 'Lab', url: 'https://doudnalab.org' }]);
    expect(result.externalIdentifiers).toHaveLength(1);
    const [scopusId] = result.externalIdentifiers;
    assert(scopusId);
    expect(scopusId.type).toBe('Scopus Author ID');
    expect(scopusId.value).toBe('6603342255');
    expect(scopusId.relationship).toBe('self');
    expect(result.emails).toEqual([{ email: 'jdoudna@berkeley.edu', primary: true }]);
    expect(result.countries).toEqual(['US']);
  });

  it('returns safe defaults for a sparse record (all fields missing)', () => {
    const result = normalizePerson({});

    expect(result.givenNames).toBeUndefined();
    expect(result.familyName).toBeUndefined();
    expect(result.creditName).toBeUndefined();
    expect(result.biography).toBeUndefined();
    expect(result.keywords).toEqual([]);
    expect(result.researcherUrls).toEqual([]);
    expect(result.externalIdentifiers).toEqual([]);
    expect(result.emails).toEqual([]);
    expect(result.countries).toEqual([]);
  });

  it('omits researcher URLs that have no url value', () => {
    const raw: RawPerson = {
      'researcher-urls': {
        'researcher-url': [
          { 'url-name': 'No URL here' },
          { url: { value: 'https://example.com' } },
        ],
      },
    };
    const result = normalizePerson(raw);
    expect(result.researcherUrls).toHaveLength(1);
    const [researcherUrl] = result.researcherUrls;
    assert(researcherUrl);
    expect(researcherUrl.url).toBe('https://example.com');
    expect(researcherUrl.name).toBeUndefined();
  });

  it('trims whitespace-only biography to undefined', () => {
    const raw: RawPerson = { biography: { content: '   ' } };
    const result = normalizePerson(raw);
    expect(result.biography).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeWorks
// ---------------------------------------------------------------------------

describe('normalizeWorks', () => {
  // Key names and nesting mirror a captured GET /v3.0/0000-0001-9161-999X/works
  // work-summary: the type is a bare `type`, and unset siblings arrive as null.
  it('extracts the preferred (first) summary per work group', () => {
    const raw: RawWorksResponse = {
      group: [
        {
          'work-summary': [
            {
              'put-code': 220823089,
              title: {
                title: {
                  value: 'Structure and evolution-guided design of minimal RNA-guided nucleases',
                },
                subtitle: null,
                'translated-title': null,
              },
              type: 'journal-article',
              'publication-date': {
                year: { value: '2026' },
                month: { value: '07' },
                day: { value: '16' },
              },
              'journal-title': { value: 'Science' },
              url: { value: 'https://www.science.org/doi/10.1126/science.aed6123' },
              'external-ids': {
                'external-id': [
                  {
                    'external-id-type': 'doi',
                    'external-id-value': '10.1126/science.aed6123',
                    'external-id-url': { value: 'https://doi.org/10.1126/science.aed6123' },
                    'external-id-relationship': 'self',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const works = normalizeWorks(raw);

    expect(works).toHaveLength(1);
    const [work] = works;
    assert(work);
    expect(work.putCode).toBe(220823089);
    expect(work.title).toBe(
      'Structure and evolution-guided design of minimal RNA-guided nucleases',
    );
    expect(work.workType).toBe('journal-article');
    expect(work.publicationDate).toBe('2026-07-16');
    expect(work.journalTitle).toBe('Science');
    expect(work.url).toBe('https://www.science.org/doi/10.1126/science.aed6123');
    expect(work.externalIds).toHaveLength(1);
    const [doi] = work.externalIds;
    assert(doi);
    expect(doi.type).toBe('doi');
    expect(doi.value).toBe('10.1126/science.aed6123');
  });

  it('reads workType from the bare `type` key ORCID emits, not `work-type`', () => {
    const raw = {
      group: [
        {
          'work-summary': [{ type: 'dataset', 'work-type': 'journal-article', 'external-ids': {} }],
        },
      ],
    } as unknown as RawWorksResponse;

    // The legacy `work-type` key is decoy data: no live payload carries it, and reading
    // it would silently mistype every work summary.
    const [work] = normalizeWorks(raw);
    assert(work);
    expect(work.workType).toBe('dataset');
  });

  it('omits workType when the summary carries no type', () => {
    const raw: RawWorksResponse = {
      group: [{ 'work-summary': [{ title: { title: { value: 'Untyped' } }, 'external-ids': {} }] }],
    };
    const [work] = normalizeWorks(raw);
    assert(work);
    expect(work.workType).toBeUndefined();
  });

  it('returns empty array for empty group list', () => {
    expect(normalizeWorks({})).toEqual([]);
    expect(normalizeWorks({ group: [] })).toEqual([]);
  });

  it('skips groups with no work-summary', () => {
    const raw: RawWorksResponse = { group: [{ 'work-summary': [] }] };
    expect(normalizeWorks(raw)).toEqual([]);
  });

  it('normalizes year-only publication date', () => {
    const raw: RawWorksResponse = {
      group: [
        {
          'work-summary': [{ 'publication-date': { year: { value: '2020' } }, 'external-ids': {} }],
        },
      ],
    };
    const [work] = normalizeWorks(raw);
    assert(work);
    expect(work.publicationDate).toBe('2020');
  });

  it('omits external ids with missing type or value', () => {
    const raw: RawWorksResponse = {
      group: [
        {
          'work-summary': [
            {
              'external-ids': {
                'external-id': [
                  { 'external-id-type': 'doi' }, // missing value
                  { 'external-id-value': '123' }, // missing type
                  { 'external-id-type': 'pmid', 'external-id-value': '12345678' },
                ],
              },
            },
          ],
        },
      ],
    };
    const [work] = normalizeWorks(raw);
    assert(work);
    expect(work.externalIds).toHaveLength(1);
    const [pmid] = work.externalIds;
    assert(pmid);
    expect(pmid.type).toBe('pmid');
  });
});

// ---------------------------------------------------------------------------
// normalizeActivities
// ---------------------------------------------------------------------------

describe('normalizeActivities', () => {
  // Shape mirrors a captured GET /v3.0/0000-0002-7635-3473/activities: every
  // `summaries[]` entry is a single-key object wrapping the summary under its
  // singular-type key, and unset fields arrive as explicit null.
  const raw: RawActivities = {
    employments: {
      'affiliation-group': [
        {
          summaries: [
            {
              'employment-summary': {
                'put-code': 1310507,
                'department-name': 'Faculty of Biology',
                'role-title': 'Professor, Chair of Genetics & Genomics of Plants',
                'start-date': {
                  year: { value: '2003' },
                  month: { value: '02' },
                  day: { value: '01' },
                },
                'end-date': null,
                organization: {
                  name: 'Universität Bielefeld',
                  address: { city: 'Bielefeld', region: 'Nordrhein-Westfalen', country: 'DE' },
                  'disambiguated-organization': {
                    'disambiguated-organization-identifier': '235712',
                    'disambiguation-source': 'RINGGOLD',
                  },
                },
                url: { value: 'https://www.uni-bielefeld.de/biologie/ggp/' },
              },
            },
          ],
        },
      ],
    },
    educations: {
      'affiliation-group': [
        {
          summaries: [
            {
              'education-summary': {
                'put-code': 1309856,
                'department-name': 'Botany Department',
                'role-title': 'Visiting scientist / postdoc',
                'start-date': {
                  year: { value: '1994' },
                  month: { value: '01' },
                  day: { value: '01' },
                },
                'end-date': {
                  year: { value: '1994' },
                  month: { value: '12' },
                  day: { value: '31' },
                },
                organization: {
                  name: 'University of Glasgow',
                  address: { city: 'Glasgow', region: 'Glasgow', country: 'GB' },
                  'disambiguated-organization': {
                    'disambiguated-organization-identifier': '3526',
                    'disambiguation-source': 'RINGGOLD',
                  },
                },
                url: null,
              },
            },
          ],
        },
      ],
    },
  };

  it('unwraps the singular-type key and returns employment fields', () => {
    const result = normalizeActivities(raw, ['employment']);
    expect(result).toHaveLength(1);
    const [employment] = result;
    assert(employment);
    expect(employment.type).toBe('employment');
    expect(employment.role).toBe('Professor, Chair of Genetics & Genomics of Plants');
    expect(employment.department).toBe('Faculty of Biology');
    expect(employment.organization?.name).toBe('Universität Bielefeld');
    expect(employment.organization?.city).toBe('Bielefeld');
    expect(employment.organization?.country).toBe('DE');
    expect(employment.organization?.disambiguatedId).toBe('235712');
    expect(employment.organization?.disambiguationSource).toBe('RINGGOLD');
    expect(employment.startDate).toBe('2003-02-01');
    expect(employment.endDate).toBeUndefined();
    expect(employment.url).toBe('https://www.uni-bielefeld.de/biologie/ggp/');
  });

  it('returns all types when "all" is requested', () => {
    const result = normalizeActivities(raw, ['all']);
    const types = result.map((a) => a.type);
    expect(types).toContain('employment');
    expect(types).toContain('education');
  });

  it('returns only requested types', () => {
    const result = normalizeActivities(raw, ['education']);
    expect(result).toHaveLength(1);
    const [education] = result;
    assert(education);
    expect(education.type).toBe('education');
    expect(education.organization?.name).toBe('University of Glasgow');
    expect(education.endDate).toBe('1994-12-31');
  });

  it('returns empty array when activities section is empty', () => {
    const result = normalizeActivities({}, ['employment', 'education']);
    expect(result).toEqual([]);
  });

  it('unwraps every section under its own singular key', () => {
    // The section names are plural-ish while the wrapper keys are singular, so this
    // mapping cannot be derived by trimming an `s` — each pairing is asserted.
    const sections: Array<[keyof RawActivities, string, string]> = [
      ['employments', 'employment-summary', 'employment'],
      ['educations', 'education-summary', 'education'],
      ['invited-positions', 'invited-position-summary', 'invited-positions'],
      ['distinctions', 'distinction-summary', 'distinctions'],
      ['memberships', 'membership-summary', 'memberships'],
      ['qualifications', 'qualification-summary', 'qualifications'],
      ['services', 'service-summary', 'services'],
    ];

    for (const [section, wrapperKey, requestedType] of sections) {
      const payload = {
        [section]: {
          'affiliation-group': [
            { summaries: [{ [wrapperKey]: { 'role-title': `role-${requestedType}` } }] },
          ],
        },
      } as RawActivities;

      const result = normalizeActivities(payload, [requestedType as 'employment']);
      expect(result).toHaveLength(1);
      const [affiliation] = result;
      assert(affiliation);
      expect(affiliation.type).toBe(requestedType);
      expect(affiliation.role).toBe(`role-${requestedType}`);
    }
  });

  it('skips a summaries entry wrapped under a different key', () => {
    const payload = {
      employments: {
        'affiliation-group': [
          { summaries: [{ 'education-summary': { 'role-title': 'Wrong section' } }] },
        ],
      },
    } as RawActivities;

    // A mis-keyed entry yields nothing rather than a stub carrying only `type`.
    expect(normalizeActivities(payload, ['employment'])).toEqual([]);
  });

  it('preserves absence for a summary with no dates or department', () => {
    // Captured from a live qualification record — ORCID sends explicit nulls.
    const payload: RawActivities = {
      qualifications: {
        'affiliation-group': [
          {
            summaries: [
              {
                'qualification-summary': {
                  'department-name': null,
                  'role-title': null,
                  'start-date': null,
                  'end-date': null,
                  organization: {
                    name: 'University of Oxford ',
                    address: { city: 'Oxford', region: null, country: 'GB' },
                    'disambiguated-organization': null,
                  },
                },
              },
            ],
          },
        ],
      },
    };

    const result = normalizeActivities(payload, ['qualifications']);
    expect(result).toHaveLength(1);
    const [qualification] = result;
    assert(qualification);
    expect(qualification.organization?.name).toBe('University of Oxford ');
    expect(qualification.organization?.country).toBe('GB');
    expect(qualification.organization?.disambiguatedId).toBeUndefined();
    expect(qualification.department).toBeUndefined();
    expect(qualification.role).toBeUndefined();
    expect(qualification.startDate).toBeUndefined();
    expect(qualification.endDate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeFundings
// ---------------------------------------------------------------------------

describe('normalizeFundings', () => {
  it('extracts funding records with grant numbers', () => {
    const raw: RawFundingsResponse = {
      group: [
        {
          'funding-summary': [
            {
              title: { title: { value: 'CRISPR Development Grant' } },
              type: 'grant',
              organization: {
                name: 'NIH',
                address: { country: 'US' },
                'disambiguated-organization': {
                  'disambiguated-organization-identifier': 'https://doi.org/10.13039/100000002',
                  'disambiguation-source': 'FUNDREF',
                },
              },
              'start-date': { year: { value: '2015' } },
              'end-date': { year: { value: '2020' } },
              'external-ids': {
                'external-id': [
                  { 'external-id-type': 'grant_number', 'external-id-value': 'R01GM123456' },
                ],
              },
              url: { value: 'https://grantome.com/grant/NIH/R01-GM123456' },
            },
          ],
        },
      ],
    };

    const records = normalizeFundings(raw);

    expect(records).toHaveLength(1);
    const [record] = records;
    assert(record);
    expect(record.title).toBe('CRISPR Development Grant');
    expect(record.type).toBe('grant');
    expect(record.funder?.name).toBe('NIH');
    expect(record.funder?.country).toBe('US');
    expect(record.funder?.disambiguatedId).toBe('https://doi.org/10.13039/100000002');
    expect(record.funder?.disambiguationSource).toBe('FUNDREF');
    expect(record.grantNumbers).toEqual(['R01GM123456']);
    expect(record.startDate).toBe('2015');
    expect(record.endDate).toBe('2020');
    expect(record.url).toBe('https://grantome.com/grant/NIH/R01-GM123456');
  });

  it('returns empty grantNumbers when no grant_number external ids', () => {
    const raw: RawFundingsResponse = {
      group: [
        {
          'funding-summary': [
            {
              title: { title: { value: 'Award' } },
              'external-ids': {
                'external-id': [{ 'external-id-type': 'doi', 'external-id-value': '10.1/abc' }],
              },
            },
          ],
        },
      ],
    };

    const [record] = normalizeFundings(raw);
    assert(record);
    expect(record.grantNumbers).toEqual([]);
  });

  it('returns empty array for empty funding response', () => {
    expect(normalizeFundings({})).toEqual([]);
    expect(normalizeFundings({ group: [] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizePeerReviews
// ---------------------------------------------------------------------------

describe('normalizePeerReviews', () => {
  // Shape mirrors a captured GET /v3.0/0000-0002-7635-3473/peer-reviews: the group
  // identifier is typed `peer-review` and carries the ISSN inside the value.
  it('strips the issn: prefix off the peer-review-typed group identifier', () => {
    const raw: RawPeerReviewsResponse = {
      group: [
        {
          'external-ids': {
            'external-id': [
              {
                'external-id-type': 'peer-review',
                'external-id-value': 'issn:1476-4687',
              },
            ],
          },
          'peer-review-group': [
            {
              'peer-review-summary': [
                {
                  'put-code': 8060938,
                  'reviewer-role': 'reviewer',
                  'review-type': 'review',
                  'completion-date': { year: { value: '2023' }, month: null, day: null },
                  'convening-organization': {
                    name: 'SpringerNature',
                    address: { city: 'London', region: 'England', country: 'GB' },
                    'disambiguated-organization': {
                      'disambiguated-organization-identifier': 'grid.497262.c',
                      'disambiguation-source': 'GRID',
                    },
                  },
                  'review-url': null,
                },
              ],
            },
          ],
        },
      ],
    };

    const reviews = normalizePeerReviews(raw);

    expect(reviews).toHaveLength(1);
    const [review] = reviews;
    assert(review);
    expect(review.reviewerRole).toBe('reviewer');
    expect(review.reviewType).toBe('review');
    expect(review.completionDate).toBe('2023');
    expect(review.conveningOrganization?.name).toBe('SpringerNature');
    expect(review.conveningOrganization?.country).toBe('GB');
    expect(review.reviewUrl).toBeUndefined();
    expect(review.groupIssn).toBe('1476-4687');
  });

  it('leaves groupIssn absent for a non-ISSN group identifier', () => {
    // Captured from 0000-0001-5531-9244: ORCID also issues `orcid-generated:` group
    // keys, which are not ISSNs and must not be reported as one.
    const raw: RawPeerReviewsResponse = {
      group: [
        {
          'external-ids': {
            'external-id': [
              {
                'external-id-type': 'peer-review',
                'external-id-value': 'orcid-generated:F1000Prime-Recommendations',
              },
            ],
          },
          'peer-review-group': [
            {
              'peer-review-summary': [
                {
                  'reviewer-role': 'reviewer',
                  'review-type': 'evaluation',
                  'convening-organization': { name: 'F1000' },
                },
              ],
            },
          ],
        },
      ],
    };

    const reviews = normalizePeerReviews(raw);
    expect(reviews).toHaveLength(1);
    const [review] = reviews;
    assert(review);
    expect(review.conveningOrganization?.name).toBe('F1000');
    expect(review.groupIssn).toBeUndefined();
  });

  it('returns empty array for sparse peer reviews response', () => {
    expect(normalizePeerReviews({})).toEqual([]);
    expect(normalizePeerReviews({ group: [] })).toEqual([]);
  });

  it('omits groupIssn when the group carries no external ids', () => {
    const raw: RawPeerReviewsResponse = {
      group: [
        {
          'external-ids': { 'external-id': [] },
          'peer-review-group': [{ 'peer-review-summary': [{ 'reviewer-role': 'editor' }] }],
        },
      ],
    };
    const [review] = normalizePeerReviews(raw);
    assert(review);
    expect(review.groupIssn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeExpandedSearch
// ---------------------------------------------------------------------------

describe('normalizeExpandedSearch', () => {
  it('normalizes a full search response', () => {
    const raw: RawExpandedSearchResponse = {
      'num-found': 3,
      'expanded-result': [
        {
          'orcid-id': '0000-0001-9522-8779',
          'given-names': 'Jennifer',
          'family-names': 'Doudna',
          'credit-name': 'Jennifer A. Doudna',
          'other-name': ['J. Doudna'],
          email: ['jdoudna@example.edu'],
          'institution-name': ['UC Berkeley', 'Innovative Genomics Institute'],
        },
      ],
    };

    const result = normalizeExpandedSearch(raw);

    expect(result.numFound).toBe(3);
    expect(result.results).toHaveLength(1);
    const [r] = result.results;
    assert(r);
    expect(r.orcidId).toBe('0000-0001-9522-8779');
    expect(r.givenNames).toBe('Jennifer');
    expect(r.familyNames).toBe('Doudna');
    expect(r.creditName).toBe('Jennifer A. Doudna');
    expect(r.otherNames).toEqual(['J. Doudna']);
    expect(r.emails).toEqual(['jdoudna@example.edu']);
    expect(r.institutionNames).toEqual(['UC Berkeley', 'Innovative Genomics Institute']);
  });

  it('skips results with no orcid-id', () => {
    const raw: RawExpandedSearchResponse = {
      'num-found': 1,
      'expanded-result': [
        { 'given-names': 'Anonymous' }, // no orcid-id
        { 'orcid-id': '0000-0002-1825-0097', 'given-names': 'Josiah' },
      ],
    };
    const result = normalizeExpandedSearch(raw);
    expect(result.results).toHaveLength(1);
    const [match] = result.results;
    assert(match);
    expect(match.orcidId).toBe('0000-0002-1825-0097');
  });

  it('defaults numFound to 0 and arrays to empty for minimal response', () => {
    const result = normalizeExpandedSearch({});
    expect(result.numFound).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('handles result with only orcid-id (all optional fields absent)', () => {
    const raw: RawExpandedSearchResponse = {
      'num-found': 1,
      'expanded-result': [{ 'orcid-id': '0000-0002-1825-0097' }],
    };
    const result = normalizeExpandedSearch(raw);
    const [r] = result.results;
    assert(r);
    expect(r.orcidId).toBe('0000-0002-1825-0097');
    expect(r.givenNames).toBeUndefined();
    expect(r.otherNames).toEqual([]);
    expect(r.emails).toEqual([]);
    expect(r.institutionNames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeBulkWorks
// ---------------------------------------------------------------------------

describe('normalizeBulkWorks', () => {
  it('extracts the failing put-code from developer-message when no put-code field is present', () => {
    // Mirrors the live bulk response: invalid put-codes against an existing profile
    // return HTTP 200 with per-entry errors that carry the failing code only inside the
    // validation text — never in a `put-code` field.
    const raw: RawBulkWorksResponse = {
      bulk: [
        {
          error: {
            'response-code': 400,
            'developer-message':
              "400 Bad Request: The put code provided is not valid. Full validation error: '999999999' is not a valid put code",
            'error-code': 9034,
          },
        },
        {
          error: {
            'response-code': 400,
            'developer-message':
              "400 Bad Request: The put code provided is not valid. Full validation error: '888888888' is not a valid put code",
            'error-code': 9034,
          },
        },
      ],
    };

    const results = normalizeBulkWorks(raw);

    expect(results).toHaveLength(2);
    const [first, second] = results;
    assert(second);
    expect(first).toEqual({
      type: 'error',
      putCode: 999999999,
      message:
        "400 Bad Request: The put code provided is not valid. Full validation error: '999999999' is not a valid put code",
    });
    expect(second.type).toBe('error');
    expect((second as { putCode?: number }).putCode).toBe(888888888);
  });

  it('leaves putCode absent when the message carries no extractable code', () => {
    const raw: RawBulkWorksResponse = {
      bulk: [
        {
          error: {
            'response-code': 403,
            'developer-message':
              '403 Forbidden: The work is not public and cannot be accessed with this token.',
            'error-code': 9017,
          },
        },
      ],
    };

    const results = normalizeBulkWorks(raw);

    expect(results).toHaveLength(1);
    const [entry] = results;
    assert(entry);
    expect(entry.type).toBe('error');
    expect((entry as { putCode?: number }).putCode).toBeUndefined();
    expect((entry as { message: string }).message).toContain('not public');
  });

  it('normalizes a mixed work + error bulk array, associating the code with its entry', () => {
    const raw: RawBulkWorksResponse = {
      bulk: [
        {
          work: {
            'put-code': 215949386,
            title: { title: { value: 'CRISPR-Cas9' } },
            type: 'journal-article',
          },
        },
        {
          error: {
            'response-code': 400,
            'developer-message':
              "400 Bad Request: The put code provided is not valid. Full validation error: '777777777' is not a valid put code",
            'error-code': 9034,
          },
        },
      ],
    };

    const results = normalizeBulkWorks(raw);

    expect(results).toHaveLength(2);
    const [workEntry, errorEntry] = results;
    assert(workEntry);
    assert(errorEntry);
    expect(workEntry.type).toBe('work');
    expect((workEntry as { detail: { putCode: number } }).detail.putCode).toBe(215949386);
    expect(errorEntry.type).toBe('error');
    expect((errorEntry as { putCode?: number }).putCode).toBe(777777777);
  });

  it('prefers an explicit upstream put-code field over message extraction', () => {
    // Forward-compat: if ORCID ever populates the field, it wins over the text fallback.
    const raw: RawBulkWorksResponse = {
      bulk: [
        {
          error: {
            'put-code': 123,
            'response-code': 400,
            'developer-message': "400 Bad Request: '999' is not a valid put code",
            'error-code': 9034,
          },
        },
      ],
    };

    const results = normalizeBulkWorks(raw);
    expect((results[0] as { putCode?: number }).putCode).toBe(123);
  });

  it('synthesizes a message and omits putCode when developer-message is absent', () => {
    const raw: RawBulkWorksResponse = {
      bulk: [{ error: { 'error-code': 9042 } }],
    };

    const [entry] = normalizeBulkWorks(raw);
    assert(entry);
    expect(entry.type).toBe('error');
    expect((entry as { message: string }).message).toContain('9042');
    expect((entry as { putCode?: number }).putCode).toBeUndefined();
  });

  it('returns an empty array for an empty bulk response', () => {
    expect(normalizeBulkWorks({})).toEqual([]);
    expect(normalizeBulkWorks({ bulk: [] })).toEqual([]);
  });
});
