/**
 * @fileoverview The notice a record tool adds when ORCID served a deprecated (merged) iD from
 * its primary record.
 * @module mcp-server/tools/deprecated-id-notice
 */

/**
 * Notice naming both iDs when `orcidId`, the iD the record was served under, differs from the
 * canonical `requestedId`; an empty string otherwise. Both are validated ORCID iDs (digits,
 * hyphens, and `X`), so neither needs Markdown escaping.
 */
export function deprecatedIdNotice(requestedId: string, orcidId: string): string {
  return requestedId === orcidId
    ? ''
    : `ORCID iD ${requestedId} is deprecated: ORCID merged it into ${orcidId}, and this response reports that primary record. Use ${orcidId} in later calls.`;
}
