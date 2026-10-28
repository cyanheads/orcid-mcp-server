/**
 * @fileoverview The notice every record tool composes when ORCID serves a deprecated iD from
 * its primary record.
 * @module tests/tools/deprecated-id-notice.test
 */

import { describe, expect, it } from 'vitest';
import { deprecatedIdNotice } from '@/mcp-server/tools/deprecated-id-notice.js';

describe('deprecatedIdNotice', () => {
  it('is empty when the record was served under the requested iD', () => {
    expect(deprecatedIdNotice('0000-0002-1825-0097', '0000-0002-1825-0097')).toBe('');
  });

  it('names the deprecated iD and the primary iD that replaces it', () => {
    expect(deprecatedIdNotice('0000-0002-7759-8499', '0000-0001-8143-9338')).toBe(
      'ORCID iD 0000-0002-7759-8499 is deprecated: ORCID merged it into 0000-0001-8143-9338, and this response reports that primary record. Use 0000-0001-8143-9338 in later calls.',
    );
  });
});
