/**
 * @fileoverview Tests for the response byte budget shared by orcid_get_works and
 * orcid_get_work_detail (#36): admission at the exact boundary, the always-admitted first
 * record, the reservation a cut response carries, the larger-surface record cost, and lazy,
 * linear measurement.
 * @module tests/tools/response-budget.test
 */

import { describe, expect, it } from 'vitest';
import {
  countWithinBudget,
  jsonBytes,
  RESPONSE_BYTE_BUDGET,
  recordCost,
} from '@/mcp-server/tools/response-budget.js';

describe('jsonBytes and recordCost', () => {
  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    expect(jsonBytes('é')).toBe(4);
    expect(jsonBytes({ t: '山' })).toBe(11);
    expect(recordCost({}, '山')).toBe(3);
  });

  it('charges a record the larger of its JSON and its rendered text', () => {
    // JSON outweighs text: {"title":"Science"} is 19 bytes.
    expect(recordCost({ title: 'Science' }, '### Science')).toBe(19);
    // Text outweighs JSON: an empty contributor renders as "- (unnamed)".
    expect(recordCost({}, '- (unnamed)')).toBe(11);
  });
});

describe('countWithinBudget', () => {
  it('returns 0 for no records and every record when all fit', () => {
    expect(countWithinBudget([], 100)).toBe(0);
    expect(countWithinBudget([10, 10], 100)).toBe(2);
  });

  it('admits a record that lands exactly on the budget and stops at the next byte', () => {
    const envelope = 1_000;
    // Two records plus the separator between them fill the budget to the byte.
    const second = RESPONSE_BYTE_BUDGET - envelope - 30_000 - 1;
    expect(countWithinBudget([30_000, second], envelope)).toBe(2);
    expect(countWithinBudget([30_000, second + 1], envelope)).toBe(1);
  });

  it('always admits the first record, even when it alone exceeds the budget', () => {
    expect(countWithinBudget([RESPONSE_BYTE_BUDGET * 2, 10], 50)).toBe(1);
  });

  it('leaves room for the cut-response reservation only when a cut happens', () => {
    const costs = Array.from({ length: 10 }, () => 10_000);
    // No cut: the reservation is not charged, so the envelope-only fit decides.
    expect(countWithinBudget(costs.slice(0, 6), 1_000, 5_000)).toBe(6);
    // Cut: six records would fit bare, but the reservation leaves room for five.
    expect(countWithinBudget(costs, 1_000, 5_000)).toBe(5);
    expect(countWithinBudget(costs, 1_000)).toBe(6);
  });

  it('measures no record past the first one over the budget', () => {
    let measured = 0;
    const costs = Array.from({ length: 1_000 }, () => 10_000)
      .values()
      .map((cost) => {
        measured++;
        return cost;
      });

    expect(countWithinBudget(costs, 100)).toBe(6);
    expect(measured).toBe(7);
  });

  it('costs linear time in the page size when every record fits', () => {
    /** A bare work summary (~40 B serialized), so a 1,000-work page stays under the budget. */
    const work = (i: number) => ({ putCode: 215_949_000 + i, title: `Work ${i}` });
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => work(i)).map((w) => ({ w, text: `### ${w.title}` }));
    /** Best-of-five wall-clock for one budget pass over a pre-built page. */
    function timeFor(records: { w: unknown; text: string }[]): number {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        countWithinBudget(
          records.values().map(({ w, text }) => recordCost(w, text)),
          200,
        );
        best = Math.min(best, performance.now() - start);
      }
      return best;
    }

    expect(
      countWithinBudget(
        page(1_000).map(({ w, text }) => recordCost(w, text)),
        200,
      ),
    ).toBe(1_000);
    // 16x the records may cost ~16x the time; a quadratic pass would cost ~256x.
    const [t62, t1000] = [62, 1_000].map((n) => timeFor(page(n)));
    expect(t1000! / Math.max(t62!, 0.05)).toBeLessThan(64);
    expect(t1000!).toBeLessThan(50);
  });
});
