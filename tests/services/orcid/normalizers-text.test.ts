/**
 * @fileoverview Free-text boundary of the works, funding, and research-resource normalizers
 * (#37): inline markup ORCID relays from depositing systems is stripped to plain text, while
 * unmarked text, identifiers, and the deposited citation pass through untouched. Fixture
 * strings are verbatim values from the live record 0000-0001-9161-999X.
 * @module tests/services/orcid/normalizers-text.test
 */

import { assert, describe, expect, it } from 'vitest';
import {
  normalizeBulkWorks,
  normalizeFundings,
  normalizeResearchResources,
  normalizeWorkDetail,
  normalizeWorks,
} from '@/services/orcid/normalizers.js';
import type { RawWorkDetail, RawWorkSummary } from '@/services/orcid/types.js';

/** Live title of put-code 215949395 — doubled spaces around the `<i>` pair. */
const IN_VIVO_TITLE = 'Amplified genome editing by  <i>in vivo</i>  editor production';
/** Live title of put-code 215949974 — a trailing `<i>` pair. */
const ARABIDOPSIS_TITLE =
  'Viral delivery of an RNA-guided genome editor for transgene-free germline editing in  <i>Arabidopsis</i>';
/** Live title of put-code 216781564 — a `<sup>` pair with no surrounding whitespace. */
const ISOTOPE_TITLE =
  "Attachment of a <sup>32</sup>P-phosphate to the 3' Terminus of a DNA Oligonucleotide.";
/** Live title of put-code 216781565 — an `<i>` pair closing directly against the full stop. */
const HERITABLE_TITLE =
  'Reactions to the National Academies/Royal Society Report on <i>Heritable Human Genome Editing</i>.';
/** Excerpt of the live abstract of put-code 211108320 — `<h4>` headings fused to prose. */
const H4_ABSTRACT =
  '<h4>Background</h4>Group I self-splicing introns can now be examined in detail.<h4>Results</h4>Heavy-atom derivatives reveal folding of the entire domain.<h4>Conclusions</h4>Bound at specific sites.';
/** Live deposited BibTeX of put-code 215949395, markup included. */
const IN_VIVO_BIBTEX =
  '@article{PPR:PPR1226445,\n\ttitle = {Amplified genome editing by  <i>in vivo</i>  editor production},\n\tauthor = {Ngo W and Doudna JA},\n\tdoi = {10.64898/2026.01.13.699115}\n}';

function summaryWith(fields: Partial<RawWorkSummary>) {
  return normalizeWorks({ group: [{ 'work-summary': [{ 'put-code': 1, ...fields }] }] })[0];
}

function detailWith(fields: Partial<RawWorkDetail>) {
  return normalizeWorkDetail({ 'put-code': 1, ...fields });
}

describe('work text boundary — unchanged behavior', () => {
  it('passes unmarked text through byte-identical, doubled and edge spaces included', () => {
    const unmarked = 'Cas9  specificity: 5′ ends & 3′ ends, a<b, x > y';
    const summary = summaryWith({
      title: { title: { value: unmarked } },
      'journal-title': { value: `  ${unmarked}` },
    });
    assert(summary);
    expect(summary.title).toBe(unmarked);
    expect(summary.journalTitle).toBe(`  ${unmarked}`);

    const detail = detailWith({
      title: { title: { value: unmarked }, subtitle: { value: unmarked } },
      'journal-title': { value: unmarked },
      'short-description': unmarked,
    });
    expect(detail.title).toBe(unmarked);
    expect(detail.subtitle).toBe(unmarked);
    expect(detail.journalTitle).toBe(unmarked);
    expect(detail.abstract).toBe(unmarked);
  });

  it('keeps the deposited citation value byte-identical, markup and all', () => {
    const detail = detailWith({
      title: { title: { value: IN_VIVO_TITLE } },
      citation: { 'citation-type': 'bibtex', 'citation-value': IN_VIVO_BIBTEX },
    });
    expect(detail.citation).toEqual({ type: 'bibtex', value: IN_VIVO_BIBTEX });
  });

  it('leaves an absent title, subtitle, journal, and abstract absent', () => {
    const summary = summaryWith({});
    assert(summary);
    expect(summary).not.toHaveProperty('title');
    expect(summary).not.toHaveProperty('journalTitle');

    const detail = detailWith({});
    for (const key of ['title', 'subtitle', 'journalTitle', 'abstract']) {
      expect(detail).not.toHaveProperty(key);
    }
  });

  it('leaves URLs and identifier values untouched', () => {
    const summary = summaryWith({
      url: { value: 'https://example.org/a?b=<i>&c=1' },
      'external-ids': {
        'external-id': [{ 'external-id-type': 'other-id', 'external-id-value': '<i>x</i>' }],
      },
    });
    assert(summary);
    expect(summary.url).toBe('https://example.org/a?b=<i>&c=1');
    expect(summary.externalIds[0]?.value).toBe('<i>x</i>');
  });
});

describe('work text boundary — markup is stripped to plain text', () => {
  it.each([
    [IN_VIVO_TITLE, 'Amplified genome editing by in vivo editor production'],
    [
      ARABIDOPSIS_TITLE,
      'Viral delivery of an RNA-guided genome editor for transgene-free germline editing in Arabidopsis',
    ],
    [ISOTOPE_TITLE, "Attachment of a 32P-phosphate to the 3' Terminus of a DNA Oligonucleotide."],
    [
      HERITABLE_TITLE,
      'Reactions to the National Academies/Royal Society Report on Heritable Human Genome Editing.',
    ],
  ])('cleans the work-summary title %j', (raw, expected) => {
    const summary = summaryWith({ title: { title: { value: raw } } });
    assert(summary);
    expect(summary.title).toBe(expected);
  });

  it('cleans the work-detail title, subtitle, and journal title', () => {
    const detail = detailWith({
      title: {
        title: { value: IN_VIVO_TITLE },
        subtitle: { value: 'in  <i>Arabidopsis</i> thaliana' },
      },
      'journal-title': { value: '<b>Nature</b>  <i>Chemical Biology</i>' },
    });
    expect(detail.title).toBe('Amplified genome editing by in vivo editor production');
    expect(detail.subtitle).toBe('in Arabidopsis thaliana');
    expect(detail.journalTitle).toBe('Nature Chemical Biology');
  });

  it('keeps a word boundary at every removed tag of the <h4> abstract', () => {
    const detail = detailWith({ 'short-description': H4_ABSTRACT });
    expect(detail.abstract).toBe(
      'Background Group I self-splicing introns can now be examined in detail. Results Heavy-atom derivatives reveal folding of the entire domain. Conclusions Bound at specific sites.',
    );
  });

  it('cleans titles reached through the bulk works endpoint, citation untouched', () => {
    const [entry] = normalizeBulkWorks({
      bulk: [
        {
          work: {
            'put-code': 215949395,
            title: { title: { value: IN_VIVO_TITLE } },
            citation: { 'citation-type': 'bibtex', 'citation-value': IN_VIVO_BIBTEX },
          },
        },
      ],
    });
    assert(entry?.type === 'work');
    expect(entry.detail.title).toBe('Amplified genome editing by in vivo editor production');
    expect(entry.detail.citation?.value).toBe(IN_VIVO_BIBTEX);
  });

  it('decodes entities exactly once', () => {
    const summary = summaryWith({
      title: { title: { value: 'Protein &amp; RNA: &amp;lt;tag&amp;gt; &#946;-sheet &#x3B1;' } },
    });
    assert(summary);
    expect(summary.title).toBe('Protein & RNA: &lt;tag&gt; β-sheet α');
  });

  it('drops a title that is nothing but markup rather than returning an empty string', () => {
    const summary = summaryWith({ title: { title: { value: '<i> </i>' } } });
    assert(summary);
    expect(summary).not.toHaveProperty('title');
  });

  it('cleans funding titles', () => {
    const [record] = normalizeFundings({
      group: [
        {
          'funding-summary': [
            { title: { title: { value: 'Editing  <i>in planta</i>  genomes' } } },
          ],
        },
      ],
    });
    assert(record);
    expect(record.title).toBe('Editing in planta genomes');
  });

  it('cleans research-resource titles', () => {
    const [resource] = normalizeResearchResources({
      group: [
        {
          'research-resource-summary': [
            {
              'put-code': 7001,
              proposal: { title: { title: { value: 'Cryo-EM of <i>E. coli</i> ribosomes' } } },
            },
          ],
        },
      ],
    });
    assert(resource);
    expect(resource.title).toBe('Cryo-EM of E. coli ribosomes');
  });
});
