/**
 * @fileoverview Fetch a researcher's public profile from ORCID: name, other names,
 * biography, keywords, researcher URLs, and external identifiers (Scopus ID,
 * ResearcherID, etc.).
 * @module mcp-server/tools/definitions/get-profile.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { blockquote, singleLine } from '@/mcp-server/tools/third-party-text.js';
import type { NormalizedPerson } from '@/services/orcid/normalizers.js';
import { orcidIdSchema } from '@/services/orcid/orcid-id.js';
import { getOrcidService, normalizeOrcidId } from '@/services/orcid/orcid-service.js';

/** Joins the empty-section labels as an English "or" list: `a, b, or c`. */
const orList = new Intl.ListFormat('en', { type: 'disjunction' });

export const orcidGetProfile = tool('orcid_get_profile', {
  title: 'Get ORCID Researcher Profile',
  description:
    "Fetch a researcher's public profile from ORCID: name, other names, biography, keywords, researcher URLs, and external identifiers such as Scopus Author ID, ResearcherID, and Loop profile. This is the entry point for building a researcher dossier. Pass a bare ORCID iD (0000-0001-2345-6789) or a full URI (https://orcid.org/0000-0001-2345-6789). The profile contains only publicly visible data — researchers control visibility per field.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    orcid_id: orcidIdSchema,
  }),

  output: z.object({
    orcidId: z.string().describe('Normalized ORCID iD (bare format without URI prefix).'),
    orcidUri: z.string().describe('Full ORCID URI (https://orcid.org/{id}).'),
    givenNames: z.string().optional().describe('Given (first) name, if publicly visible.'),
    familyName: z.string().optional().describe('Family (last) name, if publicly visible.'),
    creditName: z.string().optional().describe('Published credit name, if set.'),
    otherNames: z
      .array(z.string().describe('Alternative name.'))
      .describe('Other names listed on the ORCID record.'),
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

  // Agent-facing context: names the empty sections on both surfaces, since format()
  // renders only the sections that carry data.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Names the profile sections with no public data — ORCID visibility is set per field, so an empty section may be private.',
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
    ctx.log.info('orcid_get_profile', { orcidId: input.orcid_id });

    let person: NormalizedPerson;
    try {
      person = await service.getPerson(input.orcid_id, ctx);
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

    ctx.log.info('orcid_get_profile completed', {
      orcidId: bareId,
      hasName: !!(person.givenNames || person.familyName),
      keywordCount: person.keywords.length,
      externalIdCount: person.externalIdentifiers.length,
    });

    const sections: [label: string, isEmpty: boolean][] = [
      ['name', !person.givenNames && !person.familyName && !person.creditName],
      ['other names', person.otherNames.length === 0],
      ['biography', !person.biography],
      ['keywords', person.keywords.length === 0],
      ['researcher URLs', person.researcherUrls.length === 0],
      ['external identifiers', person.externalIdentifiers.length === 0],
      ['email addresses', person.emails.length === 0],
      ['countries', person.countries.length === 0],
    ];
    const emptySections = sections.filter(([, isEmpty]) => isEmpty).map(([label]) => label);
    if (emptySections.length) {
      ctx.enrich.notice(
        `This profile has no public ${orList.format(emptySections)}. Researchers set ORCID visibility per field, so a section can be private rather than empty.`,
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
      externalIdentifiers: person.externalIdentifiers,
      emails: person.emails,
      countries: person.countries,
    };
  },

  format: (result) => {
    const lines: string[] = [`## ORCID Profile: ${result.orcidId}`];

    const nameParts = [result.givenNames, result.familyName].filter(Boolean);
    if (nameParts.length) lines.push(`**Name:** ${singleLine(nameParts.join(' '))}`);
    if (result.creditName) lines.push(`**Credit Name:** ${singleLine(result.creditName)}`);
    if (result.otherNames.length) {
      lines.push(`**Other Names:** ${result.otherNames.map(singleLine).join(', ')}`);
    }
    lines.push(`**ORCID URI:** ${result.orcidUri}`);

    if (result.biography) {
      lines.push('', '### Biography', blockquote(result.biography));
    }

    if (result.keywords.length) {
      lines.push('', `**Keywords:** ${result.keywords.map(singleLine).join(', ')}`);
    }

    if (result.externalIdentifiers.length) {
      lines.push('', '### External Identifiers');
      for (const id of result.externalIdentifiers) {
        const rel = id.relationship ? ` [${id.relationship}]` : '';
        const url = id.url ? ` (${singleLine(id.url)})` : '';
        lines.push(`- **${singleLine(id.type)}:** ${singleLine(id.value)}${url}${rel}`);
      }
    }

    if (result.researcherUrls.length) {
      lines.push('', '### Researcher URLs');
      for (const ru of result.researcherUrls) {
        lines.push(`- ${ru.name ? `**${singleLine(ru.name)}:** ` : ''}${singleLine(ru.url)}`);
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
