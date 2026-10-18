/**
 * @fileoverview List research resources (equipment, facilities, compute allocations, etc.)
 * associated with an ORCID researcher.
 * @module mcp-server/tools/definitions/get-research-resources
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { SourceSchema, sourcesText } from '@/mcp-server/tools/record-sources.js';
import { jsonBytes, RESPONSE_BYTE_BUDGET } from '@/mcp-server/tools/response-budget.js';
import { singleLine } from '@/mcp-server/tools/third-party-text.js';
import { orcidIdSchema } from '@/services/orcid/orcid-id.js';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';
import type {
  ExternalIdentifier,
  Organization,
  ResearchResource,
  ResearchResourceDetail,
  ResearchResourceItem,
} from '@/services/orcid/types.js';

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
    'List allocation proposals for an ORCID researcher, or supply put_code from a summary record to retrieve its actual resource items. Summary is the default view and includes every proposal host, identifiers, access period, and source provenance; hostOrganization remains the first proposal host. Detail adds item names, types, all operators, identifiers, and URLs. Page items with item_offset (default 0) and item_limit (default 50, effective maximum 100, hard maximum 10,000), both requiring put_code; continue at nextItemOffset with the same selector. Both detail surfaces fit 64,000 bytes including metadata and continuation, with an explicit budgetOverflow exception for an indivisible oversized item returned alone or oversized proposal metadata. Most researchers have no entries; allocation systems such as ACCESS deposit these records.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    orcid_id: orcidIdSchema,
    put_code: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Proposal put-code from summary mode; selects the full allocation detail.'),
    item_offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Detail item offset, default 0; requires put_code.'),
    item_limit: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe('Detail page size, default 50, effective maximum 100; requires put_code.'),
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    view: z.enum(['summary', 'detail']).describe('Summary list or selected allocation detail.'),
    putCode: z.number().optional().describe('Selected proposal put-code in detail mode.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'Detail-page indicator: true exactly when the selected resource has allocation items remaining after this page; mirrors itemsTruncated. Absent in summary mode.',
      ),
    itemLimitNotice: z
      .string()
      .optional()
      .describe('Notice when the requested item limit is reduced to the effective maximum of 100.'),
    budgetOverflow: z
      .string()
      .optional()
      .describe(
        'Explicit exception when an indivisible item or proposal metadata exceeds the 64,000-byte surface budget.',
      ),
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
            proposalHosts: z
              .array(OrgSchema)
              .optional()
              .describe('All proposal hosts in upstream order; separate from item operators.'),
            items: z
              .array(
                z
                  .object({
                    name: z.string().optional().describe('Allocated resource name.'),
                    type: z.string().optional().describe('Allocated resource type.'),
                    hosts: z
                      .array(OrgSchema)
                      .describe(
                        'All item operators in upstream order; missing host details remain unknown.',
                      ),
                    externalIds: z.array(ExternalIdSchema).describe('Deposited item identifiers.'),
                    url: z.string().optional().describe('Deposited item URL.'),
                  })
                  .describe('One deposited allocation item.'),
              )
              .optional()
              .describe('Selected page of allocation items in detail mode.'),
            itemCount: z.number().optional().describe('Total deposited allocation items.'),
            returnedItemCount: z.number().optional().describe('Items returned on this page.'),
            itemOffset: z.number().optional().describe('Requested detail item offset.'),
            nextItemOffset: z
              .number()
              .optional()
              .describe('First omitted item offset; absent when no items remain.'),
            itemsTruncated: z
              .boolean()
              .optional()
              .describe('Whether more allocation items remain after this page.'),
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
            sources: z
              .array(SourceSchema)
              .describe(
                'The party that added this resource to the ORCID record — usually the allocation system that granted it. Empty when ORCID records no source.',
              ),
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
      reason: 'detail_required',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Item paging arguments are supplied without put_code.',
      recovery: 'Supply put_code from a summary record before paging allocation items.',
    },
    {
      reason: 'resource_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The selected allocation detail does not exist or is not public.',
      recovery: 'Fetch the summary list and choose a public resource put-code.',
    },
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

    if (
      input.put_code === undefined &&
      (input.item_offset !== undefined || input.item_limit !== undefined)
    ) {
      throw ctx.fail('detail_required');
    }
    if (input.put_code !== undefined) {
      const putCode = input.put_code;
      let detail: ResearchResourceDetail;
      try {
        detail = await service.getResearchResourceDetail(input.orcid_id, input.put_code, ctx);
      } catch (error) {
        if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound)
          throw ctx.fail('resource_not_found');
        throw error;
      }
      const bareId = normalizeOrcidId(input.orcid_id);
      const offset = input.item_offset ?? 0;
      const { items, ...proposal } = detail;
      const candidates = items.slice(offset, offset + Math.min(input.item_limit ?? 50, 100));
      const page = (count: number, budgetOverflow?: string): ResourceResult => {
        const next = offset + count;
        const more = next < items.length;
        return {
          orcidId: bareId,
          orcidUri: `https://orcid.org/${bareId}`,
          view: 'detail',
          putCode,
          truncated: more,
          ...((input.item_limit ?? 50) > 100 && {
            itemLimitNotice: `Requested item_limit ${input.item_limit}; effective maximum is 100 items per page.`,
          }),
          resourceCount: 1,
          ...(budgetOverflow && { budgetOverflow }),
          resources: [
            {
              ...proposal,
              items: candidates.slice(0, count),
              itemCount: items.length,
              returnedItemCount: count,
              itemOffset: offset,
              itemsTruncated: more,
              ...(more && { nextItemOffset: next }),
            },
          ],
        };
      };
      const fits = (value: ResourceResult) =>
        jsonBytes(value) <= RESPONSE_BYTE_BUDGET &&
        jsonBytes(renderResources(value)) <= RESPONSE_BYTE_BUDGET;
      if (fits(page(candidates.length))) return page(candidates.length);
      let low = 0;
      let high = candidates.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(page(mid))) low = mid;
        else high = mid - 1;
      }
      if (low > 0) return page(low);
      return page(
        Math.min(candidates.length, 1),
        candidates.length
          ? 'One indivisible allocation item and its proposal metadata exceed the 64,000-byte budget; returned alone.'
          : 'Indivisible proposal metadata exceeds the 64,000-byte budget; no allocation items remain.',
      );
    }

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
      view: 'summary' as const,
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      resourceCount: resources.length,
      resources,
    };
  },

  format: renderResources,
});

type PagedResource = ResearchResource & {
  items?: ResearchResourceItem[];
  itemCount?: number;
  returnedItemCount?: number;
  itemOffset?: number;
  nextItemOffset?: number;
  itemsTruncated?: boolean;
};
type ResourceResult = {
  orcidId: string;
  orcidUri: string;
  resourceCount: number;
  resources: PagedResource[];
  view: 'summary' | 'detail';
  putCode?: number;
  budgetOverflow?: string;
  truncated?: boolean;
  itemLimitNotice?: string;
};

/** Render the complete proposal and allocation page on the text surface. */
function renderResources(result: ResourceResult): { type: 'text'; text: string }[] {
  const lines: string[] = [
    `## Research Resources for ORCID ${result.orcidId}`,
    `**URI:** ${result.orcidUri}`,
    `**Total Resources:** ${result.resourceCount}`,
    `**View:** ${result.view}`,
    ...(result.putCode !== undefined ? [`**Selected put-code:** ${result.putCode}`] : []),
    ...(result.budgetOverflow ? [`**Budget exception:** ${result.budgetOverflow}`] : []),
    ...(result.truncated !== undefined
      ? [`**Allocation items truncated:** ${result.truncated}`]
      : []),
    ...(result.itemLimitNotice ? [`**Item limit:** ${result.itemLimitNotice}`] : []),
  ];

  if (result.resources.length === 0) {
    return [{ type: 'text', text: lines.join('\n') }];
  }

  lines.push('');
  for (const r of result.resources) {
    lines.push(`### ${singleLine(r.title ?? '(untitled)')}`);
    lines.push(`**Put-code:** ${r.putCode}`);
    if (r.hostOrganization) {
      const org = r.hostOrganization;
      const parts: string[] = [];
      if (org.name) parts.push(singleLine(org.name));
      if (org.city) parts.push(singleLine(org.city));
      if (org.country) parts.push(org.country);
      if (parts.length) lines.push(`**Host:** ${parts.join(', ')}`);
      if (org.disambiguatedId) {
        lines.push(
          `**Host ID:** ${singleLine(org.disambiguatedId)} (${singleLine(org.disambiguationSource ?? 'unknown source')})`,
        );
      }
    }
    if (r.startDate || r.endDate) {
      const period = [r.startDate, r.endDate].filter(Boolean).join(' – ');
      lines.push(`**Period:** ${period}`);
    }
    if (r.url) lines.push(`**URL:** ${singleLine(r.url)}`);
    if (r.externalIds.length) {
      const idParts = r.externalIds.map((id) => {
        const rel = id.relationship ? ` [${id.relationship}]` : '';
        const urlPart = id.url ? ` (${singleLine(id.url)})` : '';
        return `${id.type}:${singleLine(id.value)}${urlPart}${rel}`;
      });
      lines.push(`**IDs:** ${idParts.join(', ')}`);
    }
    const sources = sourcesText(r.sources);
    if (sources) lines.push(`**Sources:** ${sources}`);
    if (r.proposalHosts) {
      lines.push(`**Proposal hosts:** ${r.proposalHosts.length}`);
      r.proposalHosts.forEach((org, index) => {
        // The compatible Host/Host ID lines above already render the first host.
        if (index === 0 && JSON.stringify(org) === JSON.stringify(r.hostOrganization)) {
          if (!org.disambiguatedId && org.disambiguationSource)
            lines.push(`**Host ID source:** ${singleLine(org.disambiguationSource)}`);
          return;
        }
        lines.push(...renderOrganization(org, `Proposal host ${index + 1}`));
      });
    }
    if (r.items) {
      lines.push(
        `**Items:** ${r.returnedItemCount} / ${r.itemCount} | **Item offset:** ${r.itemOffset} | **Items truncated:** ${r.itemsTruncated}`,
      );
      if (r.nextItemOffset !== undefined) lines.push(`**Next item offset:** ${r.nextItemOffset}`);
      for (const item of r.items) {
        lines.push(`#### ${singleLine(item.name ?? '(unnamed)')}`);
        if (item.type) lines.push(`**Type:** ${singleLine(item.type)}`);
        lines.push(`**Item hosts:** ${item.hosts.length}`);
        item.hosts.forEach((org, index) => {
          lines.push(...renderOrganization(org, `Item host ${index + 1}`));
        });
        if (item.externalIds.length)
          lines.push(`**Item IDs:** ${renderIdentifiers(item.externalIds)}`);
        if (item.url) lines.push(`**Item URL:** ${singleLine(item.url)}`);
      }
    }
    lines.push('');
  }

  return [{ type: 'text', text: lines.join('\n') }];
}

/** Render every known organization field; an empty organization stays explicitly unknown. */
function renderOrganization(org: Organization, label: string): string[] {
  const parts = [org.name, org.city, org.country]
    .filter((value) => value !== undefined)
    .map(singleLine);
  const lines = [`**${label}:** ${parts.length ? parts.join(', ') : '(not recorded)'}`];
  if (org.disambiguatedId) lines.push(`**${label} ID:** ${singleLine(org.disambiguatedId)}`);
  if (org.disambiguationSource)
    lines.push(`**${label} ID source:** ${singleLine(org.disambiguationSource)}`);
  return lines;
}

/** Render complete deposited identifiers without allowing values to introduce new lines. */
function renderIdentifiers(ids: ExternalIdentifier[]): string {
  return ids
    .map(
      (id) =>
        `${singleLine(id.type)}:${singleLine(id.value)}${id.url ? ` (${singleLine(id.url)})` : ''}${id.relationship ? ` [${singleLine(id.relationship)}]` : ''}`,
    )
    .join(', ');
}
