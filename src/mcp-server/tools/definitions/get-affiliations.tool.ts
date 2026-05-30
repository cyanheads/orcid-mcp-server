/**
 * @fileoverview Fetch affiliation records (employment, education, invited positions,
 * distinctions, memberships, qualifications, services) for an ORCID researcher.
 * @module mcp-server/tools/definitions/get-affiliations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  type AffiliationType,
  getOrcidService,
  normalizeOrcidId,
} from '@/services/orcid/orcid-service.js';
import type { Affiliation } from '@/services/orcid/types.js';

const AFFILIATION_TYPES = [
  'employment',
  'education',
  'invited-positions',
  'distinctions',
  'memberships',
  'qualifications',
  'services',
  'all',
] as const;

export const orcidGetAffiliations = tool('orcid_get_affiliations', {
  title: 'Get ORCID Researcher Affiliations',
  description:
    'Fetch affiliation records for an ORCID researcher. The `types` parameter controls which affiliation sections to return: employment, education, invited-positions, distinctions, memberships, qualifications, services, or all. Default is employment and education. Returns organization names, disambiguated organization identifiers (ROR/GRID/Ringgold), departments, roles, and date ranges. Affiliation data is self-reported; absence does not mean no affiliation.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    orcid_id: z
      .string()
      .regex(
        /^(https?:\/\/orcid\.org\/)?\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/,
        'Must be a valid ORCID iD (e.g. 0000-0001-2345-6789) or full ORCID URI.',
      )
      .describe(
        'ORCID iD — bare format (0000-0001-2345-6789) or full URI (https://orcid.org/0000-0001-2345-6789).',
      ),
    types: z
      .array(
        z
          .enum(AFFILIATION_TYPES)
          .describe('Affiliation section type. Use "all" to include all section types.'),
      )
      .default(['employment', 'education'])
      .describe(
        'Which affiliation types to return. Defaults to employment and education. Use ["all"] to get every section.',
      ),
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    affiliationCount: z.number().describe('Total number of affiliation records returned.'),
    affiliations: z
      .array(
        z
          .object({
            type: z
              .string()
              .describe(
                'Affiliation section type (employment, education, invited-positions, etc.).',
              ),
            organization: z
              .object({
                name: z.string().optional().describe('Organization name.'),
                city: z.string().optional().describe('City of the organization.'),
                country: z.string().optional().describe('Country of the organization.'),
                disambiguatedId: z
                  .string()
                  .optional()
                  .describe(
                    'Disambiguated organization identifier (ROR URL, GRID ID, or Ringgold ID).',
                  ),
                disambiguationSource: z
                  .string()
                  .optional()
                  .describe('Source of the disambiguation (ROR, GRID, or RINGGOLD).'),
              })
              .optional()
              .describe('Organization details.'),
            department: z
              .string()
              .optional()
              .describe('Department or unit within the organization.'),
            role: z.string().optional().describe('Job title or role.'),
            startDate: z.string().optional().describe('Start date (YYYY, YYYY-MM, or YYYY-MM-DD).'),
            endDate: z
              .string()
              .optional()
              .describe('End date (YYYY, YYYY-MM, or YYYY-MM-DD). Absent if current.'),
            url: z.string().optional().describe('URL for the affiliation record, if provided.'),
          })
          .describe('Affiliation record.'),
      )
      .describe('Affiliation records for the requested types.'),
    requestedTypes: z
      .array(z.string().describe('Affiliation type.'))
      .describe('Affiliation types that were requested.'),
  }),

  // Agent-facing context: empty-result notice surfaces in structuredContent and content[]
  // without occupying the domain return.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Note when no affiliations were found — may indicate private visibility or no self-reported affiliations.',
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
    ctx.log.info('orcid_get_affiliations', { orcidId: input.orcid_id, types: input.types });

    let affiliations: Affiliation[];
    try {
      affiliations = await service.getAffiliations(
        input.orcid_id,
        input.types as AffiliationType[],
        ctx,
      );
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

    ctx.log.info('orcid_get_affiliations completed', {
      orcidId: bareId,
      affiliationCount: affiliations.length,
    });

    if (affiliations.length === 0) {
      ctx.enrich.notice(
        `No affiliations found for the requested types (${input.types.join(', ')}). These may be set to private or not self-reported.`,
      );
    }

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      affiliationCount: affiliations.length,
      affiliations,
      requestedTypes: input.types,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Affiliations for ORCID ${result.orcidId}`,
      `**URI:** ${result.orcidUri}`,
      `**Types Requested:** ${result.requestedTypes.join(', ')}`,
      `**Total Affiliations:** ${result.affiliationCount}`,
    ];

    if (result.affiliations.length === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    // Group by type for readability
    const byType = new Map<string, typeof result.affiliations>();
    for (const a of result.affiliations) {
      const group = byType.get(a.type) ?? [];
      group.push(a);
      byType.set(a.type, group);
    }

    for (const [type, affs] of byType) {
      lines.push('', `### ${type.charAt(0).toUpperCase() + type.slice(1).replace(/-/g, ' ')}`);
      for (const a of affs) {
        const orgName = a.organization?.name ?? 'Unknown organization';
        lines.push(`**${orgName}**`);
        if (a.department) lines.push(`  Department: ${a.department}`);
        if (a.role) lines.push(`  Role: ${a.role}`);
        const dateRange = [a.startDate, a.endDate ? a.endDate : 'present']
          .filter(Boolean)
          .join(' – ');
        if (dateRange) lines.push(`  Dates: ${dateRange}`);
        if (a.organization?.city) lines.push(`  City: ${a.organization.city}`);
        if (a.organization?.country) lines.push(`  Country: ${a.organization.country}`);
        if (a.organization?.disambiguatedId) {
          lines.push(
            `  Org ID: ${a.organization.disambiguatedId} (${a.organization.disambiguationSource ?? 'unknown source'})`,
          );
        }
        if (a.url) lines.push(`  URL: ${a.url}`);
        lines.push('');
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
