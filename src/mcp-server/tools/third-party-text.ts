/**
 * @fileoverview Markers `format()` puts around text that researchers and depositing systems
 * wrote — names, biographies, titles, abstracts, organization names, deposited citations — so
 * it reads as quoted record data in `content[]`, never as the server's own headings or labels.
 * `structuredContent` and the resources keep every value verbatim; only rendered text passes
 * through here. Nothing is Markdown-escaped: the markers delimit, they do not rewrite.
 * @module mcp-server/tools/third-party-text
 */

/** A CommonMark line ending: CRLF, a lone CR, or a lone LF. */
const LINE_ENDING = /\r\n?|\n/;

/** A run of CR and LF characters in any order. */
const LINE_BREAK_RUN = /[\r\n]+/g;

/** A run of backticks. */
const BACKTICK_RUN = /`+/g;

/**
 * Multi-line prose as a Markdown blockquote: every line prefixed `> `, a blank line `>`. A
 * heading-shaped line in the value stays inside the quote.
 */
export function blockquote(text: string): string {
  return text
    .split(LINE_ENDING)
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * A value for an inline slot — a heading, a `**Label:**` line, a list item — with each run of
 * CR/LF folded to one space, so no line can start inside it. A value without a line break is
 * returned unchanged.
 */
export function singleLine(value: string): string {
  return value.replace(LINE_BREAK_RUN, ' ');
}

/**
 * A verbatim value in a backtick code fence one backtick longer than the longest run inside
 * it (three at minimum), so no line of the value can close the fence. The value is enclosed
 * byte for byte.
 */
export function fence(value: string): string {
  const longestRun = Math.max(0, ...Array.from(value.matchAll(BACKTICK_RUN), (m) => m[0].length));
  const marker = '`'.repeat(Math.max(3, longestRun + 1));
  return `${marker}\n${value}\n${marker}`;
}
