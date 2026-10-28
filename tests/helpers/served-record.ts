/**
 * @fileoverview Adapts a mocked `OrcidService` record method to the `RecordResult` shape the
 * real method returns, for unit tests that stub the service module.
 * @module tests/helpers/served-record
 */

/**
 * Wrap `fn` — a mock resolving to a record section's data — so the method resolves to
 * `{ orcidId, data }` served under the requested iD, as ORCID serves any iD that is not
 * deprecated. `normalize` is the canonicalization the test module's mocked `normalizeOrcidId`
 * applies, so the served iD matches the one the handler compares it with.
 */
export function served(fn: (...args: unknown[]) => unknown, normalize: (id: string) => string) {
  return async (id: string, ...rest: unknown[]) => ({
    orcidId: normalize(id),
    data: await fn(id, ...rest),
  });
}
