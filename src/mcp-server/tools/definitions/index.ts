/**
 * @fileoverview Barrel of every tool definition this server registers. `src/index.ts`
 * passes this list to `createApp()`, so it is the registered tool set.
 * @module mcp-server/tools/definitions
 */

import { orcidGetAffiliations } from './get-affiliations.tool.js';
import { orcidGetFunding } from './get-funding.tool.js';
import { orcidGetPeerReviews } from './get-peer-reviews.tool.js';
import { orcidGetProfile } from './get-profile.tool.js';
import { orcidGetResearchResources } from './get-research-resources.tool.js';
import { orcidGetWorkDetail } from './get-work-detail.tool.js';
import { orcidGetWorks } from './get-works.tool.js';
import { orcidResolveResearcher } from './resolve-researcher.tool.js';
import { orcidSearchResearchers } from './search-researchers.tool.js';

/** Every tool definition, in registration order. */
export const allToolDefinitions = [
  orcidGetProfile,
  orcidSearchResearchers,
  orcidGetWorks,
  orcidGetWorkDetail,
  orcidGetAffiliations,
  orcidGetFunding,
  orcidGetPeerReviews,
  orcidGetResearchResources,
  orcidResolveResearcher,
];
