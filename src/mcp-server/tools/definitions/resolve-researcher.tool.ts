/**
 * @fileoverview Disambiguate an author name to a verified ORCID iD. Returns a
 * ranked candidate list with transparent disambiguation signals: name match type,
 * institution overlap, and anchor type (doi/pmid/none).
 * @module mcp-server/tools/definitions/resolve-researcher.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOrcidService } from '@/services/orcid/orcid-service.js';
import type { ExpandedSearchResult } from '@/services/orcid/types.js';

/** Name match type based on how well the result name matches input. */
type NameMatchType = 'exact' | 'partial' | 'other-name' | 'none';

function computeNameMatch(candidate: ExpandedSearchResult, inputName: string): NameMatchType {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim();

  const normalizedInput = normalize(inputName);

  // Build full names from candidate
  const fullName = [candidate.givenNames, candidate.familyNames].filter(Boolean).join(' ');
  const creditName = candidate.creditName ?? '';

  if (normalize(fullName) === normalizedInput || normalize(creditName) === normalizedInput) {
    return 'exact';
  }

  const inputTokens = normalizedInput.split(/\s+/).filter(Boolean);
  const candidateTokens = normalize(fullName).split(/\s+/).filter(Boolean);
  const overlap = inputTokens.filter((t) => candidateTokens.includes(t));
  if (overlap.length >= Math.min(2, inputTokens.length)) {
    return 'partial';
  }

  // Check other-names
  for (const otherName of candidate.otherNames) {
    if (normalize(otherName) === normalizedInput) return 'other-name';
    const otherTokens = normalize(otherName).split(/\s+/).filter(Boolean);
    const otherOverlap = inputTokens.filter((t) => otherTokens.includes(t));
    if (otherOverlap.length >= Math.min(2, inputTokens.length)) return 'other-name';
  }

  return 'none';
}

function computeInstitutionOverlap(
  candidate: ExpandedSearchResult,
  inputAffiliation: string | undefined,
): boolean {
  if (!inputAffiliation?.trim()) return false;
  const normalizeAff = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const inputTokens = normalizeAff(inputAffiliation)
    .split(/\s+/)
    .filter((t) => t.length > 3); // skip short tokens (of, the, etc.)

  return candidate.institutionNames.some((inst) => {
    const instNorm = normalizeAff(inst);
    return inputTokens.some((t) => instNorm.includes(t));
  });
}

export const orcidResolveResearcher = tool('orcid_resolve_researcher', {
  title: 'Resolve ORCID Researcher',
  description:
    'Disambiguate an author name to a verified ORCID iD. Returns up to 5 ranked candidates with transparent disambiguation signals: name match type (exact/partial/other-name/none), institution overlap flag, and whether a DOI or PMID anchor was used in the query. A DOI or PMID anchor is near-deterministic — it filters to researchers who have linked that specific work to their ORCID record. Use this tool (not orcid_search_researchers) when the input is an ambiguous name that needs ranked disambiguation. No synthetic scores are used — raw signals only.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    name: z
      .string()
      .min(1)
      .describe(
        'Author name to disambiguate (full name preferred, e.g. "Jennifer Doudna" or "J. Doudna").',
      ),
    affiliation: z
      .string()
      .optional()
      .describe(
        "Researcher's institution or organization name. Used for institution overlap scoring and optionally as a search constraint.",
      ),
    doi: z
      .string()
      .optional()
      .describe(
        'DOI of a work authored by this researcher. Acts as a near-deterministic anchor — filters to researchers who linked this DOI to their ORCID record.',
      ),
    pmid: z
      .string()
      .optional()
      .describe(
        'PubMed ID of a work authored by this researcher. Acts as a near-deterministic anchor — filters to researchers who linked this PMID to their ORCID record.',
      ),
    rows: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe('Maximum candidate count to return (1–20). Defaults to 5.'),
  }),

  output: z.object({
    candidates: z
      .array(
        z
          .object({
            orcidId: z.string().describe('Candidate ORCID iD (bare format).'),
            orcidUri: z.string().describe('Full ORCID URI.'),
            givenNames: z.string().optional().describe('Given names from the ORCID record.'),
            familyNames: z.string().optional().describe('Family name from the ORCID record.'),
            creditName: z.string().optional().describe('Published credit name, if set.'),
            institutionNames: z
              .array(z.string().describe('Institution name.'))
              .describe('Affiliated institutions from the ORCID record.'),
            nameMatchType: z
              .enum(['exact', 'partial', 'other-name', 'none'])
              .describe(
                'How closely the candidate name matches the input name: exact (full match), partial (token overlap), other-name (match on alternate name), or none.',
              ),
            institutionOverlap: z
              .boolean()
              .describe(
                "True when at least one of the candidate's institutions matches tokens from the provided affiliation parameter.",
              ),
            anchorType: z
              .enum(['doi', 'pmid', 'none'])
              .describe(
                'Type of identifier anchor used in the query: doi, pmid, or none. A doi or pmid anchor means the candidate has linked that work to their ORCID record.',
              ),
          })
          .describe('Disambiguation candidate with transparency signals.'),
      )
      .describe('Ranked candidates, ordered by name match quality then institution overlap.'),
  }),

  // Agent-facing context: the queries used, total match count, and empty-result guidance.
  // Reaches both structuredContent and content[] without a format() entry.
  enrichment: {
    queryUsed: z.string().describe('Solr query sent to ORCID for the primary search.'),
    relaxedQuery: z
      .string()
      .optional()
      .describe(
        'Solr query used in a secondary relaxed search, if the primary returned no results.',
      ),
    totalFound: z.number().describe('Total ORCID records matching the primary query.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no candidates are found or when the anchor query failed to match.',
      ),
  },

  enrichmentTrailer: {
    queryUsed: { label: 'Query Used' },
    relaxedQuery: { label: 'Relaxed Query' },
    totalFound: { label: 'Total Found' },
  },

  async handler(input, ctx) {
    const service = getOrcidService();
    ctx.log.info('orcid_resolve_researcher', {
      name: input.name,
      hasAffiliation: !!input.affiliation,
      hasDoi: !!input.doi,
      hasPmid: !!input.pmid,
    });

    const anchorType: 'doi' | 'pmid' | 'none' = input.doi ? 'doi' : input.pmid ? 'pmid' : 'none';

    // Build primary query: name + optional anchor + optional affiliation
    const primaryClauses: string[] = [];
    primaryClauses.push(`given-and-family-names:"${input.name.trim()}"`);
    if (input.doi?.trim()) primaryClauses.push(`doi-self:${input.doi.trim()}`);
    if (input.pmid?.trim()) primaryClauses.push(`pmid-self:${input.pmid.trim()}`);
    if (input.affiliation?.trim()) {
      primaryClauses.push(`affiliation-org-name:"${input.affiliation.trim()}"`);
    }
    const primaryQuery = primaryClauses.join(' AND ');

    const primaryResponse = await service.expandedSearch(
      { q: primaryQuery, rows: input.rows },
      ctx,
    );

    let relaxedQuery: string | undefined;
    let finalResponse = primaryResponse;

    // Relaxed fallback: drop affiliation constraint if primary returned nothing
    if (primaryResponse.numFound === 0 && input.affiliation?.trim()) {
      const relaxedClauses = primaryClauses.filter((c) => !c.startsWith('affiliation-org-name:'));
      relaxedQuery = relaxedClauses.join(' AND ');
      finalResponse = await service.expandedSearch({ q: relaxedQuery, rows: input.rows }, ctx);
    }

    // Second relaxed pass: if DOI/PMID anchor + affiliation both failed, try just DOI/PMID anchor
    if (finalResponse.numFound === 0 && anchorType !== 'none') {
      const prefix = anchorType === 'doi' ? 'doi-self:' : 'pmid-self:';
      const anchorOnly = primaryClauses.find((c) => c.startsWith(prefix)) ?? '';
      relaxedQuery = anchorOnly;
      finalResponse = await service.expandedSearch({ q: anchorOnly, rows: input.rows }, ctx);
    }

    ctx.log.info('orcid_resolve_researcher completed', {
      primaryFound: primaryResponse.numFound,
      finalFound: finalResponse.numFound,
      candidateCount: finalResponse.results.length,
    });

    // Score and sort candidates
    const scored = finalResponse.results.map((r) => ({
      candidate: r,
      nameMatch: computeNameMatch(r, input.name),
      instOverlap: computeInstitutionOverlap(r, input.affiliation),
    }));

    // Sort: exact > partial > other-name > none, then institution overlap within each tier
    const matchOrder: NameMatchType[] = ['exact', 'partial', 'other-name', 'none'];
    scored.sort((a, b) => {
      const aOrder = matchOrder.indexOf(a.nameMatch);
      const bOrder = matchOrder.indexOf(b.nameMatch);
      if (aOrder !== bOrder) return aOrder - bOrder;
      // Within same tier, institution overlap comes first
      if (a.instOverlap !== b.instOverlap) return a.instOverlap ? -1 : 1;
      return 0;
    });

    const candidates = scored.map(({ candidate, nameMatch, instOverlap }) => ({
      orcidId: candidate.orcidId,
      orcidUri: `https://orcid.org/${candidate.orcidId}`,
      ...(candidate.givenNames && { givenNames: candidate.givenNames }),
      ...(candidate.familyNames && { familyNames: candidate.familyNames }),
      ...(candidate.creditName && { creditName: candidate.creditName }),
      institutionNames: candidate.institutionNames,
      nameMatchType: nameMatch,
      institutionOverlap: instOverlap,
      anchorType,
    }));

    ctx.enrich({ queryUsed: primaryQuery, totalFound: finalResponse.numFound });
    if (relaxedQuery) ctx.enrich({ relaxedQuery });

    if (candidates.length === 0) {
      if (anchorType !== 'none') {
        ctx.enrich.notice(
          `No ORCID records found matching "${input.name}" with the provided ${anchorType.toUpperCase()} anchor. Verify the ${anchorType.toUpperCase()} is correct or try without the anchor using orcid_search_researchers.`,
        );
      } else {
        ctx.enrich.notice(
          `No ORCID records found matching "${input.name}". Try a different spelling or use orcid_search_researchers with a broader query.`,
        );
      }
    }

    return { candidates };
  },

  format: (result) => {
    const lines: string[] = [`## ORCID Disambiguation Results`];

    if (result.candidates.length === 0) {
      lines.push('', 'No candidates found.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('', `**Candidates (${result.candidates.length}):**`);
    result.candidates.forEach((c, i) => {
      const nameParts = [c.givenNames, c.familyNames].filter(Boolean);
      const displayName = c.creditName ?? (nameParts.length ? nameParts.join(' ') : c.orcidId);
      lines.push('');
      lines.push(`### ${i + 1}. ${displayName}`);
      lines.push(`**ORCID iD:** ${c.orcidId}`);
      lines.push(`**ORCID URI:** ${c.orcidUri}`);
      if (c.givenNames) lines.push(`**Given Names:** ${c.givenNames}`);
      if (c.familyNames) lines.push(`**Family Names:** ${c.familyNames}`);
      if (c.creditName) lines.push(`**Credit Name:** ${c.creditName}`);
      lines.push(`**Name Match:** ${c.nameMatchType}`);
      lines.push(`**Institution Overlap:** ${c.institutionOverlap ? 'Yes' : 'No'}`);
      lines.push(`**Anchor Type:** ${c.anchorType}`);
      if (c.institutionNames.length) {
        lines.push(`**Institutions:** ${c.institutionNames.join('; ')}`);
      }
    });

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
