/**
 * @fileoverview Raw ORCID Public API v3.0 payload fixtures and the strict fetch-mock
 * route table built from them. Faking the upstream at the `fetch` boundary keeps the
 * real service, normalizers, and handlers in the execution path — only the network is
 * replaced. Shared by the smoke lane (`tests/smoke/`) and the tool-contract integration
 * lane so both exercise one upstream definition.
 * @module tests/integration/orcid-api-fixtures
 */

import { config } from '@cyanheads/mcp-ts-core/config';
import type { FetchMockHarness, FetchMockRoute } from '@cyanheads/mcp-ts-core/testing';
import { createFetchMock, createInMemoryStorage } from '@cyanheads/mcp-ts-core/testing';
import { getServerConfig } from '@/config/server-config.js';
import { initOrcidService } from '@/services/orcid/orcid-service.js';

/** ORCID iD with a fully populated public record — every section route resolves. */
export const RESEARCHER_ID = '0000-0002-1825-0097';

/** ORCID iD that upstream does not know: every section 404s (research-resources 200s empty). */
export const MISSING_ID = '0000-0001-2345-6789';

/** ORCID iD whose bulk-works route fails with a non-404, non-transient upstream error. */
export const BULK_FAILURE_ID = '0000-0002-9999-111X';

/** Marker interpolated into a Solr clause to select the malformed-query route. */
export const BROKEN_QUERY_MARKER = 'Brokenquery';

/** Put-codes served by the bulk-works fixture: one resolves, one comes back as an error entry. */
export const RESOLVED_PUT_CODE = 501;
export const UNRESOLVED_PUT_CODE = 999_999_999;

/** ORCID API base URL the service actually calls, read from the same config it reads. */
const BASE = getServerConfig().orcidApiBaseUrl.replace(/\/$/, '');

const EXPANDED_SEARCH = {
  'expanded-result': [
    {
      'orcid-id': RESEARCHER_ID,
      'given-names': 'Jennifer',
      'family-names': 'Doudna',
      'credit-name': 'Jennifer A. Doudna',
      'other-name': ['J. A. Doudna'],
      email: [],
      'institution-name': ['University of California, Berkeley'],
    },
    {
      'orcid-id': '0000-0001-7777-2226',
      'given-names': 'Jennifer',
      'family-names': 'Smith',
      'other-name': [],
      email: [],
      'institution-name': ['Broad Institute'],
    },
  ],
  'num-found': 2,
};

const PERSON = {
  name: {
    'given-names': { value: 'Jennifer' },
    'family-name': { value: 'Doudna' },
    'credit-name': { value: 'Jennifer A. Doudna' },
  },
  biography: { content: 'Biochemist working on CRISPR-Cas9 genome editing.' },
  keywords: { keyword: [{ content: 'CRISPR' }, { content: 'RNA biology' }] },
  'researcher-urls': {
    'researcher-url': [{ 'url-name': 'Doudna Lab', url: { value: 'https://doudnalab.org' } }],
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
  emails: { email: [{ email: 'doudna@example.edu', primary: true }] },
  addresses: { address: [{ country: { value: 'US' } }] },
};

const WORKS = {
  group: [
    {
      'work-summary': [
        {
          'put-code': RESOLVED_PUT_CODE,
          title: { title: { value: 'A Programmable Dual-RNA-Guided DNA Endonuclease' } },
          type: 'journal-article',
          'publication-date': {
            year: { value: '2012' },
            month: { value: '8' },
            day: { value: '17' },
          },
          'journal-title': { value: 'Science' },
          url: { value: 'https://doi.org/10.1126/science.1225829' },
          'external-ids': {
            'external-id': [
              {
                'external-id-type': 'doi',
                'external-id-value': '10.1126/science.1225829',
                'external-id-url': { value: 'https://doi.org/10.1126/science.1225829' },
                'external-id-relationship': 'self',
              },
              { 'external-id-type': 'pmid', 'external-id-value': '22745249' },
            ],
          },
        },
      ],
    },
    {
      // Sparse upstream record: no dates, journal, URL, or external identifiers.
      'work-summary': [
        {
          'put-code': 502,
          title: { title: { value: 'Untyped dataset deposit' } },
        },
      ],
    },
  ],
};

const ACTIVITIES = {
  employments: {
    'affiliation-group': [
      {
        summaries: [
          {
            'employment-summary': {
              organization: {
                name: 'University of California, Berkeley',
                address: { city: 'Berkeley', country: 'US' },
                'disambiguated-organization': {
                  'disambiguated-organization-identifier': 'https://ror.org/01an7q238',
                  'disambiguation-source': 'ROR',
                },
              },
              'department-name': 'Molecular and Cell Biology',
              'role-title': 'Professor',
              'start-date': { year: { value: '2002' } },
              url: { value: 'https://mcb.berkeley.edu' },
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
            // Sparse upstream record: organization name only, no dates or role.
            'education-summary': { organization: { name: 'Harvard Medical School' } },
          },
        ],
      },
    ],
  },
};

const FUNDINGS = {
  group: [
    {
      'funding-summary': [
        {
          title: { title: { value: 'Genome Editing Program' } },
          type: 'grant',
          organization: {
            name: 'National Institutes of Health',
            address: { city: 'Bethesda', country: 'US' },
            'disambiguated-organization': {
              'disambiguated-organization-identifier': 'http://dx.doi.org/10.13039/100000002',
              'disambiguation-source': 'FUNDREF',
            },
          },
          'start-date': { year: { value: '2015' } },
          'end-date': { year: { value: '2020' } },
          url: { value: 'https://reporter.nih.gov/project/R01GM000000' },
          'external-ids': {
            'external-id': [
              { 'external-id-type': 'grant_number', 'external-id-value': 'R01GM000000' },
            ],
          },
        },
      ],
    },
  ],
};

const PEER_REVIEWS = {
  group: [
    {
      'external-ids': { 'external-id': [{ 'external-id-value': 'issn:1476-4687' }] },
      'peer-review-group': [
        {
          'peer-review-summary': [
            {
              'reviewer-role': 'reviewer',
              'review-type': 'review',
              'completion-date': { year: { value: '2021' }, month: { value: '3' } },
              'convening-organization': {
                name: 'Nature',
                address: { city: 'London', country: 'GB' },
                'disambiguated-organization': {
                  'disambiguated-organization-identifier': 'https://ror.org/00hx57361',
                  'disambiguation-source': 'ROR',
                },
              },
              'review-url': { value: 'https://publons.com/review/000000' },
            },
          ],
        },
      ],
    },
  ],
};

const RESEARCH_RESOURCES = {
  group: [
    {
      'research-resource-summary': [
        {
          'put-code': 7001,
          proposal: {
            title: { title: { value: 'ACCESS compute allocation' } },
            hosts: {
              organization: [
                {
                  name: 'Pittsburgh Supercomputing Center',
                  address: { city: 'Pittsburgh', country: 'US' },
                },
              ],
            },
            'external-ids': {
              'external-id': [
                {
                  'external-id-type': 'uri',
                  'external-id-value': 'https://access-ci.org/allocation/000000',
                },
              ],
            },
            'start-date': { year: { value: '2023' }, month: { value: '1' } },
            'end-date': { year: { value: '2024' } },
            url: { value: 'https://access-ci.org/allocation/000000' },
          },
        },
      ],
    },
  ],
};

const BULK_WORKS = {
  bulk: [
    {
      work: {
        'put-code': RESOLVED_PUT_CODE,
        title: {
          title: { value: 'A Programmable Dual-RNA-Guided DNA Endonuclease' },
          subtitle: { value: 'Adaptive Bacterial Immunity' },
        },
        type: 'journal-article',
        'publication-date': { year: { value: '2012' }, month: { value: '8' } },
        'journal-title': { value: 'Science' },
        'short-description': 'Describes RNA-programmable Cas9 cleavage of double-stranded DNA.',
        citation: { 'citation-type': 'bibtex', 'citation-value': '@article{jinek2012}' },
        url: { value: 'https://doi.org/10.1126/science.1225829' },
        'external-ids': {
          'external-id': [
            {
              'external-id-type': 'doi',
              'external-id-value': '10.1126/science.1225829',
              'external-id-relationship': 'self',
            },
          ],
        },
        contributors: {
          contributor: [
            {
              'credit-name': { value: 'Martin Jinek' },
              'contributor-attributes': {
                'contributor-role': 'author',
                'contributor-sequence': 'first',
              },
            },
            {
              'credit-name': { value: 'Jennifer A. Doudna' },
              'contributor-orcid': { path: RESEARCHER_ID },
              'contributor-attributes': { 'contributor-role': 'author' },
            },
          ],
        },
        'language-code': 'en',
      },
    },
    {
      error: {
        'response-code': 404,
        'error-code': 9016,
        'developer-message': `'${UNRESOLVED_PUT_CODE}' is not a valid put code`,
      },
    },
  ],
};

const notFound = () => new Response('Not Found', { status: 404, statusText: 'Not Found' });
const badRequest = () => new Response('Bad Request', { status: 400, statusText: 'Bad Request' });

const isBulkWorksUrl = (url: string, orcidId: string) =>
  url.startsWith(`${BASE}/${orcidId}/works/`);

/**
 * The full upstream route table. Order matters: the malformed-query and bulk-works
 * routes are registered ahead of the broader search and section routes they overlap.
 */
function orcidApiRoutes(): FetchMockRoute[] {
  return [
    {
      method: 'GET',
      match: (request) =>
        request.url.includes('/expanded-search/') && request.url.includes(BROKEN_QUERY_MARKER),
      respond: badRequest,
    },
    {
      method: 'GET',
      match: (request) => request.url.includes('/expanded-search/'),
      respond: () => Response.json(EXPANDED_SEARCH),
    },
    {
      method: 'GET',
      match: (request) => isBulkWorksUrl(request.url, RESEARCHER_ID),
      respond: () => Response.json(BULK_WORKS),
    },
    {
      method: 'GET',
      match: (request) => isBulkWorksUrl(request.url, MISSING_ID),
      respond: notFound,
    },
    {
      method: 'GET',
      match: (request) => isBulkWorksUrl(request.url, BULK_FAILURE_ID),
      respond: badRequest,
    },
    {
      method: 'GET',
      match: `${BASE}/${RESEARCHER_ID}/person`,
      respond: () => Response.json(PERSON),
    },
    { method: 'GET', match: `${BASE}/${RESEARCHER_ID}/works`, respond: () => Response.json(WORKS) },
    {
      method: 'GET',
      match: `${BASE}/${RESEARCHER_ID}/activities`,
      respond: () => Response.json(ACTIVITIES),
    },
    {
      method: 'GET',
      match: `${BASE}/${RESEARCHER_ID}/fundings`,
      respond: () => Response.json(FUNDINGS),
    },
    {
      method: 'GET',
      match: `${BASE}/${RESEARCHER_ID}/peer-reviews`,
      respond: () => Response.json(PEER_REVIEWS),
    },
    {
      method: 'GET',
      match: `${BASE}/${RESEARCHER_ID}/research-resources`,
      respond: () => Response.json(RESEARCH_RESOURCES),
    },
    // The /research-resources endpoint answers 200 with an empty group for an iD that does
    // not exist; the handler disambiguates by falling through to /person, which 404s.
    {
      method: 'GET',
      match: `${BASE}/${MISSING_ID}/research-resources`,
      respond: () => Response.json({ group: [] }),
    },
    { method: 'GET', match: `${BASE}/${MISSING_ID}/person`, respond: notFound },
    { method: 'GET', match: `${BASE}/${MISSING_ID}/works`, respond: notFound },
    { method: 'GET', match: `${BASE}/${MISSING_ID}/activities`, respond: notFound },
    { method: 'GET', match: `${BASE}/${MISSING_ID}/fundings`, respond: notFound },
    { method: 'GET', match: `${BASE}/${MISSING_ID}/peer-reviews`, respond: notFound },
  ];
}

/** Build the ORCID fetch harness. Unmatched requests throw, so real network access is loud. */
export function createOrcidFetchMock(): FetchMockHarness {
  return createFetchMock(orcidApiRoutes());
}

/** Point the module-level service singleton at real in-memory storage. */
export function initOrcidServiceForTests(): void {
  initOrcidService(config, createInMemoryStorage());
}
