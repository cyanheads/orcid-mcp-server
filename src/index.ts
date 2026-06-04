#!/usr/bin/env node
/**
 * @fileoverview orcid-mcp-server MCP server entry point. Provides access to the
 * ORCID researcher registry: search, profiles, works, affiliations, funding, and peer reviews.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { researcherProfileResource } from './mcp-server/resources/definitions/researcher-profile.resource.js';
import { researcherWorksResource } from './mcp-server/resources/definitions/researcher-works.resource.js';
import { orcidGetAffiliations } from './mcp-server/tools/definitions/get-affiliations.tool.js';
import { orcidGetFunding } from './mcp-server/tools/definitions/get-funding.tool.js';
import { orcidGetPeerReviews } from './mcp-server/tools/definitions/get-peer-reviews.tool.js';
import { orcidGetProfile } from './mcp-server/tools/definitions/get-profile.tool.js';
import { orcidGetResearchResources } from './mcp-server/tools/definitions/get-research-resources.tool.js';
import { orcidGetWorkDetail } from './mcp-server/tools/definitions/get-work-detail.tool.js';
import { orcidGetWorks } from './mcp-server/tools/definitions/get-works.tool.js';
import { orcidResolveResearcher } from './mcp-server/tools/definitions/resolve-researcher.tool.js';
import { orcidSearchResearchers } from './mcp-server/tools/definitions/search-researchers.tool.js';
import { initOrcidService } from './services/orcid/orcid-service.js';

await createApp({
  tools: [
    orcidGetProfile,
    orcidSearchResearchers,
    orcidGetWorks,
    orcidGetWorkDetail,
    orcidGetAffiliations,
    orcidGetFunding,
    orcidGetPeerReviews,
    orcidGetResearchResources,
    orcidResolveResearcher,
  ],
  resources: [researcherProfileResource, researcherWorksResource],
  prompts: [],
  setup(core) {
    initOrcidService(core.config, core.storage);
  },
  instructions:
    'ORCID researcher registry server. Use orcid_search_researchers for exact field lookups (name + institution + DOI/PMID). Use orcid_resolve_researcher when the input is an ambiguous author name needing ranked disambiguation. Use orcid_get_profile → orcid_get_works → orcid_get_affiliations to build a researcher dossier. Pass an array of put-codes from orcid_get_works to orcid_get_work_detail for abstracts and contributor lists (bulk fetch, up to 100 in one call). DOIs and PMIDs from orcid_get_works are ready for chaining to Crossref or PubMed servers.',
  landing: { requireAuth: false },
});
