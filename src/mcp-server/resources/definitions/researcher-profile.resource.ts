/**
 * @fileoverview Resource for injecting a researcher's ORCID profile (person section)
 * as stable inline context into prompts. Use when the agent needs a researcher's
 * identity data without conditional logic over the result.
 * @module mcp-server/resources/definitions/researcher-profile.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { invalidParams, JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import type { NormalizedPerson } from '@/services/orcid/normalizers.js';
import { isValidOrcidId, orcidIdParamSchema } from '@/services/orcid/orcid-id.js';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';

export const researcherProfileResource = resource('orcid://researcher/{orcid_id}/profile', {
  name: 'orcid-researcher-profile',
  description:
    'Researcher profile (person section) from ORCID: name, biography, keywords, researcher URLs, and external identifiers. Use when injecting researcher identity context into a prompt or checking for a specific external ID (e.g., Scopus ID for cross-server chaining). Prefer the orcid_get_profile tool when the response needs to flow into conditional logic.',
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
    biography: z.string().optional().describe('Researcher biography, if publicly visible.'),
    keywords: z.array(z.string().describe('Keyword.')).describe('Research keywords.'),
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

  async handler(params, ctx) {
    // Reject a checksum-invalid iD locally, before any upstream call — mirrors the
    // tool route's InvalidParams. The regex-only param schema matched the shape; the
    // ISO 7064 check digit is verified here.
    if (!isValidOrcidId(params.orcid_id)) {
      throw invalidParams(
        `The ORCID iD ${params.orcid_id} is invalid — its ISO 7064 check digit does not match. Verify the iD and try again.`,
      );
    }

    const service = getOrcidService();
    const bareId = normalizeOrcidId(params.orcid_id);

    ctx.log.debug('orcid-researcher-profile resource', { orcidId: bareId });

    // Catch the upstream 404 here so the framework doesn't serialize McpError.data
    // (the raw ORCID URL + error body) into the JSON-RPC error sent to the client.
    let person: NormalizedPerson;
    try {
      person = await service.getPerson(params.orcid_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw notFound(`No public profile found for ORCID iD ${bareId}.`, undefined, {
          cause: err,
        });
      }
      throw err;
    }

    if (!person.givenNames && !person.familyName && !person.creditName) {
      throw notFound(
        `No public profile found for ORCID iD ${bareId}. The record may not exist or may be fully private.`,
      );
    }

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      ...(person.givenNames && { givenNames: person.givenNames }),
      ...(person.familyName && { familyName: person.familyName }),
      ...(person.creditName && { creditName: person.creditName }),
      ...(person.biography && { biography: person.biography }),
      keywords: person.keywords,
      externalIdentifiers: person.externalIdentifiers.map((id) => ({
        type: id.type,
        value: id.value,
        ...(id.url && { url: id.url }),
      })),
    };
  },
});
