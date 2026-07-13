/**
 * @fileoverview List research resources (equipment, facilities, compute allocations, etc.)
 * associated with an ORCID researcher.
 * @module mcp-server/tools/definitions/get-research-resources
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { orcidIdSchema } from '@/services/orcid/orcid-id.js';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';
import type { ResearchResource } from '@/services/orcid/types.js';

const ExternalIdSchema = z
  .object({
    type: z.string().describe('Identifier type (e.g. uri, doi, grant_number).'),
    value: z.string().describe('Identifier value.'),
    url: z.string().optional().describe('Resolver URL for this identifier, if available.'),
    relationship: z.string().optional().describe('Relationship to the resource (self or part-of).'),
  })
  .describe('External identifier for the research resource.');

const OrgSchema = z
  .object({
    name: z.string().optional().describe('Organization name.'),
    city: z.string().optional().describe('City of the organization.'),
    country: z.string().optional().describe('Country code of the organization.'),
    disambiguatedId: z
      .string()
      .optional()
      .describe('Disambiguated organization ID (e.g. ROR or GRID identifier).'),
    disambiguationSource: z
      .string()
      .optional()
      .describe('Source of the disambiguation ID (e.g. ROR, GRID, RINGGOLD).'),
  })
  .describe('Hosting organization for the research resource.');

export const orcidGetResearchResources = tool('orcid_get_research_resources', {
  title: 'Get ORCID Research Resources',
  description:
    'List research resources associated with an ORCID researcher — compute allocations, equipment access, lab facilities, data resources, and clinical study registrations. This is a newer ORCID section; most researchers have no entries. Returns the resource title, hosting organization, external identifiers (often a URI to the allocation portal), and access period. Most entries are deposited by resource-allocation systems (e.g. ACCESS, XSEDE) rather than researchers themselves.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    orcid_id: orcidIdSchema,
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    resourceCount: z.number().describe('Total number of research resources returned.'),
    resources: z
      .array(
        z
          .object({
            putCode: z.number().describe('Put-code of this research resource record.'),
            title: z.string().optional().describe('Resource or proposal title.'),
            hostOrganization: OrgSchema.optional().describe(
              'Organization that hosts or manages the resource.',
            ),
            externalIds: z
              .array(ExternalIdSchema)
              .describe('External identifiers for the resource (often a portal URI).'),
            startDate: z
              .string()
              .optional()
              .describe('Access or allocation start date (YYYY, YYYY-MM, or YYYY-MM-DD).'),
            endDate: z
              .string()
              .optional()
              .describe('Access or allocation end date (YYYY, YYYY-MM, or YYYY-MM-DD).'),
            url: z.string().optional().describe('URL for the resource or allocation record.'),
          })
          .describe('Research resource record.'),
      )
      .describe('Research resources associated with this ORCID iD.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Note when no research resources are found — this section is sparsely populated across ORCID profiles.',
      ),
  },

  errors: [
    {
      reason: 'profile_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The ORCID iD does not correspond to a registered researcher.',
      recovery:
        'Verify the ORCID iD is correct and try orcid_search_researchers to find valid iDs.',
    },
  ],

  async handler(input, ctx) {
    const service = getOrcidService();
    ctx.log.info('orcid_get_research_resources', { orcidId: input.orcid_id });

    let resources: ResearchResource[];
    try {
      resources = await service.getResearchResources(input.orcid_id, ctx);
      // The /research-resources endpoint is unique among ORCID sections: it returns
      // HTTP 200 {"group":[]} for non-existent iDs instead of 404, so an empty result
      // is ambiguous (genuinely empty vs. no such record). Disambiguate by fetching
      // /person, which does 404 for non-existent iDs. Only on the empty path — a
      // populated result already proves the record exists, so no extra round-trip there.
      if (resources.length === 0) {
        await service.getPerson(input.orcid_id, ctx);
      }
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'profile_not_found',
          `ORCID iD ${normalizeOrcidId(input.orcid_id)} not found`,
        );
      }
      throw err;
    }

    const bareId = normalizeOrcidId(input.orcid_id);
    ctx.log.info('orcid_get_research_resources completed', {
      orcidId: bareId,
      resourceCount: resources.length,
    });

    if (resources.length === 0) {
      ctx.enrich.notice(
        'No research resources found. This ORCID section is sparsely populated — most researchers have no entries. Resources are typically deposited by allocation systems (e.g. ACCESS, XSEDE) rather than self-reported.',
      );
    }

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      resourceCount: resources.length,
      resources,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Research Resources for ORCID ${result.orcidId}`,
      `**URI:** ${result.orcidUri}`,
      `**Total Resources:** ${result.resourceCount}`,
    ];

    if (result.resources.length === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('');
    for (const r of result.resources) {
      lines.push(`### ${r.title ?? '(untitled)'}`);
      lines.push(`**Put-code:** ${r.putCode}`);
      if (r.hostOrganization) {
        const org = r.hostOrganization;
        const parts: string[] = [];
        if (org.name) parts.push(org.name);
        if (org.city) parts.push(org.city);
        if (org.country) parts.push(org.country);
        if (parts.length) lines.push(`**Host:** ${parts.join(', ')}`);
        if (org.disambiguatedId) {
          lines.push(
            `**Host ID:** ${org.disambiguatedId} (${org.disambiguationSource ?? 'unknown source'})`,
          );
        }
      }
      if (r.startDate || r.endDate) {
        const period = [r.startDate, r.endDate].filter(Boolean).join(' – ');
        lines.push(`**Period:** ${period}`);
      }
      if (r.url) lines.push(`**URL:** ${r.url}`);
      if (r.externalIds.length) {
        const idParts = r.externalIds.map((id) => {
          const rel = id.relationship ? ` [${id.relationship}]` : '';
          const urlPart = id.url ? ` (${id.url})` : '';
          return `${id.type}:${id.value}${urlPart}${rel}`;
        });
        lines.push(`**IDs:** ${idParts.join(', ')}`);
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
