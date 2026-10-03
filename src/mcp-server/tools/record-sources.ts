/**
 * @fileoverview Output schema and Markdown rendering for `sources` — who asserted an
 * activity item on an ORCID record — shared by the six activity tools.
 * @module mcp-server/tools/record-sources
 */

import { z } from '@cyanheads/mcp-ts-core';
import { singleLine } from '@/mcp-server/tools/third-party-text.js';

/** One party that put an item on the ORCID record. */
export const SourceSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        'Name of the person or member organization system that added the item (e.g. a university research information system, Crossref, Scopus - Elsevier). Absent when ORCID records no name.',
      ),
    assertionOriginName: z
      .string()
      .optional()
      .describe(
        'Party the source added the item on behalf of, when ORCID records one — usually the researcher, for an item added through a search-and-link tool.',
      ),
    selfAsserted: z
      .boolean()
      .describe(
        'True when the asserting party (the assertion origin when recorded, otherwise the source) is the requested ORCID iD; false when a member organization or another ORCID user asserted the item.',
      ),
  })
  .describe('A party that asserted this item on the ORCID record.');

type Source = z.infer<typeof SourceSchema>;

/**
 * A record's sources as one line of text — each `<origin> via <source>`, or the source alone,
 * marked `(self-asserted)` when the researcher asserted it — or undefined when ORCID
 * recorded no source. Names are flattened to one line. Each tool adds its own label in its
 * own line style.
 */
export function sourcesText(sources: readonly Source[]): string | undefined {
  if (sources.length === 0) return;
  return sources
    .map((s) => {
      const name = singleLine(s.name ?? '(unnamed source)');
      const party = s.assertionOriginName
        ? `${singleLine(s.assertionOriginName)} via ${name}`
        : name;
      return s.selfAsserted ? `${party} (self-asserted)` : party;
    })
    .join('; ');
}
