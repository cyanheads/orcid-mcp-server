/**
 * @fileoverview Tests for the `sources` every activity normalizer reports: who asserted each
 * item on the ORCID record, and whether that party is the requested researcher. Pure unit
 * tests over raw payload shapes captured from the live public API — no external calls.
 * @module tests/services/orcid/normalizers-sources.test
 */

import { assert, describe, expect, it } from 'vitest';
import {
  normalizeActivities,
  normalizeBulkWorks,
  normalizeFundings,
  normalizePeerReviews,
  normalizeResearchResources,
  normalizeWorkDetail,
  normalizeWorks,
} from '@/services/orcid/normalizers.js';
import type {
  RawActivities,
  RawFundingsResponse,
  RawPeerReviewsResponse,
  RawResearchResourcesResponse,
  RawSource,
  RawWorksResponse,
} from '@/services/orcid/types.js';

/** The requested record: 0000-0003-3632-5512 (David Ussery). */
const RESEARCHER = '0000-0003-3632-5512';

const orcidPath = (path: string) => ({ uri: `https://orcid.org/${path}`, path, host: 'orcid.org' });
const clientPath = (path: string) => ({
  uri: `https://orcid.org/client/${path}`,
  path,
  host: 'orcid.org',
});

/** Scopus adding a work through search-and-link, on the researcher's behalf (live shape). */
const SCOPUS_FOR_RESEARCHER: RawSource = {
  'source-orcid': null,
  // Member clients can carry ORCID-format paths; this one must never read as the researcher.
  'source-client-id': clientPath('0000-0002-5982-8983'),
  'source-name': { value: 'Scopus - Elsevier' },
  'assertion-origin-orcid': orcidPath(RESEARCHER),
  'assertion-origin-client-id': null,
  'assertion-origin-name': { value: 'David Ussery' },
};

/** The university's research information system asserting on its own account (live shape). */
const OSU_SYSTEM: RawSource = {
  'source-orcid': null,
  'source-client-id': clientPath('APP-WWZS4Y8XMSMO4K10'),
  'source-name': { value: "Oklahoma State University's Research Information Management System" },
  'assertion-origin-orcid': null,
  'assertion-origin-client-id': null,
  'assertion-origin-name': null,
};

/** Crossref auto-update: a client whose path is ORCID-format, with no assertion origin. */
const CROSSREF: RawSource = {
  'source-orcid': null,
  'source-client-id': clientPath('0000-0001-9884-1913'),
  'source-name': { value: 'Crossref' },
  'assertion-origin-orcid': null,
  'assertion-origin-client-id': null,
  'assertion-origin-name': null,
};

/** The researcher entering an item on orcid.org. */
const RESEARCHER_ENTERED: RawSource = {
  'source-orcid': orcidPath(RESEARCHER),
  'source-client-id': null,
  'source-name': { value: 'David Ussery' },
  'assertion-origin-orcid': null,
  'assertion-origin-client-id': null,
  'assertion-origin-name': null,
};

const SCOPUS_ENTRY = {
  name: 'Scopus - Elsevier',
  assertionOriginName: 'David Ussery',
  selfAsserted: true,
};
const OSU_ENTRY = {
  name: "Oklahoma State University's Research Information Management System",
  selfAsserted: false,
};

describe('normalizeWorks sources', () => {
  it('reports a search-and-link deposit as asserted by the researcher, via the tool', () => {
    const raw: RawWorksResponse = {
      group: [{ 'work-summary': [{ 'put-code': 165310276, source: SCOPUS_FOR_RESEARCHER }] }],
    };
    const [work] = normalizeWorks(raw, RESEARCHER);
    assert(work);
    expect(work.sources).toEqual([SCOPUS_ENTRY]);
  });

  it('lists every distinct source in the group, the representative summary’s first', () => {
    // Put-code 165310393: Scopus on the researcher's behalf, then the university system.
    const raw: RawWorksResponse = {
      group: [
        {
          'work-summary': [
            { 'put-code': 165310393, source: SCOPUS_FOR_RESEARCHER },
            { 'put-code': 189697125, source: OSU_SYSTEM },
          ],
        },
      ],
    };
    const [work] = normalizeWorks(raw, RESEARCHER);
    assert(work);
    expect(work.putCode).toBe(165310393);
    expect(work.sources).toEqual([SCOPUS_ENTRY, OSU_ENTRY]);
  });

  it('lists a source that deposited twice once, keyed on source and assertion-origin IDs', () => {
    const scopusForColleague: RawSource = {
      ...SCOPUS_FOR_RESEARCHER,
      'assertion-origin-orcid': orcidPath('0000-0002-1825-0097'),
      'assertion-origin-name': { value: 'A Colleague' },
    };
    const raw: RawWorksResponse = {
      group: [
        {
          'work-summary': [
            { source: OSU_SYSTEM },
            { source: SCOPUS_FOR_RESEARCHER },
            { source: OSU_SYSTEM },
            // Same client, different assertion origin: a distinct asserting party.
            { source: scopusForColleague },
            { source: SCOPUS_FOR_RESEARCHER },
            // No source at all contributes nothing.
            {},
          ],
        },
      ],
    };
    const [work] = normalizeWorks(raw, RESEARCHER);
    assert(work);
    expect(work.sources).toEqual([
      OSU_ENTRY,
      SCOPUS_ENTRY,
      { name: 'Scopus - Elsevier', assertionOriginName: 'A Colleague', selfAsserted: false },
    ]);
  });
});

describe('selfAsserted', () => {
  const sourcesOf = (source: RawSource | undefined) => {
    const raw: RawWorksResponse = { group: [{ 'work-summary': [{ ...(source && { source }) }] }] };
    const [work] = normalizeWorks(raw, RESEARCHER);
    assert(work);
    return work.sources;
  };

  it('is true when the source is the requested iD itself', () => {
    expect(sourcesOf(RESEARCHER_ENTERED)).toEqual([{ name: 'David Ussery', selfAsserted: true }]);
  });

  it('is false for a member client with no assertion origin, even with an ORCID-format path', () => {
    expect(sourcesOf(CROSSREF)).toEqual([{ name: 'Crossref', selfAsserted: false }]);
  });

  it('is false when another researcher entered the item', () => {
    const other: RawSource = {
      ...RESEARCHER_ENTERED,
      'source-orcid': orcidPath('0000-0002-1825-0097'),
    };
    expect(sourcesOf(other)?.[0]?.selfAsserted).toBe(false);
  });

  it('follows the assertion origin over the source when one is recorded', () => {
    // A member asserting on behalf of another member: the origin is a client, not the iD.
    const onBehalfOfClient: RawSource = {
      ...RESEARCHER_ENTERED,
      'assertion-origin-client-id': clientPath('APP-ABCDEFGHIJKLMNOP'),
      'assertion-origin-name': { value: 'A Funder' },
    };
    expect(sourcesOf(onBehalfOfClient)).toEqual([
      { name: 'David Ussery', assertionOriginName: 'A Funder', selfAsserted: false },
    ]);
  });

  it('keeps selfAsserted when the source name is null, and leaves name absent', () => {
    expect(sourcesOf({ ...RESEARCHER_ENTERED, 'source-name': null })).toEqual([
      { selfAsserted: true },
    ]);
  });

  it('yields no sources for a summary with no source block', () => {
    expect(sourcesOf(undefined)).toEqual([]);
    const raw = { group: [{ 'work-summary': [{ source: null }] }] } as unknown as RawWorksResponse;
    expect(normalizeWorks(raw, RESEARCHER)[0]?.sources).toEqual([]);
  });
});

describe('sources on the other activity normalizers', () => {
  it('normalizeActivities: an employment asserted by the university system', () => {
    // Put-code 30902661 on 0000-0003-3632-5512.
    const raw: RawActivities = {
      employments: {
        'affiliation-group': [
          {
            summaries: [
              {
                'employment-summary': {
                  'put-code': 30902661,
                  organization: { name: 'Oklahoma State University' },
                  source: OSU_SYSTEM,
                },
              },
              { 'employment-summary': { organization: { name: 'Elsewhere' } } },
            ],
          },
        ],
      },
    };
    const [osu, sourceless] = normalizeActivities(raw, ['employment'], RESEARCHER);
    assert(osu && sourceless);
    expect(osu.sources).toEqual([OSU_ENTRY]);
    expect(sourceless.sources).toEqual([]);
  });

  it('normalizeFundings: every distinct source in the funding group, the representative’s first', () => {
    const dimensions: RawSource = {
      'source-client-id': clientPath('0000-0003-2174-0924'),
      'source-name': { value: 'DimensionsWizard' },
      'assertion-origin-orcid': orcidPath(RESEARCHER),
      'assertion-origin-name': { value: 'David Ussery' },
    };
    const raw: RawFundingsResponse = {
      group: [
        {
          'funding-summary': [
            { source: RESEARCHER_ENTERED },
            { source: dimensions },
            { source: dimensions },
          ],
        },
      ],
    };
    const [record] = normalizeFundings(raw, RESEARCHER);
    assert(record);
    expect(record.sources).toEqual([
      { name: 'David Ussery', selfAsserted: true },
      { name: 'DimensionsWizard', assertionOriginName: 'David Ussery', selfAsserted: true },
    ]);
  });

  it('normalizePeerReviews: a review imported by Web of Science', () => {
    const wos: RawSource = {
      'source-client-id': clientPath('APP-945VYTN20B7BZXYT'),
      'source-name': { value: 'Web of Science Researcher Profile Sync' },
    };
    const raw: RawPeerReviewsResponse = {
      group: [{ 'peer-review-group': [{ 'peer-review-summary': [{ source: wos }, {}] }] }],
    };
    const [imported, sourceless] = normalizePeerReviews(raw, RESEARCHER);
    assert(imported && sourceless);
    expect(imported.sources).toEqual([
      { name: 'Web of Science Researcher Profile Sync', selfAsserted: false },
    ]);
    expect(sourceless.sources).toEqual([]);
  });

  it('normalizeResearchResources: an allocation deposited by its allocation system', () => {
    const access: RawSource = {
      'source-client-id': clientPath('APP-7M3CGDKMQE36J56N'),
      'source-name': { value: 'ACCESS' },
    };
    const raw: RawResearchResourcesResponse = {
      group: [{ 'research-resource-summary': [{ 'put-code': 7001, source: access }] }],
    };
    const [resource] = normalizeResearchResources(raw, RESEARCHER);
    assert(resource);
    expect(resource.sources).toEqual([{ name: 'ACCESS', selfAsserted: false }]);
  });

  it('normalizeWorkDetail and normalizeBulkWorks: the put-code’s own source', () => {
    const detail = normalizeWorkDetail({ 'put-code': 220918354, source: CROSSREF }, RESEARCHER);
    expect(detail.sources).toEqual([{ name: 'Crossref', selfAsserted: false }]);

    const [entry] = normalizeBulkWorks(
      { bulk: [{ work: { 'put-code': 165310276, source: SCOPUS_FOR_RESEARCHER } }] },
      RESEARCHER,
    );
    assert(entry?.type === 'work');
    expect(entry.detail.sources).toEqual([SCOPUS_ENTRY]);
  });
});
