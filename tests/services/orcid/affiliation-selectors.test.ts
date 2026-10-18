/**
 * @fileoverview Affiliation selectors preserve upstream summaries and source provenance.
 * @module tests/services/orcid/affiliation-selectors.test
 */
import { describe, expect, it } from 'vitest';
import { normalizeActivities } from '@/services/orcid/normalizers.js';
import type { RawActivities } from '@/services/orcid/types.js';

const id = '0000-0002-1825-0097';
const raw: RawActivities = {
  employments: {
    'affiliation-group': [
      {
        summaries: [
          {
            'employment-summary': {
              'put-code': 1,
              organization: { name: 'Same University' },
              source: { 'source-name': { value: 'Researcher' }, 'source-orcid': { path: id } },
            },
          },
          {
            'employment-summary': {
              'put-code': 2,
              organization: { name: 'Same University' },
              source: {
                'source-name': { value: 'Member' },
                'source-client-id': { path: 'client' },
              },
            },
          },
        ],
      },
      {
        summaries: [{ 'employment-summary': { 'put-code': 3, 'role-title': 'Later appointment' } }],
      },
    ],
  },
  educations: {
    'affiliation-group': [{ summaries: [{ 'education-summary': { 'role-title': 'Student' } }] }],
  },
};

describe('affiliation selector normalization', () => {
  it('deduplicates explicit selectors in first occurrence order, preserving every record', () => {
    expect(
      normalizeActivities(raw, ['education', 'employment', 'education', 'employment'], id),
    ).toEqual(normalizeActivities(raw, ['education', 'employment'], id));
  });
  it('all expands once in canonical section order, regardless of explicit selectors', () => {
    expect(normalizeActivities(raw, ['education', 'all', 'employment', 'all'], id)).toEqual(
      normalizeActivities(raw, ['all'], id),
    );
    expect(normalizeActivities(raw, ['all'], id).map((record) => record.type)).toEqual([
      'employment',
      'employment',
      'employment',
      'education',
    ]);
  });
  it('characterizes distinct identical-looking summaries, nested groups, and provenance', () => {
    const result = normalizeActivities(raw, ['employment'], id);
    expect(result).toHaveLength(3);
    expect(result.slice(0, 2).map((record) => record.organization?.name)).toEqual([
      'Same University',
      'Same University',
    ]);
    expect(result.map((record) => record.sources)).toEqual([
      [{ name: 'Researcher', selfAsserted: true }],
      [{ name: 'Member', selfAsserted: false }],
      [],
    ]);
    expect(result[2]?.role).toBe('Later appointment');
  });
});
