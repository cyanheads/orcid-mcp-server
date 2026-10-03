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

/**
 * ORCID iD whose bulk-works route answers 429 with a `Retry-After` longer than the retry
 * layer's backoff ceiling, so the rate limit surfaces on the first attempt.
 */
export const RATE_LIMITED_ID = '0000-0002-4290-429X';

/** ORCID iD whose works, funding, and research-resource text carries inline markup. */
export const MARKUP_ID = '0000-0003-6400-0002';

/** Marker interpolated into a Solr clause to select the malformed-query route. */
export const BROKEN_QUERY_MARKER = 'Brokenquery';

/** Put-codes served by the bulk-works fixture: one resolves, one comes back as an error entry. */
export const RESOLVED_PUT_CODE = 501;
export const UNRESOLVED_PUT_CODE = 999_999_999;

/**
 * ORCID iD whose bulk-works route serves one large-collaboration record: more contributors
 * than the work-detail cap, this iD among them past the cap, and an oversized citation.
 */
export const LARGE_COLLAB_ID = '0000-0002-5246-0100';
/** Put-code of the large-collaboration record. */
export const LARGE_COLLAB_PUT_CODE = 5_246;
/** Contributors on the large-collaboration record; the owner's entry is at index 150. */
export const LARGE_COLLAB_CONTRIBUTORS = 180;
/** The large-collaboration record's deposited BibTeX, over the 8,192-byte citation cap. */
export const LARGE_COLLAB_CITATION = `@article{atlas2012,\n\tauthor = {${'A'.repeat(9_000)}}\n}`;

/** ORCID API base URL the service actually calls, read from the same config it reads. */
const BASE = getServerConfig().orcidApiBaseUrl.replace(/\/$/, '');

/** A `source` block for a member system, optionally asserting on a researcher's behalf. */
const clientSource = (name: string, clientId: string, onBehalfOf?: string) => ({
  'source-orcid': null,
  'source-client-id': {
    uri: `https://orcid.org/client/${clientId}`,
    path: clientId,
    host: 'orcid.org',
  },
  'source-name': { value: name },
  'assertion-origin-orcid': onBehalfOf
    ? { uri: `https://orcid.org/${RESEARCHER_ID}`, path: RESEARCHER_ID, host: 'orcid.org' }
    : null,
  'assertion-origin-client-id': null,
  'assertion-origin-name': onBehalfOf ? { value: onBehalfOf } : null,
});

/** A `source` block for an item the researcher entered on orcid.org. */
const RESEARCHER_SOURCE = {
  'source-orcid': {
    uri: `https://orcid.org/${RESEARCHER_ID}`,
    path: RESEARCHER_ID,
    host: 'orcid.org',
  },
  'source-client-id': null,
  'source-name': { value: 'Jennifer Doudna' },
  'assertion-origin-orcid': null,
  'assertion-origin-client-id': null,
  'assertion-origin-name': null,
};

/** Crossref's client path is ORCID-format; it must never read as the researcher. */
const CROSSREF_SOURCE = clientSource('Crossref', '0000-0001-9884-1913');

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
  // ORCID lists other names by descending display-index, the order the record shows.
  'other-names': {
    'other-name': [
      { content: 'Josiah Stinkney Carberry', visibility: 'public', 'display-index': 3 },
      { content: 'J. Carberry', visibility: 'public', 'display-index': 2 },
      { content: 'J. S. Carberry', visibility: 'public', 'display-index': 1 },
    ],
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
      // The group-level list unions every source's self identifiers: it adds a PMCID only
      // another source holds, and a source-local ID that must not surface on the work.
      'external-ids': {
        'external-id': [
          {
            'external-id-type': 'doi',
            'external-id-value': '10.1126/science.1225829',
            'external-id-normalized': { value: '10.1126/science.1225829', transient: true },
            'external-id-url': { value: 'https://doi.org/10.1126/science.1225829' },
            'external-id-relationship': 'self',
          },
          {
            'external-id-type': 'pmid',
            'external-id-value': '22745249',
            'external-id-normalized': { value: '22745249', transient: true },
            'external-id-url': null,
            'external-id-relationship': 'self',
          },
          {
            'external-id-type': 'pmc',
            'external-id-value': 'PMC6286148',
            'external-id-normalized': { value: '6286148', transient: true },
            'external-id-url': null,
            'external-id-relationship': 'self',
          },
          {
            'external-id-type': 'source-work-id',
            'external-id-value': 'inst-000417',
            'external-id-normalized': { value: 'inst-000417', transient: true },
            'external-id-url': null,
            'external-id-relationship': 'self',
          },
        ],
      },
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
              {
                'external-id-type': 'pmid',
                'external-id-value': '22745249',
                'external-id-relationship': 'self',
              },
            ],
          },
          source: CROSSREF_SOURCE,
        },
        {
          // The same work linked by the researcher through a search-and-link tool: it holds
          // the PMCID the group-level list carries.
          'put-code': 503,
          title: { title: { value: 'A programmable dual-RNA-guided DNA endonuclease' } },
          type: 'journal-article',
          'external-ids': {
            'external-id': [
              {
                'external-id-type': 'pmc',
                'external-id-value': 'PMC6286148',
                'external-id-relationship': 'self',
              },
            ],
          },
          source: clientSource('Europe PubMed Central', '0000-0002-9157-3431', 'Jennifer Doudna'),
        },
      ],
    },
    {
      // Sparse upstream record: no dates, journal, URL, external identifiers, or source.
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
              source: clientSource('UC Berkeley Research Information System', 'APP-0000BERKELEY01'),
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
            // Sparse upstream record: organization name only, no dates, role, or source.
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
          source: RESEARCHER_SOURCE,
        },
        {
          // A renewal under the same grant number: one funding item, a second period.
          title: { title: { value: 'Genome Editing Program (renewal)' } },
          type: 'grant',
          organization: { name: 'National Institutes of Health' },
          'start-date': { year: { value: '2020' } },
          'end-date': { year: { value: '2025' } },
          'external-ids': {
            'external-id': [
              { 'external-id-type': 'grant_number', 'external-id-value': 'R01GM000000' },
            ],
          },
          source: clientSource('DimensionsWizard', '0000-0003-2174-0924', 'Jennifer Doudna'),
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
              source: clientSource(
                'Web of Science Researcher Profile Sync',
                'APP-945VYTN20B7BZXYT',
              ),
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
          source: clientSource('ACCESS', 'APP-7M3CGDKMQE36J56N'),
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
        source: CROSSREF_SOURCE,
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

/** Live title of put-code 215949395 on 0000-0001-9161-999X, markup and doubled spaces intact. */
export const MARKUP_TITLE = 'Amplified genome editing by  <i>in vivo</i>  editor production';
/** Deposited BibTeX carrying the same markup — relayed verbatim, never cleaned. */
export const MARKUP_BIBTEX =
  '@article{PPR:PPR1226445,\n\ttitle = {Amplified genome editing by  <i>in vivo</i>  editor production}\n}';

const MARKUP_WORKS = {
  group: [
    {
      'work-summary': [
        {
          'put-code': 215_949_395,
          title: { title: { value: MARKUP_TITLE } },
          type: 'preprint',
          'journal-title': { value: '<i>bioRxiv</i>' },
        },
      ],
    },
  ],
};

const MARKUP_BULK_WORKS = {
  bulk: [
    {
      work: {
        'put-code': 215_949_395,
        title: { title: { value: MARKUP_TITLE }, subtitle: { value: 'in  <i>Arabidopsis</i>' } },
        'short-description': '<h4>Background</h4>Group I introns.<h4>Results</h4>Heavy atoms.',
        citation: { 'citation-type': 'bibtex', 'citation-value': MARKUP_BIBTEX },
      },
    },
  ],
};

const LARGE_COLLAB_BULK_WORKS = {
  bulk: [
    {
      work: {
        'put-code': LARGE_COLLAB_PUT_CODE,
        title: {
          title: { value: 'Observation of a new particle in the search for the Higgs boson' },
        },
        type: 'journal-article',
        citation: { 'citation-type': 'bibtex', 'citation-value': LARGE_COLLAB_CITATION },
        contributors: {
          contributor: Array.from({ length: LARGE_COLLAB_CONTRIBUTORS }, (_, i) =>
            i === 150
              ? {
                  'credit-name': { value: 'Owner R.' },
                  'contributor-orcid': { path: LARGE_COLLAB_ID },
                  'contributor-attributes': { 'contributor-role': 'author' },
                }
              : {
                  'credit-name': { value: `Author ${i}` },
                  'contributor-attributes': { 'contributor-role': 'author' },
                },
          ),
        },
        source: clientSource('Scopus - Elsevier', 'APP-SCOPUS0000001'),
      },
    },
  ],
};

const MARKUP_FUNDINGS = {
  group: [{ 'funding-summary': [{ title: { title: { value: 'Editing  <i>in planta</i>' } } }] }],
};

const MARKUP_RESEARCH_RESOURCES = {
  group: [
    {
      'research-resource-summary': [
        {
          'put-code': 7002,
          proposal: { title: { title: { value: 'Cryo-EM of <i>E. coli</i>' } } },
        },
      ],
    },
  ],
};

const notFound = () => new Response('Not Found', { status: 404, statusText: 'Not Found' });
const badRequest = () => new Response('Bad Request', { status: 400, statusText: 'Bad Request' });
const rateLimited = () =>
  new Response('Rate limit exceeded for 203.0.113.7', {
    status: 429,
    statusText: 'Too Many Requests',
    headers: { 'Retry-After': '120' },
  });

/** ORCID relays a query its Solr backend rejects as HTTP 500 naming the Solr exception. */
const solrQueryRejected = () =>
  Response.json(
    {
      'response-code': 500,
      'developer-message': `org.apache.solr.client.solrj.impl.HttpSolrClient.RemoteSolrException Full validation error: Error from server at http://localhost:7983/solr/profile: undefined field ${BROKEN_QUERY_MARKER}`,
      'user-message': 'Something went wrong in ORCID.',
      'error-code': 9008,
    },
    { status: 500, statusText: 'Internal Server Error' },
  );

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
      respond: solrQueryRejected,
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
      match: (request) => isBulkWorksUrl(request.url, RATE_LIMITED_ID),
      respond: rateLimited,
    },
    {
      method: 'GET',
      match: (request) => isBulkWorksUrl(request.url, MARKUP_ID),
      respond: () => Response.json(MARKUP_BULK_WORKS),
    },
    {
      method: 'GET',
      match: (request) => isBulkWorksUrl(request.url, LARGE_COLLAB_ID),
      respond: () => Response.json(LARGE_COLLAB_BULK_WORKS),
    },
    {
      method: 'GET',
      match: `${BASE}/${MARKUP_ID}/works`,
      respond: () => Response.json(MARKUP_WORKS),
    },
    {
      method: 'GET',
      match: `${BASE}/${MARKUP_ID}/fundings`,
      respond: () => Response.json(MARKUP_FUNDINGS),
    },
    {
      method: 'GET',
      match: `${BASE}/${MARKUP_ID}/research-resources`,
      respond: () => Response.json(MARKUP_RESEARCH_RESOURCES),
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
