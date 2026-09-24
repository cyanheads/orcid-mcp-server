#!/usr/bin/env node
/**
 * @fileoverview orcid-mcp-server MCP server entry point. Provides access to the
 * ORCID researcher registry: search, profiles, works, affiliations, funding, and peer reviews.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { researcherProfileResource } from './mcp-server/resources/definitions/researcher-profile.resource.js';
import { researcherWorksResource } from './mcp-server/resources/definitions/researcher-works.resource.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initOrcidService } from './services/orcid/orcid-service.js';

await createApp({
  name: 'orcid-mcp-server',
  title: 'orcid-mcp-server',
  sessionMode: 'stateless',
  tools: allToolDefinitions,
  resources: [researcherProfileResource, researcherWorksResource],
  prompts: [],
  setup(core) {
    initOrcidService(core.config, core.storage);
  },
  instructions:
    'Use orcid_search_researchers for field-anchored lookups (name, institution, DOI, PMID, grant number) and orcid_resolve_researcher when an ambiguous author name needs ranked disambiguation. Build a researcher dossier with orcid_get_profile, orcid_get_works, and orcid_get_affiliations, then pass put-codes from orcid_get_works to orcid_get_work_detail (up to 100 per call) for abstracts and contributor lists. DOIs and PMIDs in orcid_get_works results chain directly to Crossref or PubMed servers.',
  landing: { requireAuth: false },
});
