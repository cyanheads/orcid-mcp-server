/**
 * @fileoverview Tests for the shared ORCID iD parser/validator — ISO 7064 MOD 11-2
 * checksum verification, URI normalization, and the reusable Zod schema.
 * @module tests/services/orcid/orcid-id.test
 */

import { describe, expect, it } from 'vitest';
import { isValidOrcidId, normalizeOrcidId, orcidIdSchema } from '@/services/orcid/orcid-id.js';

describe('normalizeOrcidId', () => {
  it('strips the https://orcid.org/ prefix', () => {
    expect(normalizeOrcidId('https://orcid.org/0000-0002-1825-0097')).toBe('0000-0002-1825-0097');
    expect(normalizeOrcidId('http://orcid.org/0000-0002-1825-0097')).toBe('0000-0002-1825-0097');
  });

  it('returns a bare iD unchanged', () => {
    expect(normalizeOrcidId('0000-0002-1825-0097')).toBe('0000-0002-1825-0097');
  });
});

describe('isValidOrcidId', () => {
  it('accepts iDs with a correct ISO 7064 check digit', () => {
    expect(isValidOrcidId('0000-0002-1825-0097')).toBe(true);
    expect(isValidOrcidId('0000-0001-9161-999X')).toBe(true); // X = check digit 10
    expect(isValidOrcidId('0000-0002-9079-593X')).toBe(true);
    expect(isValidOrcidId('0000-0000-0000-0001')).toBe(true); // valid form of the all-zeros base
  });

  it('accepts the full-URI form', () => {
    expect(isValidOrcidId('https://orcid.org/0000-0002-1825-0097')).toBe(true);
  });

  it('rejects a well-shaped iD with an invalid check digit', () => {
    // The correct check digit for the all-zeros base is 1, not 0.
    expect(isValidOrcidId('0000-0000-0000-0000')).toBe(false);
    expect(isValidOrcidId('0000-0001-9522-8779')).toBe(false);
    expect(isValidOrcidId('0000-0001-5109-344X')).toBe(false);
  });

  it('rejects malformed strings', () => {
    expect(isValidOrcidId('not-a-valid-orcid')).toBe(false);
    expect(isValidOrcidId('0000-00001-9522-8779')).toBe(false);
    expect(isValidOrcidId('')).toBe(false);
  });
});

describe('orcidIdSchema', () => {
  it('parses a valid ORCID iD in bare and URI forms', () => {
    expect(orcidIdSchema.parse('0000-0002-1825-0097')).toBe('0000-0002-1825-0097');
    expect(orcidIdSchema.parse('https://orcid.org/0000-0002-1825-0097')).toBe(
      'https://orcid.org/0000-0002-1825-0097',
    );
    expect(orcidIdSchema.parse('0000-0001-9161-999X')).toBe('0000-0001-9161-999X');
  });

  it('rejects a checksum-invalid iD with an actionable message', () => {
    expect(() => orcidIdSchema.parse('0000-0000-0000-0000')).toThrow();

    const result = orcidIdSchema.safeParse('0000-0000-0000-0000');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('invalid');
    }
  });

  it('rejects malformed strings', () => {
    expect(() => orcidIdSchema.parse('not-a-valid-orcid')).toThrow();
    expect(() => orcidIdSchema.parse('')).toThrow();
  });
});
