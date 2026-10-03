/**
 * @fileoverview Tests for the shared ORCID iD parser/validator — ISO 7064 MOD 11-2
 * checksum verification, URI normalization, and the reusable Zod schema.
 * @module tests/services/orcid/orcid-id.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  isValidOrcidId,
  normalizeOrcidId,
  orcidIdParamSchema,
  orcidIdSchema,
} from '@/services/orcid/orcid-id.js';

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

/** Every caller form that names `0000-0001-9161-999X` (#57). */
const ACCEPTED_FORMS = [
  '0000-0001-9161-999X',
  '0000-0001-9161-999x',
  'orcid.org/0000-0001-9161-999X',
  'https://orcid.org/0000-0001-9161-999X',
  'http://orcid.org/0000-0001-9161-999X',
  'https://www.orcid.org/0000-0001-9161-999X',
  'www.orcid.org/0000-0001-9161-999x',
  'https://orcid.org/0000-0001-9161-999X/',
  '0000-0001-9161-999x/',
];

const SHAPE_MESSAGE = 'Must be a valid ORCID iD (e.g. 0000-0001-2345-6789) or full ORCID URI.';
const CHECKSUM_MESSAGE =
  'The ORCID iD is invalid — its ISO 7064 check digit does not match. Verify the iD and try again.';

/** The messages of every issue a parse reports, in order. */
function issueMessages(value: string): string[] {
  const result = orcidIdSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('ORCID iD caller forms (#57)', () => {
  it.each([...ACCEPTED_FORMS, ' 0000-0001-9161-999X '])(
    'normalizes %j to the bare iD with an uppercase check digit',
    (form) => {
      expect(normalizeOrcidId(form)).toBe('0000-0001-9161-999X');
    },
  );

  it.each([...ACCEPTED_FORMS, ' 0000-0001-9161-999X '])('orcidIdSchema accepts %j', (form) => {
    const parsed = orcidIdSchema.parse(form);
    expect(normalizeOrcidId(parsed)).toBe('0000-0001-9161-999X');
    expect(isValidOrcidId(parsed)).toBe(true);
  });

  it('trims surrounding whitespace in the parsed value', () => {
    expect(orcidIdSchema.parse('  https://orcid.org/0000-0001-9161-999X\t')).toBe(
      'https://orcid.org/0000-0001-9161-999X',
    );
  });

  it.each(['0000-0000-0000-0000', '0000-0002-1825-009x', 'https://orcid.org/0000-0000-0000-0000'])(
    'reports only the checksum message for well-shaped %j',
    (value) => {
      expect(issueMessages(value)).toEqual([CHECKSUM_MESSAGE]);
    },
  );

  it.each([
    'not-an-orcid',
    '',
    '   ',
    '000000019161999X',
    'HTTPS://ORCID.ORG/0000-0001-9161-999X',
    'https://orcid.org/0000-0001-9161-999X?x=1',
    'https://example.org/0000-0001-9161-999X',
    'https://orcid.org//0000-0001-9161-999X',
  ])('reports only the shape message for %j', (value) => {
    expect(issueMessages(value)).toEqual([SHAPE_MESSAGE]);
  });

  it('advertises a flag-free JSON Schema pattern that admits every accepted form', () => {
    const jsonSchema = z.toJSONSchema(orcidIdSchema) as { pattern?: string };
    expect(jsonSchema.pattern).toBe(
      '^(?:(?:https?:\\/\\/)?(?:www\\.)?orcid\\.org\\/)?\\d{4}-\\d{4}-\\d{4}-\\d{3}[\\dXx]\\/?$',
    );
    const pattern = new RegExp(jsonSchema.pattern ?? '');
    for (const form of ACCEPTED_FORMS) expect(pattern.test(form)).toBe(true);
    expect(pattern.test('000000019161999X')).toBe(false);
  });
});

describe('ORCID iD grammar cost', () => {
  /** Thread CPU time, in microseconds, of `reps` validate-and-normalize passes over `value`. */
  function cpuMicros(value: string, reps: number): number {
    const start = process.threadCpuUsage();
    for (let i = 0; i < reps; i++) {
      orcidIdSchema.safeParse(value);
      normalizeOrcidId(value);
    }
    const used = process.threadCpuUsage(start);
    return used.user + used.system;
  }

  it.each([
    ['repeated scheme openers', (n: number) => 'https://www.'.repeat(n / 12)],
    ['repeated host prefixes', (n: number) => 'orcid.org/'.repeat(n / 10)],
    ['overlapping digit groups', (n: number) => '0000-'.repeat(n / 5)],
    ['padded whitespace', (n: number) => `${' '.repeat(n)}0000-0001-9161-999X${' '.repeat(n)}`],
  ])('grows linearly on %s (5k → 80k characters)', (_label, build) => {
    cpuMicros(build(5_000), 50); // warm-up
    const small = cpuMicros(build(5_000), 400);
    const large = cpuMicros(build(80_000), 400);
    // 16x the input: linear stays near 16; quadratic would reach 256.
    expect(large / small).toBeLessThan(64);
  });
});

describe('orcidIdParamSchema (#57)', () => {
  it.each(['0000-0001-9161-999X', '0000-0001-9161-999x'])(
    'accepts the bare iD %j in either check-digit case',
    (value) => {
      expect(orcidIdParamSchema.parse(value)).toBe(value);
    },
  );

  it.each([
    'https://orcid.org/0000-0001-9161-999X',
    'orcid.org/0000-0001-9161-999X',
    '0000-0001-9161-999X/',
    '000000019161999X',
  ])('rejects %j — a resource URI segment carries only the bare iD', (value) => {
    const result = orcidIdParamSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual([
        'Must be a bare ORCID iD (e.g. 0000-0001-2345-6789).',
      ]);
    }
  });

  it('advertises the bare-only pattern and stops offering the URI form', () => {
    const jsonSchema = z.toJSONSchema(orcidIdParamSchema) as {
      pattern?: string;
      description?: string;
    };
    expect(jsonSchema.pattern).toBe('^\\d{4}-\\d{4}-\\d{4}-\\d{3}[\\dXx]$');
    expect(jsonSchema.description).not.toMatch(/URI/);
  });
});
