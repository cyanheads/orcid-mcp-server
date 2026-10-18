/**
 * @fileoverview Shared search and resolver identifier input regressions.
 * @module tests/tools/identifier-validation.tool.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { orcidResolveResearcher } from '@/mcp-server/tools/definitions/resolve-researcher.tool.js';
import { orcidSearchResearchers } from '@/mcp-server/tools/definitions/search-researchers.tool.js';
import { DOI_INPUT_PATTERN, PMID_INPUT_PATTERN } from '@/services/orcid/solr-query.js';

const expandedSearch = vi.fn(async () => ({ numFound: 0, results: [] }));
vi.mock('@/services/orcid/orcid-service.js', () => ({
  getOrcidService: () => ({ expandedSearch }),
}));

describe.each([orcidSearchResearchers, orcidResolveResearcher])(
  '$name identifier validation',
  (definition) => {
    it.each([{ doi: 'https://doi.org/' }, { pmid: '123 OR y' }])(
      'returns invalid_arguments and field recovery on both surfaces for %j',
      async (anchors) => {
        expandedSearch.mockClear();
        const identity =
          definition.name === 'orcid_search_researchers'
            ? { family_name: 'Roe' }
            : { name: 'Jane Roe' };
        const result = await runToolContract(definition, { ...identity, ...anchors });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            data: {
              reason: 'invalid_arguments',
              recovery: { hint: expect.stringContaining(Object.keys(anchors)[0]!) },
            },
          },
        });
        expect(JSON.stringify(result.content)).toContain(Object.keys(anchors)[0]!);
        expect(expandedSearch).not.toHaveBeenCalled();
      },
    );
    it('advertises the same flagless identifier grammar in JSON Schema', () => {
      const properties = z.toJSONSchema(definition.input).properties!;
      for (const [field, pattern] of [
        ['doi', DOI_INPUT_PATTERN],
        ['pmid', PMID_INPUT_PATTERN],
      ] as const) {
        expect(pattern.flags).toBe('');
        expect(properties[field]).toMatchObject({ pattern: pattern.source });
        const advertised = new RegExp(pattern.source);
        expect(
          advertised.test(
            field === 'doi'
              ? ' HTTPS://DX.DOI.ORG/10.1/Case '
              : ' HTTPS://PUBMED.NCBI.NLM.NIH.GOV/123/?x=y ',
          ),
        ).toBe(true);
        expect(advertised.test(field === 'doi' ? 'doi:' : 'PMID:')).toBe(false);
      }
    });
    it.each([
      { doi: 'https://doi.org/' },
      { doi: '10.123' },
      { doi: '10.1/x OR y' },
      { pmid: 'not-a-pmid' },
      { pmid: 'PMID:' },
    ])('rejects malformed nonblank anchor %j beside a name', (anchors) => {
      const identity =
        definition.name === 'orcid_search_researchers'
          ? { family_name: 'Roe' }
          : { name: 'Jane Roe' };
      expect(definition.input.safeParse({ ...identity, ...anchors }).success).toBe(false);
    });
    it('characterizes valid mixed-case identifiers and genuinely blank optional inputs', () => {
      for (const anchors of [
        { doi: ' HTTPS://DX.DOI.ORG/10.1/Case ' },
        { pmid: 'PMID: 123/?a=b' },
        { pmid: 'PMID: 123 \t?query=x' },
        { pmid: 'PMID: 123 \t/\n' },
        { doi: ' \n ', pmid: '' },
      ]) {
        const identity =
          definition.name === 'orcid_search_researchers'
            ? { family_name: 'Roe' }
            : { name: 'Jane Roe' };
        expect(definition.input.safeParse({ ...identity, ...anchors }).success).toBe(true);
      }
    });
  },
);
