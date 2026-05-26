/**
 * @fileoverview Fetch a researcher's public profile from ORCID: name, biography,
 * keywords, researcher URLs, and external identifiers (Scopus ID, ResearcherID, etc.).
 * @module mcp-server/tools/definitions/get-profile.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';

export const orcidGetProfile = tool('orcid_get_profile', {
  title: 'Get ORCID Researcher Profile',
  description:
    "Fetch a researcher's public profile from ORCID: name, biography, keywords, researcher URLs, and external identifiers such as Scopus Author ID, ResearcherID, and Loop profile. This is the entry point for building a researcher dossier. Pass a bare ORCID iD (0000-0001-2345-6789) or a full URI (https://orcid.org/0000-0001-2345-6789). The profile contains only publicly visible data — researchers control visibility per field.",
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    orcid_id: z
      .string()
      .min(1)
      .describe(
        'ORCID iD — bare format (0000-0001-2345-6789) or full URI (https://orcid.org/0000-0001-2345-6789).',
      ),
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format without URI prefix).'),
    orcidUri: z.string().describe('Full ORCID URI (https://orcid.org/{id}).'),
    givenNames: z.string().optional().describe('Given (first) name, if publicly visible.'),
    familyName: z.string().optional().describe('Family (last) name, if publicly visible.'),
    creditName: z.string().optional().describe('Published credit name, if set.'),
    biography: z.string().optional().describe('Researcher biography, if publicly visible.'),
    keywords: z
      .array(z.string().describe('Keyword term.'))
      .describe('Research keywords set by the researcher.'),
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
            type: z
              .string()
              .describe('Identifier type (e.g. Scopus Author ID, ResearcherID, Loop).'),
            value: z.string().describe('Identifier value.'),
            url: z.string().optional().describe('Resolver URL for this identifier, if provided.'),
            relationship: z.string().optional().describe('Relationship type (self or part-of).'),
          })
          .describe('External identifier linking to another scholarly system.'),
      )
      .describe(
        'External identifiers from scholarly systems (Scopus, Web of Science, Loop, etc.).',
      ),
    emails: z
      .array(
        z
          .object({
            email: z.string().describe('Email address.'),
            primary: z
              .boolean()
              .optional()
              .describe('True when this is the primary email address.'),
          })
          .describe('Email address entry.'),
      )
      .describe('Publicly visible email addresses.'),
    countries: z
      .array(z.string().describe('ISO 3166-1 alpha-2 country code.'))
      .describe("Countries listed in the researcher's address section."),
  }),

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
    ctx.log.info('orcid_get_profile', { orcidId: input.orcid_id });

    const person = await service.getPerson(input.orcid_id, ctx);
    const bareId = normalizeOrcidId(input.orcid_id);

    ctx.log.info('orcid_get_profile completed', {
      orcidId: bareId,
      hasName: !!(person.givenNames || person.familyName),
      keywordCount: person.keywords.length,
      externalIdCount: person.externalIdentifiers.length,
    });

    return {
      orcidId: bareId,
      orcidUri: `https://orcid.org/${bareId}`,
      ...(person.givenNames && { givenNames: person.givenNames }),
      ...(person.familyName && { familyName: person.familyName }),
      ...(person.creditName && { creditName: person.creditName }),
      ...(person.biography && { biography: person.biography }),
      keywords: person.keywords,
      researcherUrls: person.researcherUrls,
      externalIdentifiers: person.externalIdentifiers,
      emails: person.emails,
      countries: person.countries,
    };
  },

  format: (result) => {
    const lines: string[] = [`## ORCID Profile: ${result.orcidId}`];

    const nameParts = [result.givenNames, result.familyName].filter(Boolean);
    if (nameParts.length) lines.push(`**Name:** ${nameParts.join(' ')}`);
    if (result.creditName) lines.push(`**Credit Name:** ${result.creditName}`);
    lines.push(`**ORCID URI:** ${result.orcidUri}`);

    if (result.biography) {
      lines.push('', '### Biography', result.biography);
    }

    if (result.keywords.length) {
      lines.push('', `**Keywords:** ${result.keywords.join(', ')}`);
    }

    if (result.externalIdentifiers.length) {
      lines.push('', '### External Identifiers');
      for (const id of result.externalIdentifiers) {
        const rel = id.relationship ? ` [${id.relationship}]` : '';
        const line = `- **${id.type}:** ${id.value}${id.url ? ` (${id.url})` : ''}${rel}`;
        lines.push(line);
      }
    }

    if (result.researcherUrls.length) {
      lines.push('', '### Researcher URLs');
      for (const ru of result.researcherUrls) {
        lines.push(`- ${ru.name ? `**${ru.name}:** ` : ''}${ru.url}`);
      }
    }

    if (result.emails.length) {
      lines.push('', '### Emails');
      for (const e of result.emails) {
        lines.push(`- ${e.email}${e.primary ? ' (primary)' : ''}`);
      }
    }

    if (result.countries.length) {
      lines.push('', `**Countries:** ${result.countries.join(', ')}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
