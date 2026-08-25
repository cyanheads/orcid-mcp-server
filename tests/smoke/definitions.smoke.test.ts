/**
 * @fileoverview Smoke coverage for every definition this server registers: each of the
 * nine tools and two resources runs schema parse → handler → format once against a
 * faked ORCID upstream, proving the definition is wired end to end. The fetch harness
 * throws on any unrouted request, so a real network call fails the suite.
 * @module tests/smoke/definitions.smoke.test
 */

import type { FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { researcherProfileResource } from '@/mcp-server/resources/definitions/researcher-profile.resource.js';
import { researcherWorksResource } from '@/mcp-server/resources/definitions/researcher-works.resource.js';
import { orcidGetAffiliations } from '@/mcp-server/tools/definitions/get-affiliations.tool.js';
import { orcidGetFunding } from '@/mcp-server/tools/definitions/get-funding.tool.js';
import { orcidGetPeerReviews } from '@/mcp-server/tools/definitions/get-peer-reviews.tool.js';
import { orcidGetProfile } from '@/mcp-server/tools/definitions/get-profile.tool.js';
import { orcidGetResearchResources } from '@/mcp-server/tools/definitions/get-research-resources.tool.js';
import { orcidGetWorkDetail } from '@/mcp-server/tools/definitions/get-work-detail.tool.js';
import { orcidGetWorks } from '@/mcp-server/tools/definitions/get-works.tool.js';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';
import {
  createOrcidFetchMock,
  initOrcidServiceForTests,
  RESEARCHER_ID,
  RESOLVED_PUT_CODE,
  UNRESOLVED_PUT_CODE,
} from '../integration/orcid-api-fixtures.js';

/** Concatenate the text a definition's format() blocks render. */
function renderedText(blocks: readonly { type: string }[]): string {
  const text = blocks
    .flatMap((block) => ('text' in block && typeof block.text === 'string' ? [block.text] : []))
    .join('\n');
  expect(text).not.toBe('');
  return text;
}

let http: FetchMockHarness;

beforeAll(() => {
  http = createOrcidFetchMock();
  http.install();
  initOrcidServiceForTests();
});

afterAll(() => {
  http.restore();
});

describe('orcid-mcp-server definition smoke test', () => {
  it('runs orcid_search_researchers end to end', async () => {
    const ctx = createMockContext({ errors: orcidSearchResearchers.errors });
    const input = orcidSearchResearchers.input.parse({ given_name: 'Jennifer', rows: 2 });
    const result = await orcidSearchResearchers.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(orcidSearchResearchers.output));
    expect(result.results[0]?.orcidId).toBe(RESEARCHER_ID);
    expect(renderedText(orcidSearchResearchers.format!(result))).toContain(RESEARCHER_ID);
  });

  it('runs orcid_resolve_researcher end to end', async () => {
    const ctx = createMockContext({ errors: orcidResolveResearcher.errors });
    const input = orcidResolveResearcher.input.parse({
      name: 'Jennifer Doudna',
      affiliation: 'University of California, Berkeley',
    });
    const result = await orcidResolveResearcher.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(orcidResolveResearcher.output));
    expect(result.candidates[0]).toMatchObject({
      orcidId: RESEARCHER_ID,
      nameMatchType: 'exact',
      institutionOverlap: true,
      anchorType: 'none',
    });
    expect(renderedText(orcidResolveResearcher.format!(result))).toContain('Name Match');
  });

  it('runs orcid_get_profile end to end', async () => {
    const ctx = createMockContext({ errors: orcidGetProfile.errors });
    const input = orcidGetProfile.input.parse({ orcid_id: RESEARCHER_ID });
    const result = await orcidGetProfile.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(orcidGetProfile.output));
    expect(result.familyName).toBe('Doudna');
    expect(renderedText(orcidGetProfile.format!(result))).toContain('Scopus Author ID');
  });

  it('runs orcid_get_works end to end', async () => {
    const ctx = createMockContext({ errors: orcidGetWorks.errors });
    const input = orcidGetWorks.input.parse({ orcid_id: RESEARCHER_ID, limit: 1 });
    const result = await orcidGetWorks.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(orcidGetWorks.output));
    expect(result).toMatchObject({
      workCount: 2,
      returnedCount: 1,
      truncated: true,
      nextOffset: 1,
    });
    expect(renderedText(orcidGetWorks.format!(result))).toContain('10.1126/science.1225829');
  });

  it('runs orcid_get_work_detail end to end', async () => {
    const ctx = createMockContext({ errors: orcidGetWorkDetail.errors });
    const input = orcidGetWorkDetail.input.parse({
      orcid_id: RESEARCHER_ID,
      put_codes: [RESOLVED_PUT_CODE, UNRESOLVED_PUT_CODE],
    });
    const result = await orcidGetWorkDetail.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(orcidGetWorkDetail.output));
    expect(result.works[0]?.putCode).toBe(RESOLVED_PUT_CODE);
    expect(result.errors[0]?.putCode).toBe(UNRESOLVED_PUT_CODE);
    expect(renderedText(orcidGetWorkDetail.format!(result))).toContain('Martin Jinek');
  });

  it('runs orcid_get_affiliations end to end', async () => {
    const ctx = createMockContext({ errors: orcidGetAffiliations.errors });
    const input = orcidGetAffiliations.input.parse({ orcid_id: RESEARCHER_ID });
    const result = await orcidGetAffiliations.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(orcidGetAffiliations.output));
    expect(result.affiliationCount).toBe(2);
    expect(renderedText(orcidGetAffiliations.format!(result))).toContain(
      'https://ror.org/01an7q238',
    );
  });

  it('runs orcid_get_funding end to end', async () => {
    const ctx = createMockContext({ errors: orcidGetFunding.errors });
    const input = orcidGetFunding.input.parse({ orcid_id: RESEARCHER_ID });
    const result = await orcidGetFunding.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(orcidGetFunding.output));
    expect(result.funding[0]?.grantNumbers).toEqual(['R01GM000000']);
    expect(renderedText(orcidGetFunding.format!(result))).toContain(
      'National Institutes of Health',
    );
  });

  it('runs orcid_get_peer_reviews end to end', async () => {
    const ctx = createMockContext({ errors: orcidGetPeerReviews.errors });
    const input = orcidGetPeerReviews.input.parse({ orcid_id: RESEARCHER_ID });
    const result = await orcidGetPeerReviews.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(orcidGetPeerReviews.output));
    expect(result.peerReviews[0]?.groupIssn).toBe('1476-4687');
    expect(renderedText(orcidGetPeerReviews.format!(result))).toContain('Nature');
  });

  it('runs orcid_get_research_resources end to end', async () => {
    const ctx = createMockContext({ errors: orcidGetResearchResources.errors });
    const input = orcidGetResearchResources.input.parse({ orcid_id: RESEARCHER_ID });
    const result = await orcidGetResearchResources.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(orcidGetResearchResources.output));
    expect(result.resources[0]?.putCode).toBe(7001);
    expect(renderedText(orcidGetResearchResources.format!(result))).toContain(
      'ACCESS compute allocation',
    );
  });

  it('runs the orcid-researcher-profile resource end to end', async () => {
    const ctx = createMockContext({ uri: new URL(`orcid://researcher/${RESEARCHER_ID}/profile`) });
    const params = researcherProfileResource.params!.parse({ orcid_id: RESEARCHER_ID });
    const result = await researcherProfileResource.handler(params, ctx);

    expect(result).toEqual(expect.schemaMatching(researcherProfileResource.output!));
    expect(result).toMatchObject({
      orcidId: RESEARCHER_ID,
      orcidUri: `https://orcid.org/${RESEARCHER_ID}`,
      creditName: 'Jennifer A. Doudna',
    });
  });

  it('runs the orcid-researcher-works resource end to end', async () => {
    const ctx = createMockContext({ uri: new URL(`orcid://researcher/${RESEARCHER_ID}/works`) });
    const params = researcherWorksResource.params!.parse({ orcid_id: RESEARCHER_ID });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result).toEqual(expect.schemaMatching(researcherWorksResource.output!));
    expect(result.workCount).toBe(2);
    expect(result.works[0]?.externalIds).toEqual([
      { type: 'doi', value: '10.1126/science.1225829' },
      { type: 'pmid', value: '22745249' },
    ]);
  });

  it('made no unrouted upstream requests', () => {
    expect(http.calls.length).toBeGreaterThan(0);
    for (const call of http.calls) {
      expect(call.request.url.startsWith('https://pub.orcid.org/')).toBe(true);
    }
  });
});
