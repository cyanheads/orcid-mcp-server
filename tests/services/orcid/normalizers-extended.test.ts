/**
 * @fileoverview Extended normalizer tests: normalizeDate with full date, normalizeOrg
 * edge cases, normalizeActivities multi-type and all-types, normalizePerson keyword
 * filtering, normalizeFundings URL, normalizePeerReviews with ROR org.
 * @module tests/services/orcid/normalizers-extended.test
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeActivities,
  normalizeExpandedSearch,
  normalizeFundings,
  normalizePeerReviews,
  normalizePerson,
  normalizeWorks,
} from '@/services/orcid/normalizers.js';
import type {
  RawActivities,
  RawFundingsResponse,
  RawPeerReviewsResponse,
  RawPerson,
  RawWorksResponse,
} from '@/services/orcid/types.js';

// ---------------------------------------------------------------------------
// normalizePerson edge cases
// ---------------------------------------------------------------------------

describe('normalizePerson — edge cases', () => {
  it('filters out empty-string keywords from keyword array', () => {
    const raw: RawPerson = {
      keywords: {
        keyword: [{ content: 'CRISPR' }, { content: '' }, { content: 'RNA' }],
      },
    };
    const result = normalizePerson(raw);
    // Empty-string keywords should be filtered out
    expect(result.keywords).toEqual(['CRISPR', 'RNA']);
  });

  it('handles missing keyword content field gracefully', () => {
    const raw: RawPerson = {
      keywords: {
        keyword: [{ content: 'Genomics' }, {}],
      },
    };
    const result = normalizePerson(raw);
    expect(result.keywords).toEqual(['Genomics']);
  });

  it('normalizes multiple external identifiers', () => {
    const raw: RawPerson = {
      'external-identifiers': {
        'external-identifier': [
          {
            'external-id-type': 'Scopus Author ID',
            'external-id-value': '123',
            'external-id-url': { value: 'https://scopus.com/123' },
            'external-id-relationship': 'self',
          },
          {
            'external-id-type': 'ResearcherID',
            'external-id-value': 'A-1234-2000',
          },
        ],
      },
    };
    const result = normalizePerson(raw);
    expect(result.externalIdentifiers).toHaveLength(2);
    expect(result.externalIdentifiers[0].type).toBe('Scopus Author ID');
    expect(result.externalIdentifiers[0].url).toBe('https://scopus.com/123');
    expect(result.externalIdentifiers[0].relationship).toBe('self');
    expect(result.externalIdentifiers[1].type).toBe('ResearcherID');
    expect(result.externalIdentifiers[1].url).toBeUndefined();
  });

  it('handles non-primary addresses (multiple countries)', () => {
    const raw: RawPerson = {
      addresses: {
        address: [
          { country: { value: 'US' }, primary: true },
          { country: { value: 'GB' }, primary: false },
        ],
      },
    };
    const result = normalizePerson(raw);
    expect(result.countries).toEqual(['US', 'GB']);
  });

  it('handles email without primary flag', () => {
    const raw: RawPerson = {
      emails: {
        email: [{ email: 'test@example.com' }],
      },
    };
    const result = normalizePerson(raw);
    expect(result.emails[0].email).toBe('test@example.com');
    expect(result.emails[0].primary).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeWorks — full date with day
// ---------------------------------------------------------------------------

describe('normalizeWorks — date normalization', () => {
  it('normalizes full date (year + month + day)', () => {
    const raw: RawWorksResponse = {
      group: [
        {
          'work-summary': [
            {
              'publication-date': {
                year: { value: '2012' },
                month: { value: '8' },
                day: { value: '17' },
              },
              'external-ids': {},
            },
          ],
        },
      ],
    };
    const works = normalizeWorks(raw);
    expect(works[0].publicationDate).toBe('2012-08-17');
  });

  it('normalizes year + month without day', () => {
    const raw: RawWorksResponse = {
      group: [
        {
          'work-summary': [
            {
              'publication-date': {
                year: { value: '2020' },
                month: { value: '3' },
              },
              'external-ids': {},
            },
          ],
        },
      ],
    };
    const works = normalizeWorks(raw);
    expect(works[0].publicationDate).toBe('2020-03');
  });

  it('preserves url field on work', () => {
    const raw: RawWorksResponse = {
      group: [
        {
          'work-summary': [
            {
              url: { value: 'https://doi.org/10.1/test' },
              'external-ids': {},
            },
          ],
        },
      ],
    };
    const works = normalizeWorks(raw);
    expect(works[0].url).toBe('https://doi.org/10.1/test');
  });

  it('handles work with external-id url field', () => {
    const raw: RawWorksResponse = {
      group: [
        {
          'work-summary': [
            {
              'external-ids': {
                'external-id': [
                  {
                    'external-id-type': 'doi',
                    'external-id-value': '10.1/test',
                    'external-id-url': { value: 'https://doi.org/10.1/test' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const works = normalizeWorks(raw);
    expect(works[0].externalIds[0].url).toBe('https://doi.org/10.1/test');
  });
});

// ---------------------------------------------------------------------------
// normalizeActivities — multiple types and edge cases
// ---------------------------------------------------------------------------

describe('normalizeActivities — multiple types', () => {
  const fullRaw: RawActivities = {
    employments: {
      'affiliation-group': [
        {
          summaries: [
            {
              'employment-summary': {
                'role-title': 'Professor',
                organization: { name: 'UC Berkeley' },
                'start-date': { year: { value: '2002' } },
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
                'role-title': 'PhD',
                organization: { name: 'Harvard University' },
                'start-date': { year: { value: '1985' } },
                'end-date': { year: { value: '1989' } },
              },
            },
          ],
        },
      ],
    },
    memberships: {
      'affiliation-group': [
        {
          summaries: [
            {
              'membership-summary': {
                'role-title': 'Research Scholar',
                organization: { name: 'Ronin Institute' },
              },
            },
          ],
        },
      ],
    },
  };

  it('returns employment + education when both types requested', () => {
    const result = normalizeActivities(fullRaw, ['employment', 'education']);
    expect(result).toHaveLength(2);
    const types = result.map((a) => a.type);
    expect(types).toContain('employment');
    expect(types).toContain('education');
  });

  it('returns memberships when memberships type requested', () => {
    const result = normalizeActivities(fullRaw, ['memberships']);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('memberships');
    expect(result[0].role).toBe('Research Scholar');
    expect(result[0].organization?.name).toBe('Ronin Institute');
  });

  it('returns all types when "all" is in types array', () => {
    const result = normalizeActivities(fullRaw, ['all']);
    const types = new Set(result.map((a) => a.type));
    expect(types.has('employment')).toBe(true);
    expect(types.has('education')).toBe(true);
    expect(types.has('memberships')).toBe(true);
  });

  it('returns empty array when requested type section is absent', () => {
    const result = normalizeActivities(fullRaw, ['distinctions']);
    expect(result).toEqual([]);
  });

  it('normalizes affiliation with URL field', () => {
    const raw: RawActivities = {
      employments: {
        'affiliation-group': [
          {
            summaries: [
              {
                'employment-summary': {
                  'role-title': 'Researcher',
                  organization: { name: 'Example Org' },
                  url: { value: 'https://example.org/researcher' },
                },
              },
            ],
          },
        ],
      },
    };
    const result = normalizeActivities(raw, ['employment']);
    expect(result[0].url).toBe('https://example.org/researcher');
  });

  it('normalizes affiliation with ROR disambiguated organization', () => {
    const raw: RawActivities = {
      services: {
        'affiliation-group': [
          {
            summaries: [
              {
                'service-summary': {
                  'role-title': 'Director',
                  organization: {
                    name: 'Phoenix Bioinformatics',
                    address: { city: 'Fremont', region: 'California', country: 'US' },
                    'disambiguated-organization': {
                      'disambiguated-organization-identifier': 'https://ror.org/0018yg518',
                      'disambiguation-source': 'ROR',
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    };
    const result = normalizeActivities(raw, ['services']);
    expect(result[0].organization?.disambiguatedId).toBe('https://ror.org/0018yg518');
    expect(result[0].organization?.disambiguationSource).toBe('ROR');
    expect(result[0].organization?.city).toBe('Fremont');
  });

  it('collects every summary across multiple groups in one section', () => {
    const raw: RawActivities = {
      distinctions: {
        'affiliation-group': [
          {
            summaries: [
              {
                'distinction-summary': {
                  'role-title': 'Medal of Honour',
                  organization: { name: 'Vietsch Foundation' },
                },
              },
            ],
          },
          {
            summaries: [
              { 'distinction-summary': { 'role-title': 'Fellow', organization: { name: 'AAAS' } } },
            ],
          },
        ],
      },
    };
    const result = normalizeActivities(raw, ['distinctions']);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.role)).toEqual(['Medal of Honour', 'Fellow']);
  });
});

// ---------------------------------------------------------------------------
// normalizeFundings — edge cases
// ---------------------------------------------------------------------------

describe('normalizeFundings — edge cases', () => {
  it('handles funding record with URL field', () => {
    const raw: RawFundingsResponse = {
      group: [
        {
          'funding-summary': [
            {
              title: { title: { value: 'Test Grant' } },
              'external-ids': {},
              url: { value: 'https://grantome.com/test' },
            },
          ],
        },
      ],
    };
    const records = normalizeFundings(raw);
    expect(records[0].url).toBe('https://grantome.com/test');
  });

  it('handles multiple funding groups with multiple summaries', () => {
    const raw: RawFundingsResponse = {
      group: [
        {
          'funding-summary': [
            { title: { title: { value: 'Grant A' } }, 'external-ids': {} },
            { title: { title: { value: 'Grant B' } }, 'external-ids': {} },
          ],
        },
        {
          'funding-summary': [{ title: { title: { value: 'Grant C' } }, 'external-ids': {} }],
        },
      ],
    };
    const records = normalizeFundings(raw);
    expect(records).toHaveLength(3);
  });

  it('handles funding with full date normalization', () => {
    const raw: RawFundingsResponse = {
      group: [
        {
          'funding-summary': [
            {
              'start-date': { year: { value: '2015' }, month: { value: '6' } },
              'end-date': { year: { value: '2020' }, month: { value: '12' } },
              'external-ids': {},
            },
          ],
        },
      ],
    };
    const records = normalizeFundings(raw);
    expect(records[0].startDate).toBe('2015-06');
    expect(records[0].endDate).toBe('2020-12');
  });

  it('returns empty grantNumbers when external-ids is empty', () => {
    const raw: RawFundingsResponse = {
      group: [
        {
          'funding-summary': [{ 'external-ids': { 'external-id': [] } }],
        },
      ],
    };
    const records = normalizeFundings(raw);
    expect(records[0].grantNumbers).toEqual([]);
  });

  it('skips groups with empty funding-summary', () => {
    const raw: RawFundingsResponse = {
      group: [{ 'funding-summary': [] }],
    };
    const records = normalizeFundings(raw);
    expect(records).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizePeerReviews — edge cases
// ---------------------------------------------------------------------------

describe('normalizePeerReviews — edge cases', () => {
  it('handles peer review with full date (year + month + day)', () => {
    const raw: RawPeerReviewsResponse = {
      group: [
        {
          'external-ids': { 'external-id': [] },
          'peer-review-group': [
            {
              'peer-review-summary': [
                {
                  'completion-date': {
                    year: { value: '2021' },
                    month: { value: '3' },
                    day: { value: '15' },
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const reviews = normalizePeerReviews(raw);
    expect(reviews[0].completionDate).toBe('2021-03-15');
  });

  it('handles peer review with disambiguated convening organization', () => {
    const raw: RawPeerReviewsResponse = {
      group: [
        {
          'external-ids': {
            'external-id': [
              { 'external-id-type': 'peer-review', 'external-id-value': 'issn:0036-8075' },
            ],
          },
          'peer-review-group': [
            {
              'peer-review-summary': [
                {
                  'reviewer-role': 'reviewer',
                  'convening-organization': {
                    name: 'Science',
                    address: { city: 'Washington', country: 'US' },
                    'disambiguated-organization': {
                      'disambiguated-organization-identifier': 'https://ror.org/00abcd',
                      'disambiguation-source': 'ROR',
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const reviews = normalizePeerReviews(raw);
    expect(reviews[0].conveningOrganization?.disambiguatedId).toBe('https://ror.org/00abcd');
    expect(reviews[0].conveningOrganization?.disambiguationSource).toBe('ROR');
    expect(reviews[0].groupIssn).toBe('0036-8075');
  });

  it('handles multiple peer review groups in a single group', () => {
    const raw: RawPeerReviewsResponse = {
      group: [
        {
          'external-ids': { 'external-id': [] },
          'peer-review-group': [
            {
              'peer-review-summary': [
                { 'reviewer-role': 'reviewer' },
                { 'reviewer-role': 'editor' },
              ],
            },
          ],
        },
      ],
    };
    const reviews = normalizePeerReviews(raw);
    expect(reviews).toHaveLength(2);
    expect(reviews[0].reviewerRole).toBe('reviewer');
    expect(reviews[1].reviewerRole).toBe('editor');
  });

  it('handles group with no peer-review-group key', () => {
    const raw: RawPeerReviewsResponse = {
      group: [
        {
          'external-ids': { 'external-id': [] },
          // no 'peer-review-group' key
        },
      ],
    };
    const reviews = normalizePeerReviews(raw);
    expect(reviews).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeExpandedSearch — unicode and encoding edge cases
// ---------------------------------------------------------------------------

describe('normalizeExpandedSearch — unicode and encoding', () => {
  it('preserves unicode in given names and family names', () => {
    const raw = {
      'num-found': 1,
      'expanded-result': [
        {
          'orcid-id': '0000-0001-9999-8888',
          'given-names': 'Björn',
          'family-names': 'Ångström',
        },
      ],
    };
    const result = normalizeExpandedSearch(raw);
    expect(result.results[0].givenNames).toBe('Björn');
    expect(result.results[0].familyNames).toBe('Ångström');
  });

  it('preserves unicode in institution names', () => {
    const raw = {
      'num-found': 1,
      'expanded-result': [
        {
          'orcid-id': '0000-0001-9999-8888',
          'institution-name': ['Université de Paris', 'École Polytechnique'],
        },
      ],
    };
    const result = normalizeExpandedSearch(raw);
    expect(result.results[0].institutionNames).toContain('Université de Paris');
    expect(result.results[0].institutionNames).toContain('École Polytechnique');
  });

  it('handles large numFound value', () => {
    const raw = {
      'num-found': 999999,
      'expanded-result': [],
    };
    const result = normalizeExpandedSearch(raw);
    expect(result.numFound).toBe(999999);
    expect(result.results).toEqual([]);
  });
});
