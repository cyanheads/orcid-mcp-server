/**
 * @fileoverview Resource for injecting a researcher's ORCID profile (person section)
 * as stable inline context into prompts. Use when the agent needs a researcher's
 * identity data without conditional logic over the result.
 * @module mcp-server/resources/definitions/researcher-profile.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { NormalizedPerson } from '@/services/orcid/normalizers.js';
import { isValidOrcidId, orcidIdParamSchema } from '@/services/orcid/orcid-id.js';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';

export const researcherProfileResource = resource('orcid://researcher/{orcid_id}/profile', {
  name: 'orcid-researcher-profile',
  description:
    'Researcher profile (person section) from ORCID: name, other names, biography, keywords, researcher URLs, and external identifiers. Use when injecting researcher identity context into a prompt or checking for a specific external ID (e.g., Scopus ID for cross-server chaining). Prefer the orcid_get_profile tool when the response needs to flow into conditional logic.',
  mimeType: 'application/json',

  params: z.object({
    orcid_id: orcidIdParamSchema,
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format).'),
    orcidUri: z.string().describe('Full ORCID URI.'),
    givenNames: z.string().optional().describe('Given names, if publicly visible.'),
    familyName: z.string().optional().describe('Family name, if publicly visible.'),
    creditName: z.string().optional().describe('Published credit name, if set.'),
    otherNames: z
      .array(z.string().describe('Alternative name.'))
      .describe('Other names listed on the ORCID record.'),
    biography: z.string().optional().describe('Researcher biography, if publicly visible.'),
    keywords: z.array(z.string().describe('Keyword.')).describe('Research keywords.'),
    researcherUrls: z
      .array(
        z
          .object({
            name: z.string().optional().describe('Label for this URL.'),
            url: z.string().describe('URL value.'),
          })
          .describe('Researcher URL entry.'),
      )
      .describe('Researcher-provided URLs (personal site, lab page, blog, etc.).'),
    externalIdentifiers: z
      .array(
        z
          .object({
            type: z.string().describe('Identifier type.'),
            value: z.string().describe('Identifier value.'),
            url: z.string().optional().describe('Resolver URL.'),
          })
          .describe('External identifier.'),
      )
      .describe('External scholarly identifiers (Scopus, ResearcherID, Loop, etc.).'),
  }),

  errors: [
    {
      reason: 'invalid_orcid_id',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The ORCID iD fails its ISO 7064 check digit; rejected before any upstream call.',
      recovery:
        'Check the ORCID iD for a mistyped digit — the last character is a checksum of the first 15 digits.',
    },
    {
      reason: 'profile_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'ORCID has no record for the iD, or its person section has no public name.',
      recovery: 'Verify the ORCID iD or use orcid_search_researchers to find a public record.',
    },
  ],

  async handler(params, ctx) {
    // Reject a checksum-invalid iD locally, before any upstream call — mirrors the
    // tool route's InvalidParams. The regex-only param schema matched the shape; the
    // ISO 7064 check digit is verified here, on the canonical (uppercase-X) iD.
    const bareId = normalizeOrcidId(params.orcid_id);
    if (!isValidOrcidId(bareId)) {
      throw ctx.fail(
        'invalid_orcid_id',
        `The ORCID iD ${bareId} is invalid — its ISO 7064 check digit does not match. Verify the iD and try again.`,
      );
    }

    const service = getOrcidService();

    ctx.log.debug('orcid-researcher-profile resource', { orcidId: bareId });

    // Remap the upstream 404 to a NotFound that names the iD, so the client gets a
    // resource-level message rather than the HTTP status details on McpError.data.
    let person: NormalizedPerson;
    try {
      person = await service.getPerson(bareId, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'profile_not_found',
          `No public profile found for ORCID iD ${bareId}.`,
          undefined,
          { cause: err },
        );
      }
      throw err;
    }

    if (!person.givenNames && !person.familyName && !person.creditName) {
      throw ctx.fail(
        'profile_not_found',
        `No public profile found for ORCID iD ${bareId}. The record may not exist or may be fully private.`,
      );
    }

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      ...(person.givenNames && { givenNames: person.givenNames }),
      ...(person.familyName && { familyName: person.familyName }),
      ...(person.creditName && { creditName: person.creditName }),
      otherNames: person.otherNames,
      ...(person.biography && { biography: person.biography }),
      keywords: person.keywords,
      researcherUrls: person.researcherUrls,
      externalIdentifiers: person.externalIdentifiers.map((id) => ({
        type: id.type,
        value: id.value,
        ...(id.url && { url: id.url }),
      })),
    };
  },
});
