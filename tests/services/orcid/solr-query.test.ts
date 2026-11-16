/**
 * @fileoverview Tests for the shared Solr/Lucene query-value escaper (#18), the DOI/PMID
 * URL-prefix stripper (#44), the `doi-self` regex clause (#84), the ROR ID grammar,
 * normalizer, and check digits (#55), and the name-word splitter and initial test (#53).
 * @module tests/services/orcid/solr-query.test
 */

import { describe, expect, it } from 'vitest';
import {
  DOI_INPUT_PATTERN,
  doiSelfClause,
  escapeSolrValue,
  isExclusionOnlyQuery,
  isInitial,
  isValidRorId,
  normalizeRorId,
  ROR_ID_PATTERN,
  splitNameWords,
  stripIdentifierPrefix,
} from '@/services/orcid/solr-query.js';
import { expectLinearCpu } from '../../helpers/cpu-growth.js';

describe('escapeSolrValue', () => {
  it('escapes an embedded double quote', () => {
    expect(escapeSolrValue('O"Connor')).toBe('O\\"Connor');
  });

  it('escapes a backslash', () => {
    // Input is the 3-char string a\b; output backslash-escapes the backslash.
    expect(escapeSolrValue('a\\b')).toBe('a\\\\b');
  });

  it('escapes every Lucene reserved character individually', () => {
    // Reserved set: \ + - ! ( ) { } [ ] ^ " ~ * ? : | & /
    expect(escapeSolrValue('+')).toBe('\\+');
    expect(escapeSolrValue('-')).toBe('\\-');
    expect(escapeSolrValue('!')).toBe('\\!');
    expect(escapeSolrValue('(')).toBe('\\(');
    expect(escapeSolrValue(')')).toBe('\\)');
    expect(escapeSolrValue('{')).toBe('\\{');
    expect(escapeSolrValue('}')).toBe('\\}');
    expect(escapeSolrValue('[')).toBe('\\[');
    expect(escapeSolrValue(']')).toBe('\\]');
    expect(escapeSolrValue('^')).toBe('\\^');
    expect(escapeSolrValue('"')).toBe('\\"');
    expect(escapeSolrValue('~')).toBe('\\~');
    expect(escapeSolrValue('*')).toBe('\\*');
    expect(escapeSolrValue('?')).toBe('\\?');
    expect(escapeSolrValue(':')).toBe('\\:');
    expect(escapeSolrValue('|')).toBe('\\|');
    expect(escapeSolrValue('&')).toBe('\\&');
    expect(escapeSolrValue('/')).toBe('\\/');
  });

  it('escapes reserved chars in a punctuation-heavy DOI, leaving < > ; literal', () => {
    expect(escapeSolrValue('10.1002/(SICI)1099-0844(199912)17:4<290::AID-CBF849>3.0.CO;2-P')).toBe(
      '10.1002\\/\\(SICI\\)1099\\-0844\\(199912\\)17\\:4<290\\:\\:AID\\-CBF849>3.0.CO;2\\-P',
    );
  });

  it('is a no-op for plain values with no reserved characters', () => {
    expect(escapeSolrValue('Jennifer Doudna')).toBe('Jennifer Doudna');
    expect(escapeSolrValue('University of California')).toBe('University of California');
    expect(escapeSolrValue('22745249')).toBe('22745249');
  });

  it('leaves an apostrophe untouched (not a Lucene reserved char)', () => {
    expect(escapeSolrValue("O'Brien")).toBe("O'Brien");
  });

  it('returns an empty string unchanged', () => {
    expect(escapeSolrValue('')).toBe('');
  });
});

describe('stripIdentifierPrefix', () => {
  it.each([
    ['https://doi.org/10.5555/12345680'],
    ['http://doi.org/10.5555/12345680'],
    ['https://dx.doi.org/10.5555/12345680'],
    ['http://dx.doi.org/10.5555/12345680'],
    ['doi:10.5555/12345680'],
    ['DOI:10.5555/12345680'],
    ['HTTPS://DOI.ORG/10.5555/12345680'],
    ['doi.org/10.5555/12345680'],
    ['dx.doi.org/10.5555/12345680'],
    ['doi: 10.5555/12345680'],
    ['  https://doi.org/10.5555/12345680\t'],
    ['10.5555/12345680'],
  ])('reduces DOI %j to the bare identifier', (value) => {
    expect(stripIdentifierPrefix('doi', value)).toBe('10.5555/12345680');
  });

  it('never changes the case of the DOI body', () => {
    expect(stripIdentifierPrefix('doi', 'HTTPS://DX.DOI.ORG/10.1371/journal.PMED.0020124')).toBe(
      '10.1371/journal.PMED.0020124',
    );
  });

  it('strips one prefix only, leaving a repeated one in place', () => {
    expect(stripIdentifierPrefix('doi', 'doi:doi:10.1/x')).toBe('doi:10.1/x');
  });

  it('does not strip a prefix that appears after the start', () => {
    expect(stripIdentifierPrefix('doi', 'see https://doi.org/10.1/x')).toBe(
      'see https://doi.org/10.1/x',
    );
  });

  it.each([
    ['https://pubmed.ncbi.nlm.nih.gov/22745249/'],
    ['https://pubmed.ncbi.nlm.nih.gov/22745249'],
    ['http://pubmed.ncbi.nlm.nih.gov/22745249/'],
    ['https://www.ncbi.nlm.nih.gov/pubmed/22745249'],
    ['https://ncbi.nlm.nih.gov/pubmed/22745249/'],
    ['HTTPS://WWW.NCBI.NLM.NIH.GOV/PUBMED/22745249'],
    ['pubmed.ncbi.nlm.nih.gov/22745249/'],
    ['https://pubmed.ncbi.nlm.nih.gov/22745249/?from_single_result=22745249'],
    ['https://pubmed.ncbi.nlm.nih.gov/22745249#affiliation-1'],
    ['PMID: 22745249'],
    ['pmid:22745249'],
    [' 22745249 '],
  ])('reduces PMID %j to the bare identifier', (value) => {
    expect(stripIdentifierPrefix('pmid', value)).toBe('22745249');
  });

  it("applies each kind's prefixes only to that kind", () => {
    expect(stripIdentifierPrefix('pmid', 'doi:123')).toBe('doi:123');
    expect(stripIdentifierPrefix('doi', 'PMID:10.1/x')).toBe('PMID:10.1/x');
    expect(stripIdentifierPrefix('doi', 'https://pubmed.ncbi.nlm.nih.gov/123/')).toBe(
      'https://pubmed.ncbi.nlm.nih.gov/123/',
    );
  });

  it.each([
    ['doi', 'https://doi.org/'],
    ['doi', 'doi:'],
    ['doi', '  DOI:  '],
    ['pmid', 'https://pubmed.ncbi.nlm.nih.gov/'],
    ['pmid', 'https://www.ncbi.nlm.nih.gov/pubmed/'],
    ['pmid', 'PMID:'],
    ['pmid', 'https://pubmed.ncbi.nlm.nih.gov/?term=crispr'],
    ['doi', ''],
    ['pmid', '   '],
  ] as const)('normalizes a %s that is only a prefix (%j) to empty', (kind, value) => {
    expect(stripIdentifierPrefix(kind, value)).toBe('');
  });

  describe('cost stays linear in input length', () => {
    /** Best-of-three wall-clock for stripping `value`. */
    function timeFor(kind: 'doi' | 'pmid', value: string): number {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        for (let j = 0; j < 20; j++) stripIdentifierPrefix(kind, value);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    }

    /** Worst-case shapes: repeated prefix openers, near-miss openers, and long slash runs. */
    const shapes: [string, 'doi' | 'pmid', (size: number) => string][] = [
      ['repeated DOI prefixes', 'doi', (n) => 'https://doi.org/'.repeat(n / 16)],
      ['near-miss DOI openers', 'doi', (n) => 'https://dx.doi.or'.repeat(n / 17)],
      ['repeated doi: openers', 'doi', (n) => 'doi:'.repeat(n / 4)],
      ['repeated PMID prefixes', 'pmid', (n) => 'https://pubmed.ncbi.nlm.nih.gov/'.repeat(n / 32)],
      ['a long slash run', 'pmid', (n) => `https://pubmed.ncbi.nlm.nih.gov/${'/'.repeat(n)}x`],
      ['long whitespace padding', 'doi', (n) => `${' '.repeat(n)}doi:10.1/x${' '.repeat(n)}`],
      ['a long PMID query string', 'pmid', (n) => `PMID:1${'/?#'.repeat(n / 3)}`],
    ];

    it.each(shapes)('%s: 5k and 80k characters', (_, kind, build) => {
      const [t5, t80] = [5_000, 80_000].map((size) => timeFor(kind, build(size)));

      // 16x the input may cost ~16x the time; quadratic growth would be ~256x, so a 64x bound
      // leaves room for load noise while still failing a quadratic scan. The 1 ms floor keeps
      // timer noise on the small case from inflating the ratio.
      expect(t80! / Math.max(t5!, 1)).toBeLessThan(64);
      expect(t80!).toBeLessThan(500);
    });
  });
});

describe('doiSelfClause (#84)', () => {
  /** The prefix group: every form `stripIdentifierPrefix` strips, in any letter case, or none. */
  const PREFIX = String.raw`(([hH][tT][tT][pP][sS]?\:\/\/)?([dD][xX]\.)?[dD][oO][iI]\.[oO][rR][gG]\/|[dD][oO][iI]\:)?`;

  /** The Lucene regex between the slashes of a `doi-self:/…/` clause. */
  function regexBody(clause: string): string {
    const match = /^doi-self:\/(.*)\/$/s.exec(clause);
    if (!match) throw new Error(`not a doi-self regex clause: ${clause}`);
    return match[1]!;
  }

  /**
   * Whether the clause matches a `doi-self` value as Lucene matches it: against the whole
   * value, and with the only constructs the clause uses — a backslash before a character other
   * than a letter or digit, `[xX]` classes, and `( | )?` groups — meaning what they mean in a
   * JS regex without the `u` flag.
   */
  const matches = (clause: string, deposit: string) =>
    new RegExp(`^(?:${regexBody(clause)})$`).test(deposit);

  /**
   * Whether `token`, from its opening `/` through a closing one, is one regex term under the
   * query grammar (`"/" (~["*","/"] | "\\/") (~["/"] | "\\/")* "/"`): a first character other
   * than `*`, and every `/` inside it written as `\/`.
   */
  function isRegexTerm(token: string): boolean {
    const inner = token.slice(1, -1);
    if (token.length < 3 || !token.endsWith('/') || inner.startsWith('*')) return false;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '/' && inner[i - 1] !== '\\') return false;
    }
    return true;
  }

  /**
   * Where the regex term opening at `start` ends: the query parser's tokenizer takes the
   * longest token, so the last `/` that still closes a well-formed term.
   */
  function regexTermEnd(query: string, start: number): number {
    let end = -1;
    for (let i = query.indexOf('/', start + 1); i !== -1; i = query.indexOf('/', i + 1)) {
      if (isRegexTerm(query.slice(start, i + 1))) end = i + 1;
    }
    return end;
  }

  it('compiles the DOI to one regex: two-case letters, escaped punctuation, optional prefix', () => {
    expect(doiSelfClause('10.1088/1361-648X/aab193')).toBe(
      String.raw`doi-self:/${PREFIX}10\.1088\/1361\-648[xX]\/[aA][aA][bB]193/`,
    );
  });

  it.each(['10.1088/1361-648x/aab193', '10.1088/1361-648X/AAB193'])(
    'compiles %s to the same clause as the registered case',
    (doi) => {
      expect(doiSelfClause(doi)).toBe(doiSelfClause('10.1088/1361-648X/aab193'));
    },
  );

  it.each([
    '10.1088/1361-648X/aab193',
    '10.1088/1361-648x/aab193',
    '10.1088/1361-648X/AAB193',
    'https://doi.org/10.1088/1361-648X/aab193',
    'http://dx.doi.org/10.1088/1361-648x/aab193',
    'HTTPS://DX.DOI.ORG/10.1088/1361-648X/AAB193',
    'doi.org/10.1088/1361-648X/aab193',
    'dx.doi.org/10.1088/1361-648X/aab193',
    'doi:10.1088/1361-648X/aab193',
    'DOI:10.1088/1361-648x/aab193',
  ])('matches the deposit %s', (deposit) => {
    expect(matches(doiSelfClause('10.1088/1361-648x/aab193'), deposit)).toBe(true);
  });

  it.each([
    // A longer DOI that starts with this one: a version, or a work this one is part of.
    '10.1088/1361-648X/aab193.v1',
    '10.1088/1361-648X/aab1934',
    '10.1088/1361-648X/aab19',
    '10.1088/1361-648Y/aab193',
    // Wrappers outside the prefixes the input strips.
    'www.doi.org/10.1088/1361-648X/aab193',
    'ftp://doi.org/10.1088/1361-648X/aab193',
    'doi: 10.1088/1361-648X/aab193',
    '{10.1088/1361-648X/aab193}',
    'https://doi.org/doi:10.1088/1361-648X/aab193',
  ])('does not match %s', (deposit) => {
    expect(matches(doiSelfClause('10.1088/1361-648X/aab193'), deposit)).toBe(false);
  });

  it('reaches a mixed-case-only deposit from the lowercase DOI Crossref returns (#44)', () => {
    const clause = doiSelfClause('10.1371/journal.pmed.0020124');
    expect(matches(clause, '10.1371/journal.PMED.0020124')).toBe(true);
    expect(matches(clause, '10.1371/JOURNAL.PMED.0020124')).toBe(true);
    expect(clause).toBe(doiSelfClause('10.1371/journal.PMED.0020124'));
  });

  it('accepts exactly the prefixes stripIdentifierPrefix strips', () => {
    const bare = '10.5555/12345680';
    for (const prefix of [
      'https://doi.org/',
      'http://doi.org/',
      'https://dx.doi.org/',
      'HTTP://DX.DOI.ORG/',
      'doi.org/',
      'dx.doi.org/',
      'doi:',
      'DoI:',
      'https://',
      'www.doi.org/',
      'dx.',
      'doi',
      'https://doi.org',
      'pmid:',
    ]) {
      expect(matches(doiSelfClause(bare), `${prefix}${bare}`), prefix).toBe(
        stripIdentifierPrefix('doi', `${prefix}${bare}`) === bare,
      );
    }
  });

  /** DOIs the input pattern admits whose characters are syntax somewhere in the query. */
  const HOSTILE = [
    '10.1002/(SICI)1099-0844(199912)17:4<290::AID-CBF849>3.0.CO;2-P',
    '10.1000/x"OR*:*',
    '10.1000/a\\b',
    '10.1000/x\\',
    '10.1000/x\\/',
    '10.1000/x\\\\',
    '10.1000/x/',
    '10.1000/a/b//c',
    '10.1000/#@&~<1-9>{2}|.+?^$[a]',
    '10.1000/*',
    '10.1021/ja010958+',
    '10.1000/café-ŁÓDŹ',
    '10.1000/𝐀𝐁',
    '10.1000/漢字',
    '10.9999999/0123456789',
  ];

  it.each(HOSTILE)('keeps %s one regex term, matching only itself', (doi) => {
    expect(DOI_INPUT_PATTERN.test(doi)).toBe(true);
    const clause = doiSelfClause(doi);
    // A later clause holding an escaped slash is where a mis-closed term would run on to.
    const query = `${clause} AND grant-numbers:"a\\/b" AND (keyword:x/y)`;
    expect(regexTermEnd(query, clause.indexOf('/'))).toBe(clause.length);
    expect(matches(clause, doi)).toBe(true);
    expect(
      matches(
        clause,
        doi.replace(/[a-z]/g, (letter) => letter.toUpperCase()),
      ),
    ).toBe(true);
    expect(matches(clause, `${doi}x`)).toBe(false);
    expect(matches(clause, doi.slice(0, -1))).toBe(false);
  });

  it('writes a backslash as a class, so the term never ends in a backslash', () => {
    expect(doiSelfClause('10.1000/x\\')).toBe(String.raw`doi-self:/${PREFIX}10\.1000\/[xX][\\]/`);
  });

  it('escapes non-ASCII characters and leaves their case alone', () => {
    expect(doiSelfClause('10.1000/é')).toBe(String.raw`doi-self:/${PREFIX}10\.1000\/\é/`);
    expect(matches(doiSelfClause('10.1000/é'), '10.1000/É')).toBe(false);
  });

  describe('build cost', () => {
    it.each([
      ['a long digit run', (n: number) => `10.1/${'1'.repeat(n)}`, 320_000],
      ['a long letter run', (n: number) => `10.1/${'aB'.repeat(n / 2)}`, 320_000],
      ['a punctuation run', (n: number) => `10.1/${'(<"*\\/'.repeat(n / 6)}`, 320_000],
      ['repeated prefix openers', (n: number) => `${'doi:'.repeat(n / 4)}10.1/x`, 320_000],
      ['non-ASCII text', (n: number) => `10.1/${'é𝐀漢'.repeat(n / 4)}`, 320_000],
      ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`, 320_000],
      ['breaks throughout', (n: number) => '  \r\n'.repeat(n / 4), 320_000],
    ])('grows linearly on %s', { timeout: 0 }, (_label, build, maxSize) => {
      expectLinearCpu(doiSelfClause, build, { maxSize, microsPerChar: 1 });
    });
  });
});

describe('isExclusionOnlyQuery (#61)', () => {
  it.each([
    '-given-names:John',
    'NOT given-names:John',
    '!given-names:John',
    '-given-names:John -family-name:Smith',
    '-given-names:John AND -family-name:Smith',
    '-given-names:John OR NOT keyword:x',
    'NOT (given-names:John OR given-names:Jo*)',
    '-(given-names:John OR given-names:Jo*)',
    '-given-names:"Mary Ann"',
    '-"Mary Ann"',
    '-given-names:(Jennifer John)',
    '-publication-date:[2000 TO 2010]',
    '-keyword:a\\ b',
  ])('treats %j as exclusion-only', (query) => {
    expect(isExclusionOnlyQuery(query)).toBe(true);
  });

  it.each([
    'given-names:John',
    'given-names:Jennifer OR given-names:John',
    '-given-names:John keyword:crispr',
    'keyword:crispr -given-names:John',
    'NOT given-names:John OR keyword:x',
    '(-given-names:John)',
    '+keyword:crispr -given-names:John',
    'given-names:"Mary -Ann"',
    'not given-names:John', // lowercase "not" is a term, not an operator
    'NOT',
    '-',
    'AND OR',
    '',
  ])('treats %j as carrying a positive clause (or no clause)', (query) => {
    expect(isExclusionOnlyQuery(query)).toBe(false);
  });

  describe('scan cost', () => {
    /** Thread CPU time, in microseconds, of `reps` scans over `value`. */
    function cpuMicros(value: string, reps: number): number {
      const start = process.threadCpuUsage();
      for (let i = 0; i < reps; i++) isExclusionOnlyQuery(value);
      const used = process.threadCpuUsage(start);
      return used.user + used.system;
    }

    it.each([
      ['repeated group openers', (n: number) => '('.repeat(n)],
      ['repeated quotes', (n: number) => '"'.repeat(n)],
      ['repeated exclusions', (n: number) => '-a '.repeat(n / 3)],
      ['repeated NOT operators', (n: number) => 'NOT '.repeat(n / 4)],
      ['repeated escapes', (n: number) => `-${'\\"'.repeat(n / 2)}`],
    ])('grows linearly on %s (5k → 80k characters)', (_label, build) => {
      cpuMicros(build(5_000), 20); // warm-up
      const small = cpuMicros(build(5_000), 100);
      const large = cpuMicros(build(80_000), 100);
      // 16x the input: linear stays near 16; quadratic would reach 256.
      expect(large / small).toBeLessThan(64);
    });
  });
});

describe('ROR IDs (#55)', () => {
  /** Registry IDs sampled from the ROR API; every one carries valid check digits. */
  const REGISTRY_IDS = [
    '00cvxb145',
    '01an7q238',
    '02d439m40',
    '05m7zw681',
    '03awtex73',
    '04yyp8h20',
    '022rkxt86',
    '0019g1982',
    '0067y8s97',
    '009tdqt52',
    '04x8q5j40',
    '03wb76824',
  ];

  it.each(REGISTRY_IDS)('verifies the check digits of registry ID %s', (id) => {
    expect(isValidRorId(id)).toBe(true);
    expect(isValidRorId(`https://ror.org/${id}`)).toBe(true);
  });

  it.each(['00cvxb146', '01an7q237', '00cvxb100'])(
    'rejects %s, whose check digits do not match',
    (id) => {
      expect(isValidRorId(id)).toBe(false);
    },
  );

  it.each([
    '00cvxb145',
    'ror.org/00cvxb145',
    'http://ror.org/00cvxb145',
    'https://ror.org/00cvxb145',
    'https://www.ror.org/00cvxb145/',
    'www.ror.org/00cvxb145',
    'https://ror.org/00CVXB145',
    '00CvXb145/',
    ' 00cvxb145 ',
  ])('normalizes %j to the canonical lowercase URL', (value) => {
    expect(isValidRorId(value)).toBe(true);
    expect(normalizeRorId(value)).toBe('https://ror.org/00cvxb145');
  });

  it.each([
    'Stanford University',
    'grid.168010.e',
    'https://ror.org/',
    'ror.org/',
    'HTTPS://ROR.ORG/00cvxb145',
    'https://ror.org/10cvxb145', // the lead character is always 0
    'https://ror.org/00cvxb14', // too short
    'https://ror.org/00cvxb1455', // too long
    'https://ror.org/0icvxb145', // i, l, o, u are not Crockford base32
    'https://ror.org/0lcvxb145',
    'https://ror.org/0ocvxb145',
    'https://ror.org/0ucvxb145',
    'https://ror.org/00cvxb1a5', // check digits are digits
    'https://ror.org/00cvxb145?x=1',
    'https://example.org/00cvxb145',
  ])('rejects %j as not a ROR ID', (value) => {
    expect(ROR_ID_PATTERN.test(value)).toBe(false);
    expect(isValidRorId(value)).toBe(false);
  });

  it('carries no regex flags, so the advertised JSON Schema pattern is the grammar itself', () => {
    expect(ROR_ID_PATTERN.flags).toBe('');
  });

  describe('grammar cost', () => {
    /** Thread CPU time, in microseconds, of `reps` validate-and-normalize passes over `value`. */
    function cpuMicros(value: string, reps: number): number {
      const start = process.threadCpuUsage();
      for (let i = 0; i < reps; i++) {
        isValidRorId(value);
        normalizeRorId(value);
      }
      const used = process.threadCpuUsage(start);
      return used.user + used.system;
    }

    it.each([
      ['repeated scheme openers', (n: number) => 'https://www.'.repeat(n / 12)],
      ['repeated host prefixes', (n: number) => 'ror.org/'.repeat(n / 8)],
      ['overlapping ID openers', (n: number) => '0'.repeat(n)],
      ['padded whitespace', (n: number) => `${' '.repeat(n)}00cvxb145${' '.repeat(n)}`],
    ])('grows linearly on %s (5k → 80k characters)', (_label, build) => {
      cpuMicros(build(5_000), 50); // warm-up
      const small = cpuMicros(build(5_000), 400);
      const large = cpuMicros(build(80_000), 400);
      // 16x the input: linear stays near 16; quadratic would reach 256.
      expect(large / small).toBeLessThan(64);
    });
  });
});

describe('name words and initials (#53)', () => {
  it.each([
    ['J. Doudna', ['J', 'Doudna']],
    ['J.A. Doudna', ['J', 'A', 'Doudna']],
    ['  Jennifer   A.  Doudna ', ['Jennifer', 'A', 'Doudna']],
    ['J.', ['J']],
    ['Jean-Luc Picard', ['Jean-Luc', 'Picard']],
    ['.', []],
    ['', []],
  ])('splits %j on whitespace and periods into %j', (name, words) => {
    expect(splitNameWords(name)).toEqual(words);
  });

  it.each(['J', 'j', 'É', 'É', 'ø', 'Ł'])('treats %j as an initial', (word) => {
    expect(isInitial(word)).toBe(true);
  });

  it.each(['Jo', 'J*', 'J-', '伸', '김', 'Ж', 'Ω', '1', '́', ''])(
    'does not treat %j as an initial',
    (word) => {
      expect(isInitial(word)).toBe(false);
    },
  );

  describe('split cost', () => {
    /** Thread CPU time, in microseconds, of `reps` split-and-classify passes over `value`. */
    function cpuMicros(value: string, reps: number): number {
      const start = process.threadCpuUsage();
      for (let i = 0; i < reps; i++) splitNameWords(value).filter(isInitial);
      const used = process.threadCpuUsage(start);
      return used.user + used.system;
    }

    it.each([
      ['repeated initials', (n: number) => 'J. '.repeat(n / 3)],
      ['a long period run', (n: number) => `J${'.'.repeat(n)}Doudna`],
      ['a long whitespace run', (n: number) => `J${' \t'.repeat(n / 2)}Doudna`],
      ['one long word of combining marks', (n: number) => `E${'́'.repeat(n)}`],
    ])('grows linearly on %s (5k → 80k characters)', (_label, build) => {
      cpuMicros(build(5_000), 20); // warm-up
      const small = cpuMicros(build(5_000), 100);
      const large = cpuMicros(build(80_000), 100);
      // 16x the input: linear stays near 16; quadratic would reach 256.
      expect(large / small).toBeLessThan(64);
    });
  });
});
