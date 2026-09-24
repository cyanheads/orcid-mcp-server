/**
 * @fileoverview End-to-end coverage of the plain-text boundary (#37): upstream text with
 * inline markup is faked at the `fetch` boundary, so the real service and normalizers run,
 * and every surface that reads it — the works, work-detail, funding, and research-resource
 * tools on both result surfaces, plus the works resource — is checked for clean text. The
 * deposited citation is the one field relayed verbatim.
 * @module tests/integration/markup-text.int.test
 */

import type { FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { researcherWorksResource } from '@/mcp-server/resources/definitions/researcher-works.resource.js';
import { orcidGetFunding } from '@/mcp-server/tools/definitions/get-funding.tool.js';
import { orcidGetResearchResources } from '@/mcp-server/tools/definitions/get-research-resources.tool.js';
import { orcidGetWorkDetail } from '@/mcp-server/tools/definitions/get-work-detail.tool.js';
import { orcidGetWorks } from '@/mcp-server/tools/definitions/get-works.tool.js';
import {
  createOrcidFetchMock,
  initOrcidServiceForTests,
  MARKUP_BIBTEX,
  MARKUP_ID,
} from './orcid-api-fixtures.js';

const CLEAN_TITLE = 'Amplified genome editing by in vivo editor production';

let http: FetchMockHarness;

beforeAll(() => {
  http = createOrcidFetchMock();
  http.install();
  initOrcidServiceForTests();
});

afterAll(() => {
  http.restore();
});

const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((block) => block.text ?? '').join('');

describe('markup in ORCID free text', () => {
  it('orcid_get_works returns the cleaned title and journal on both surfaces', async () => {
    const result = await runToolContract(orcidGetWorks, { orcid_id: MARKUP_ID });
    const [work] = (
      result.structuredContent as { works: { title?: string; journalTitle?: string }[] }
    ).works;

    expect(work?.title).toBe(CLEAN_TITLE);
    expect(work?.journalTitle).toBe('bioRxiv');
    const text = textOf(result);
    expect(text).toContain(`### ${CLEAN_TITLE}`);
    expect(text).toContain('**Journal:** bioRxiv');
    expect(text).not.toMatch(/<\/?i>/);
  });

  it('orcid_get_work_detail cleans the title, subtitle, and abstract but not the citation', async () => {
    const result = await runToolContract(orcidGetWorkDetail, {
      orcid_id: MARKUP_ID,
      put_codes: [215_949_395],
    });
    const [work] = (
      result.structuredContent as {
        works: {
          title?: string;
          subtitle?: string;
          abstract?: string;
          citation?: { value: string };
        }[];
      }
    ).works;

    expect(work?.title).toBe(CLEAN_TITLE);
    expect(work?.subtitle).toBe('in Arabidopsis');
    expect(work?.abstract).toBe('Background Group I introns. Results Heavy atoms.');
    expect(work?.citation?.value).toBe(MARKUP_BIBTEX);

    const text = textOf(result);
    expect(text).toContain(`## ${CLEAN_TITLE}`);
    expect(text).toContain('**Subtitle:** in Arabidopsis');
    expect(text).toContain('**Abstract:** Background Group I introns. Results Heavy atoms.');
    // The citation renders verbatim inside its fenced block — the only markup left.
    expect(text).toContain(`\`\`\`\n${MARKUP_BIBTEX}\n\`\`\``);
    expect(text.replace(MARKUP_BIBTEX, '')).not.toMatch(/<\/?(i|h4)>/);
  });

  it('orcid_get_funding returns the cleaned title on both surfaces', async () => {
    const result = await runToolContract(orcidGetFunding, { orcid_id: MARKUP_ID });
    const [record] = (result.structuredContent as { funding: { title?: string }[] }).funding;

    expect(record?.title).toBe('Editing in planta');
    expect(textOf(result)).toContain('### Editing in planta');
    expect(textOf(result)).not.toContain('<i>');
  });

  it('orcid_get_research_resources returns the cleaned title on both surfaces', async () => {
    const result = await runToolContract(orcidGetResearchResources, { orcid_id: MARKUP_ID });
    const [resource] = (result.structuredContent as { resources: { title?: string }[] }).resources;

    expect(resource?.title).toBe('Cryo-EM of E. coli');
    expect(textOf(result)).toContain('### Cryo-EM of E. coli');
    expect(textOf(result)).not.toContain('<i>');
  });

  it('the works resource returns the cleaned title', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = researcherWorksResource.params!.parse({ orcid_id: MARKUP_ID });
    const result = await researcherWorksResource.handler(params, ctx);

    expect(result.works[0]?.title).toBe(CLEAN_TITLE);
    expect(result.works[0]?.journalTitle).toBe('bioRxiv');
  });
});
