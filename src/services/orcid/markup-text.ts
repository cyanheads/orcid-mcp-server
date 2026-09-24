/**
 * @fileoverview Plain-text boundary for the free text ORCID relays from depositing systems.
 * Work titles and abstracts arrive with inline HTML/JATS markup (`<i>`, `<sup>`, `<h4>`);
 * the normalizers pass that text through here so no raw tag reaches either client surface.
 * Mirrors the one-small-file-per-shared-concern pattern of `text-folding.ts`.
 * @module services/orcid/markup-text
 */

/**
 * One markup tag: `<name …>`, `</name>`, or `<name/>`, where a name starts with a letter and
 * may carry a namespace prefix (`jats:italic`). A `<` not followed by a letter (`a < b`,
 * `p<0.05`) is text. Every quantifier stops at the next `<` or `>`, so a scan costs time
 * linear in the input, including input full of unclosed `<`. The name is captured, so
 * `split` interleaves it between the text segments.
 */
const TAG = /<\/?([A-Za-z][\w:.-]*)(?:\s[^<>]*)?\/?>/;

/**
 * Inline formatting elements, HTML and JATS, matched on the lowercased local name. These
 * mark up part of a word or phrase (`<sup>32</sup>P`, `un<i>bound</i>ed`), so removing one
 * joins its neighbours; every other tag, unknown ones included, separates them.
 */
const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bold',
  'cite',
  'code',
  'em',
  'font',
  'i',
  'italic',
  'mark',
  'monospace',
  's',
  'sc',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'u',
  'underline',
]);

const isInlineTag = (name: string) =>
  INLINE_TAGS.has(name.slice(name.lastIndexOf(':') + 1).toLowerCase());

/** A character reference: named, decimal, or hexadecimal. */
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z]+));/g;

/** The XML predefined entities plus `&nbsp;`; any other named reference stays literal. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeCodePoint(reference: string, codePoint: number): string {
  const valid =
    codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
  return valid ? String.fromCodePoint(codePoint) : reference;
}

/**
 * Decode character references in one pass. The replacement output is never rescanned, so
 * `&amp;lt;` decodes to `&lt;`, never to `<`.
 */
function decodeEntities(value: string): string {
  return value.replace(ENTITY, (reference, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined) return decodeCodePoint(reference, Number.parseInt(dec, 10));
    if (hex !== undefined) return decodeCodePoint(reference, Number.parseInt(hex, 16));
    return NAMED_ENTITIES[name as string] ?? reference;
  });
}

/**
 * Reduce ORCID free text to plain text. Tags are removed generically and their enclosed
 * text kept. Where tags were removed, the text on either side is joined directly when every
 * removed tag was inline formatting and no whitespace sat beside them (`<sup>32</sup>P` →
 * `32P`); otherwise it is joined by exactly one space, so `<h4>Background</h4>Group` cannot
 * fuse into one word and `by  <i>in vivo</i>  editor` loses its doubled spaces. Nothing is
 * left at the start or end. Character references are then decoded once. Whitespace away
 * from a removed tag is untouched, so text with no tag and no reference passes through
 * byte-identical. Tags are stripped before references are decoded: an encoded `&lt;i&gt;`
 * is literal text and stays text rather than becoming a tag to strip.
 *
 * @param value - Raw upstream text; `null` and `undefined` pass through as absent.
 * @returns The plain text, or `undefined` when nothing but markup and whitespace remains.
 */
export function toPlainText(value: string | null | undefined): string | undefined {
  if (!value) return;
  // Text segments at even indices, the captured tag names between them.
  const parts = value.split(TAG);
  let text = '';
  let spaced = false;
  for (const [i, part] of parts.entries()) {
    if (i % 2 === 1) {
      if (!isInlineTag(part)) spaced = true;
      continue;
    }
    const opened = i > 0 ? part.trimStart() : part;
    const segment = i < parts.length - 1 ? opened.trimEnd() : opened;
    if (opened.length < part.length) spaced = true;
    if (segment) {
      if (spaced && text) text += ' ';
      text += segment;
      spaced = false;
    }
    if (segment.length < opened.length) spaced = true;
  }
  return decodeEntities(text) || undefined;
}
