# orcid-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `orcid_search_researchers` | Search the ORCID registry. Structured params build a Solr query; all provided params are ANDed, and at least one must be non-blank. Returns ORCID iDs with inline name and institution data via `expanded-search`, capped by the 64,000-byte response budget (`nextStart` continues a cut page). Use when you know specific field values (name, affiliation, keyword, grant number). For author disambiguation from an ambiguous name, use `orcid_resolve_researcher` instead. | `given_name`, `family_name`, `affiliation`, `keyword`, `ror_id`, `doi`, `pmid`, `grant_number`, `query` (raw Solr, ANDed with structured params as one group), `rows`, `start` | `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true` |
| `orcid_get_profile` | Fetch a researcher's public profile: name, other names, biography, keywords, researcher URLs, and external identifiers (Scopus ID, ResearcherID, Loop, etc.). The entry point for building a researcher dossier. Pass a bare ORCID iD (`0000-0001-2345-6789`) or an orcid.org URI; a lowercase `x` check digit is canonicalized to `X`. A `notice` enrichment names the sections with no public data, since visibility is per field and an empty section may be private. | `orcid_id` | `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true` |
| `orcid_get_works` | Retrieve works (publications, datasets, software, preprints, etc.) associated with an ORCID iD. Returns titles, work types, publication dates, journal names, and all external identifiers — DOIs, PMIDs, arXiv IDs — ready for chaining to Crossref, PubMed, or arXiv servers. Pages are sliced locally by `offset`/`limit` and capped by the 64,000-byte response budget. | `orcid_id`, `limit`, `offset`, `include_external_ids` | `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true` |
| `orcid_get_work_detail` | Fetch full detail records for 1–100 works by their put-codes in a single bulk request. Returns abstracts, contributors with CRediT roles, the record's external IDs (DOI, PMID, arXiv, ISBN), citation metadata, journal title, and URL per work; a record over 100 contributors keeps the first 100 plus the requested researcher's own entries (`contributorCount`, `contributorsTruncated`), and a citation over 8,192 bytes is dropped (`citationOmitted`). Put-codes come from the `putCode` field of `orcid_get_works`; per-record errors are surfaced rather than failing the whole call, and put-codes past the 64,000-byte response budget come back in `deferredPutCodes`. | `orcid_id`, `put_codes` | `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true` |
| `orcid_get_affiliations` | Fetch affiliation records for a researcher. `types` controls which sections to return: `employment`, `education`, `invited-positions`, `distinctions`, `memberships`, `qualifications`, `services`, or `all`. Default is `employment` and `education`; an explicit empty list is rejected. Returns organization names, disambiguated org IDs (ROR/GRID/Ringgold), departments, roles, and date ranges. | `orcid_id`, `types` | `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true` |
| `orcid_get_funding` | Fetch funding records for a researcher: grants, contracts, awards, and salary awards, with funder names, grant numbers, and funding periods — one record per ORCID funding group, with `periods` when its versions record distinct award periods. Funding comes from the researcher or from member organizations (`sources` names which) and is often sparse — absence does not mean no funding. | `orcid_id` | `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true` |
| `orcid_get_peer_reviews` | Fetch peer review activity: reviewer role (`reviewer`, `editor`, `chair`, etc.), review type, completion dates, ISSN-keyed group identifiers, and the convening organization ORCID records — often the service that imported the review rather than the journal, so a review with an ISSN is headed by it. Use to assess a researcher's editorial activity and journal affiliations. | `orcid_id` | `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true` |
| `orcid_get_research_resources` | List research resources associated with a researcher — compute allocations, equipment access, lab facilities, data resources, and clinical study registrations. A newer, sparsely-populated ORCID section; most researchers have no entries. Returns resource title, hosting organization, external identifiers, and access period. | `orcid_id` | `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true` |
| `orcid_resolve_researcher` | Disambiguate an author name to a verified ORCID iD. Returns a ranked list of candidates (5 by default, up to 20 via `rows`) with transparent signals: name match type (case- and accent-insensitive), institution overlap, and whether a DOI/PMID anchor was used. The name is searched as an exact phrase first; byline initials and other names are fallbacks, and `Family, Given` is read as `Given Family`. Use this (not `orcid_search_researchers`) when the input is an ambiguous name that needs ranked disambiguation. `doi` or `pmid` anchor the search to a specific work. | `name`, `affiliation`, `doi`, `pmid`, `rows` | `readOnlyHint: true`, `openWorldHint: true`, `idempotentHint: true` |

### Resources

| URI Template | Description | When to use | Pagination |
|:-------------|:------------|:------------|:-----------|
| `orcid://researcher/{orcid_id}/profile` | Researcher profile (person section: name, other names, bio, keywords, external IDs). Use when injecting researcher identity context into a prompt or when the agent needs to check whether a profile includes a specific external ID (e.g., Scopus ID for chaining). Typed failures: `invalid_orcid_id` (checksum, local), `profile_not_found` (unknown iD or no public name). | Stable inline context; prefer the tool when the response needs to flow into conditional logic. | No |
| `orcid://researcher/{orcid_id}/works` | Works list for a researcher. Use when providing a researcher's publication list as background context for summarizing or reviewing a body of work. DOIs and PMIDs in the response are ready for Crossref/PubMed chaining. Typed failures: `invalid_orcid_id` (checksum, local), `profile_not_found` (unknown iD, with `data.orcidId`). | Stable inline context; prefer the tool when filtering or processing results is needed. | No |

### Prompts

None — the server is data-oriented. No recurring interaction patterns warrant a structured prompt.

---

## Overview

`orcid-mcp-server` wraps the ORCID Public API v3.0 (`https://pub.orcid.org/v3.0/`), exposing the ORCID registry as a researcher identity and activity layer for LLM agents.

ORCID is the canonical disambiguation namespace for researchers: 19M+ registered profiles, each with a persistent `0000-XXXX-XXXX-XXXX` identifier. It carries data asserted by researchers and by member organizations (university systems, funders, Crossref, publishers) — affiliations, funding, peer review activity — that complementary servers like OpenAlex and PubMed don't have, and it records which party asserted each item. The primary agent workflows are:

1. **Author disambiguation** — resolve an ambiguous name to a verified ORCID iD
2. **Researcher profiling** — build a dossier from works, affiliations, and funding
3. **Cross-server chaining** — extract DOIs/PMIDs/arXiv IDs from ORCID works, then pass them to Crossref, PubMed, or arXiv servers

**Licensing note:** The ORCID Public API is non-commercial only (ToS §2). This server is appropriate for open-source and free hosted deployments. Commercial products require ORCID organizational membership and the Member API.

---

## Requirements

- Read-only access to the ORCID Public API v3.0
- No API key required for public endpoints; all data is read from public records
- Supports researcher search, profile retrieval, works, affiliations, funding, and peer review
- Returns external identifiers (DOIs, PMIDs, arXiv IDs, Scopus IDs) in formats consumable by downstream servers
- Rate limit: ORCID's API FAQ gives the anonymous Public API this server calls 12 requests/second with up to 40 queued (a request past the queue gets a 503, which the retry layer backs off from) and a daily quota of 25,000 reads per IP address. No throttling beyond that retry; a shared hosted deployment draws every caller's reads from its one per-IP daily quota
- Public API search is limited to 10,000 results (offset limit); queries returning more than this should note the truncation
- Non-commercial use only under Public API ToS

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OrcidService` | ORCID Public API v3.0 (`https://pub.orcid.org/v3.0/`) | All tools |

Single service: `expandedSearch()` calls `/expanded-search/`, and one fetcher per record section calls `/{orcid_id}/{section}` (`/person`, `/works`, the bulk `/works/{put-codes}`, `/activities`, `/fundings`, `/peer-reviews`, `/research-resources`). All share a base URL, retry logic, and JSON Accept header. Every request a tool call makes runs under one 25-second deadline for the whole call, covering all attempts, backoff, and body reads, so an upstream that stops answering fails as `Timeout` (`data.reason: retry_deadline_exceeded`) instead of holding the call through the runtime's fetch idle timeout on each attempt, and `orcid_resolve_researcher`'s fallback stages share that one budget rather than spending 25 seconds each; a refused or reset connection, or a 2xx body that is not JSON, is a retryable `ServiceUnavailable` that names ORCID without its URL or the body.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `ORCID_API_BASE_URL` | No | Override API base URL (default: `https://pub.orcid.org/v3.0/`). Useful for pointing at sandbox. |

No API key required for the Public API's read-only endpoints. The search endpoints return JSON without auth when `Accept: application/json` is set.

---

## Implementation Order

1. Config (`ORCID_API_BASE_URL`, base URL default)
2. `OrcidService` — search methods, record section fetchers, retry/backoff
3. `orcid_get_profile` — person section (baseline read, simplest endpoint)
4. `orcid_search_researchers` — expanded-search (discover → profile flow)
5. `orcid_get_works` — works endpoint, external ID extraction
6. `orcid_get_work_detail` — bulk work detail by put-codes
7. `orcid_get_affiliations` — `/activities` endpoint, affiliation section filtering
8. `orcid_get_funding` — funding endpoint
9. `orcid_get_peer_reviews` — peer-reviews endpoint
10. `orcid_get_research_resources` — research-resources endpoint
11. `orcid_resolve_researcher` — workflow tool composing search + scoring
12. Resources

---

## Domain Mapping

| Noun | ORCID API Endpoints | Tool(s) |
|:-----|:--------------------|:--------|
| Researcher (search) | `GET /expanded-search/?q=...` | `orcid_search_researchers`, `orcid_resolve_researcher` |
| Person | `GET /{id}/person` | `orcid_get_profile` |
| External identifiers | included in `GET /{id}/person` | `orcid_get_profile` |
| Works | `GET /{id}/works` `GET /{id}/works/{put-codes}` | `orcid_get_works`, `orcid_get_work_detail` |
| Employment | `GET /{id}/activities` (employments section) | `orcid_get_affiliations` |
| Education | `GET /{id}/activities` (educations section) | `orcid_get_affiliations` |
| Invited positions | `GET /{id}/activities` (invited-positions section) | `orcid_get_affiliations` |
| Distinctions | `GET /{id}/activities` (distinctions section) | `orcid_get_affiliations` |
| Memberships | `GET /{id}/activities` (memberships section) | `orcid_get_affiliations` |
| Qualifications | `GET /{id}/activities` (qualifications section) | `orcid_get_affiliations` |
| Services | `GET /{id}/activities` (services section) | `orcid_get_affiliations` |
| Funding | `GET /{id}/fundings` | `orcid_get_funding` |
| Peer reviews | `GET /{id}/peer-reviews` | `orcid_get_peer_reviews` |
| Research resources | `GET /{id}/research-resources` | `orcid_get_research_resources` |

**Not exposed:** `/record` (full record — too large, noisy for agents; individual sections are better scoped).

---

## Workflow Analysis

### `orcid_resolve_researcher` (1–7 upstream calls)

Each call is `GET /expanded-search/?q={query}&rows={rows}`, returning candidates with inline name and institution data. A `Family, Given` name (exactly one comma, both sides non-blank) is first reordered to `Given Family`. Stages run in order, each only when every earlier stage found nothing; a stage with no clause to build is skipped. Every name stage carries every supplied anchor (`doi-self:"{doi}"`, `pmid-self:"{pmid}"`). All stages share the call's one 25-second deadline, so a slow upstream ends the call as `Timeout` partway down the chain rather than after seven full request budgets.

| # | Query | When it runs |
|:--|:------|:-------------|
| 1 | `given-and-family-names:"{name}"` + anchors + `affiliation-org-name:"{affiliation}"` | Always (the affiliation clause only when supplied). |
| 2 | byline clause + anchors + affiliation | The name has initials and an affiliation is supplied. |
| 3 | `given-and-family-names:"{name}"` + anchors | An affiliation is supplied. |
| 4 | byline clause + anchors | The name has initials. |
| 5 | `other-names:"{name}"` + anchors | Always. |
| 6–7 | each anchor alone, DOI first | A DOI or PMID is supplied. |

The byline clause exists when the name has at least one initial (one Latin-script letter, period optional) and one other word. Two or more other words form a phrase whose slop is the number of initials dropped (`"Jennifer A. Doudna"` → `given-and-family-names:"Jennifer Doudna"~1`); a single other word pairs with the first initial as a prefix term (`"J. Doudna"` → `given-and-family-names:("Doudna" AND J*)`). `primaryQuery` is stage 1; `queryUsed`/`totalFound` describe the last stage run, which `relaxedQuery` also names when stage 1 found nothing.

The handler scores candidates by: exact name match weight, affiliation string overlap with the `affiliation` input, and presence of the provided DOI/PMID in the query anchor (a DOI/PMID match is near-deterministic). Names are compared against the reordered name. `exact` is folded equality with the full name or credit name; `partial` and `other-name` need two shared folded words (one for a one-word name), where the input's first initial counts only when the first word of the compared name — the candidate's first given name, or the other name — starts with that letter, so `J. Smith` is `partial` for John Smith and `none` for Carolyn J Smith, and an initial alone never makes a match `exact`. Returns candidates with transparent disambiguation signals: name match type (`exact`/`partial`/`other-name`/`none`), institution overlap flag, and anchor type (`doi`/`pmid`/`none`). No synthetic scores — raw signals only.

**When DOI or PMID is provided:** `doi-self:"{doi}"` in the query acts as an anchor — the result set will include only researchers who have linked that work to their ORCID record. The name is still included in the query to guard against edge cases (works linked by institutions, not the author). If no name stage matches, the handler retries with only the identifier anchor.

---

## Design Decisions

**`expanded-search` as the primary search backend for all queries.** ORCID has two search endpoints: `/search/` (returns only ORCID iDs, requiring N+1 follow-up profile fetches) and `/expanded-search/` (returns iD + name + institutions inline). Both support the same Solr field syntax including `doi-self`, `pmid-self`, `ror-org-id`, `affiliation-org-name`, `given-names`, and `family-name`. `orcid_search_researchers` and `orcid_resolve_researcher` use `expanded-search` exclusively — agents get useful results in one call.

**`doi` and `pmid` added to `orcid_search_researchers`.** Because `expanded-search` supports `doi-self` and `pmid-self` field queries, identifier-anchored search (e.g., "who authored this DOI?") belongs directly in the search tool. The `doi`/`pmid` params translate to phrase-quoted `doi-self:"{value}"` / `pmid-self:"{value}"` Solr field clauses ANDed into the query. Use `orcid_search_researchers` for precise lookups; use `orcid_resolve_researcher` when the input is ambiguous and ranked candidates with scoring are needed.

**`orcid_get_affiliations` uses `/activities` — one call, not seven.** The `/activities` endpoint returns all affiliation types (employment, education, invited-positions, distinctions, memberships, qualifications, services) plus works, funding, and peer reviews in a single response. The handler reads `/activities` once and filters the desired sections client-side. This eliminates 6 parallel upstream calls vs. fetching each section independently. Valid `types` values: `employment`, `education`, `invited-positions`, `distinctions`, `memberships`, `qualifications`, `services`, `all`. Default is `['employment', 'education']` (the 90% case).

**No `orcid_get_record` mega-tool.** A single "get everything" tool would be convenient but outputs a massive payload that wastes context budget. The section tools are small, composable, and let agents fetch exactly what they need for their current step.

**Peer review deferred from `orcid_get_affiliations`.** Peer review has a different structure (group IDs, review types, ISSN-keyed groups vs. org-keyed affiliations, `convening-organization` rather than `organization`) and different use cases (editorial activity vs. career history). It stays as its own tool rather than being folded into affiliations.

**Funding is a thin tool.** Funding records are rarely populated. The tool is kept because when it exists it's high-value (grant numbers, funder IDs) — but it's a single-endpoint wrapper, not a workflow.

**External identifiers surface in `orcid_get_profile`, not a separate tool.** The `/external-identifiers` data is embedded in the `/person` response. Profile already fetches person data; including external IDs (Scopus Author ID, ResearcherID, etc.) in the profile response avoids a round-trip and is always relevant when profiling a researcher.

**`orcid_get_profile` names its empty sections.** `format()` renders only the sections that carry data, so a content-only client could not tell an empty section from one never fetched. A `notice` enrichment lists every empty section: `name` (only when given, family, and credit name are all absent, since most records have no credit name), `other names`, `biography`, `keywords`, `researcher URLs`, `external identifiers`, `email addresses`, `countries`. It fires on any empty section rather than past a sparseness threshold, so most real profiles carry one (public emails and addresses are uncommon), at about 120–230 bytes. A nameless profile is served with the notice, never as `profile_not_found`. Other names keep ORCID's order, descending `display-index`, which is also the order `expanded-search` returns, and are not de-duplicated, since an other name can repeat the primary name.

**The researcher resources fail with the tools' typed reasons.** Both resources declare `invalid_orcid_id` (`InvalidParams`, the local checksum rejection) and `profile_not_found` (`NotFound`), and throw through `ctx.fail`, so a resource read and the matching tool call give an agent the same `data.reason` and the framework fills `data.recovery.hint` from the contract. `invalid_orcid_id` is required, not optional: once a definition declares `errors[]`, the linter's `error-contract-conformance` rule flags any thrown non-baseline code left undeclared. Messages, the works resource's `data.orcidId`, and the no-leak 404 remap are unchanged.

**`ror-org-id` values must be quoted in Solr queries.** ROR IDs are full URLs (`https://ror.org/XXXXXXX`) containing colons, which break bare Solr field queries. The handler escapes and phrase-quotes the value: `ror-org-id:"https\:\/\/ror.org\/00f54p054"`.

**`ror_id` accepts every common ROR form and validates it locally.** ORCID's `ror-org-id` index is exact and case-sensitive: it holds only `https://ror.org/<lowercase id>`, so a bare ID, `ror.org/…`, `http://`, `www.`, a trailing slash, or an uppercase ID matched nothing and returned an empty success. `ror_id` (trimmed) accepts an optional `http(s)://`, optional `www.`, `ror.org/`, then the ID — `0`, six Crockford base32 characters (no `i`, `l`, `o`, `u`), two check digits — in either letter case, then an optional `/`; `normalizeRorId` (`src/services/orcid/solr-query.ts`) reduces it to the indexed form. Uppercase IDs are lowercased because Crockford base32 is case-insensitive and ROR issues every ID lowercase; uppercase scheme or host stays rejected because the advertised JSON Schema `pattern` cannot carry regex flags. The check digits are verified with ROR's own algorithm (`98 − (n × 100 mod 97)`, `n` the six characters decoded as base32), because a mistyped ID otherwise reads as "no researchers at this organization". The shape check aborts, so the check-digit message appears only for a well-shaped ID; a prefix-only `https://ror.org/` fails rather than counting as blank, since silently dropping the filter would widen the search. A blank or whitespace-only `ror_id` stays unset, and the advertised `pattern` admits blank and surrounding whitespace, so a client validating against the JSON Schema accepts every value the server does.

**Structured Solr values are escaped, not just quoted.** Quoting alone is insufficient — an embedded quote or backslash still breaks phrase scoping, and unquoted punctuation-heavy DOIs (`10.1002/(SICI)…17:4<290::…`) produce an upstream Solr 500. Both query builders (`search-researchers`, `resolve-researcher`) route every structured value through a single shared `escapeSolrValue` (`src/services/orcid/solr-query.ts`) that backslash-escapes the Lucene reserved set (`\ + - ! ( ) { } [ ] ^ " ~ * ? : | & /`). A universal escaper — applied to every value — is simpler and safer than tracking which characters matter where; escaping a character that is already literal inside a phrase quote was verified against the live API to be a no-op (identical result count and status). Every structured clause is also phrase-quoted, the `doi-self`/`pmid-self` identifier clauses included: escaping leaves whitespace alone, so an unquoted identifier with inner whitespace split into extra terms joined by a live operator (`doi-self:10.1000\/x OR smith` matched 47,868 records; the quoted form matches 0). Quoting an identifier was verified live to return the same counts as the unquoted form for bare, partial, and mixed-case DOIs and for PMIDs, so case sensitivity and matching are unchanged. The raw `query` passthrough on `orcid_search_researchers` is deliberately left unescaped so callers can supply intentional Solr operators.

**Blank search input is rejected at the schema, not searched.** With no non-blank field, `orcid_search_researchers` used to fall back to `*:*` (the whole registry), and `orcid_get_affiliations` with `types: []` selected no section and read as an empty record. Both, plus a whitespace-only `orcid_resolve_researcher` name, fail input validation instead (`superRefine` / `min` / `refine` on the input schema), so the caller gets `invalid_arguments` with a recovery hint before any upstream call. The search check runs the query builder itself, so "blank" means exactly "compiles to no clause" — including a `doi`/`pmid` that is only a URL or `doi:`/`PMID:` prefix.

**DOI and PMID URL forms are reduced to the bare identifier.** ORCID indexes bare identifiers, so `https://doi.org/…`, `https://dx.doi.org/…`, `doi:…`, the `pubmed.ncbi.nlm.nih.gov` / `ncbi.nlm.nih.gov/pubmed` URL forms, and `PMID: …` matched nothing. One shared `stripIdentifierPrefix` (`src/services/orcid/solr-query.ts`) strips a single leading prefix, matched case-insensitively and with the URL scheme optional, before escaping; for a PMID it also drops a PubMed URL's query string or fragment (`/?from_single_result=…`), since a PMID is digits only. The identifier body keeps its case because `doi-self` matching can be case-sensitive: a case-changed segment of some DOIs matches nothing (`journal.PMED` vs `journal.pmed`).

**`grant_number` compiles to a phrase clause.** `grant-numbers` is a tokenized text field: `grant-numbers:"5F31MH010500-03"` matched 1 record where the unquoted form matched 5,859. The filter is therefore phrase-quoted (and escaped), and described as phrase-match rather than an exact identifier lookup. Verified live: matching is case-insensitive and runs over the parts between separators, so a run of whole parts (`5F31MH010500`, `NE/000393`) also matches the fuller number, while a number cut mid-part (`5F31MH0105`) matches nothing.

**Name and institution matching fold accents.** Records often carry the ASCII rendering of an accented name, so `orcid_resolve_researcher` folds both sides with `foldForMatching` (`src/services/orcid/text-folding.ts`: NFKD, strip combining marks U+0300–U+036F, lowercase, keep letters/digits/whitespace in any script). "José" and "Jose" classify identically, and non-Latin names keep their letters rather than folding to an empty string. Institution words are split on punctuation before folding, so "Max-Planck-Institute" still yields separate words. No transliteration between scripts, and letters NFKD leaves whole (ø, ł, ß) still differ from their ASCII stand-ins.

**The resolver's exact phrase stays first; byline and alias forms are later stages.** A byline (`J. Doudna`), a middle initial, a `Family, Given` name, or an alias listed only in a record's other names found nothing against the phrase alone. Building the primary clause from the name's words in any order was rejected on measured precision: Solr's term-frequency scoring ranks repeated-word names ("Wei Wei Wang") above exact ones, so `given-and-family-names:(Wei AND Wang)` left 2 exact Wei Wangs in the top 20 where the phrase leaves 19 — the wrong-candidate defect the phrase was introduced to fix. OR-ing `other-names` into the primary was rejected for the same reason (a hyphenated other name such as "Chih-Wei Wang" contains the phrase; 11 of 20 exact). So every name that matches as a phrase still sends one query, and the byline clause uses a slop phrase (`"Wei Wang"~1` keeps 19 of 20) rather than a word AND. Middle initials are dropped from the byline rather than required, since `(Jennifer AND A AND Doudna)` zeroes a record that omits the initial. An initial is a Latin-script letter only, because a one-character CJK or Hangul word is a whole given name. The byline prefix term uses `given-and-family-names`, where prefixes are case- and accent-folded (`É*` = `E*`); on `orcid_search_researchers`, an initials-only `given_name` compiles to `given-names:{letter}*` terms, which are case-insensitive but accent-sensitive there (`É*` matches Étienne, `E*` does not) — a property of that field, left as is.

**Generic institution words are stopwords in every common affiliation language.** An `affiliation` made only of generic words ("University of", "Universidad de", "Institut") establishes no institution overlap, and a matched run must contain at least one distinctive word. `ORG_STOPWORDS` holds the English words plus their equivalents in Spanish, Portuguese, Italian, French, German, Catalan, Dutch, and the Scandinavian languages: university, institute, college/school, center, laboratory, hospital, national/state, and connectives long enough to survive the length filter, such as "degli" and "voor". Entries are in folded form and come from live ORCID `affiliation-org-name` values. The list is limited to words that are generic everywhere, so a folded word that also names a place or institution stays out ("para" is the state of Pará; "dell", the Italian "dell'", is also Dell Medical School).

**Upstream Solr error bodies stay off the wire.** ORCID's Solr error responses echo its internal Solr host and Java exception class names. The shared fetch path throws with `captureBody: false` so that upstream body is never forwarded into client-visible `error.data`, and drops the request URL from it — only the status fields remain.

**A 500 naming a Solr exception is a query rejection, not an outage.** ORCID answers a malformed or unknown-field search query with HTTP 500 whose body carries `RemoteSolrException` (verified against the live API), and the framework classifies every upstream 500 as retryable `ServiceUnavailable`. The service reads that body server-side and reclassifies the match as `InvalidParams`, so the same doomed query is not retried through the backoff schedule and the search tools answer with their `query_failed` recovery hint; any other 500 keeps its retryable classification.

**Works responses are capped by a byte budget, not a smaller schema maximum.** At their maxima, `orcid_get_works` (`limit: 1000`) and `orcid_get_work_detail` (100 put-codes) returned 423 KB and 219 KB for 0000-0001-9161-999X, text and `structuredContent` combined. Record size varies too much for a count to bound it — an abstract or a long contributor list makes one work-detail record several times the size of another — so both tools admit records in order while the response stays within 64,000 bytes (`src/mcp-server/tools/response-budget.ts`), and always admit the first record. Each record is charged the larger of its serialized JSON and the text `format()` renders for it, so `structuredContent` and `content[]` each stay within the budget and a whole response stays under 130,000 bytes. On live data the text runs at 0.73–0.93× the JSON, so the JSON decides; charging the larger covers records whose text outweighs it, such as an untitled work (`### (untitled)`) or name-less contributors (`- (unnamed)`), which a JSON-only budget let reach 142 KB and 299 KB combined in test fixtures. `orcid_get_works` reports the cut through its existing `truncated`/`nextOffset`. `orcid_get_work_detail` collapses repeated put-codes before the bulk request (the endpoint answers a repeat with the record plus an invalid-put-code error), keeps records in the order the bulk endpoint returns them, which is not the request order, and lists the rest in request order in `deferredPutCodes` with a notice. `limit` and `put_codes` keep their maxima, and upstream pagination, canvas spillover, and an outline shape stay out of scope.

**One work-detail record is bounded on its own.** A record's contributor list and deposited citation have no schema limit: one ATLAS paper lists 5,246 contributors (774 KB across both surfaces), and Scopus deposits BibTeX naming every author (60,532 B for a 3,614-author LIGO paper). The always-admitted first record would otherwise carry that past the budget. `orcid_get_work_detail` therefore keeps the first 100 contributors in upstream order, then every later entry whose iD is the requested one, adding `contributorCount` and `contributorsTruncated` to a cut record only. The owner is matched by iD alone: in large collaborations the owner often appears by name only, and initials-form names collide. A citation over 8,192 UTF-8 bytes is dropped for `citationOmitted`, since a cut BibTeX entry is invalid and the DOI remains. Across 930 sampled works, 100 contributors keeps every biology, medicine, and epidemiology record whole except one 176-author trial, and 200 would keep 8 more at twice the cost of every heavy record; the largest capped record measured 11,421 B. The other fields are schema-bounded (abstract 5,000 characters, titles 1,000), and the first-record fallback stays for whatever remains. Costs are measured after the caps, so `response-budget.ts` is unchanged.

**Search responses share the byte budget.** At `rows: 1000`, `orcid_search_researchers` returned 182,987 B of `structuredContent` and 147,752 B of text for `family_name: Smith`. Results are admitted in ORCID's order under the same budget, each charged the larger of its JSON and the block `format()` renders for it. The envelope includes the enrichment fields, because `effectiveQuery`, `numFound`, `truncated`, and `notice` reach both surfaces, and `nextStart` at its widest; the larger of its JSON and its text twin (page header plus enrichment trailer) is charged. A cut page reports the results it returned in `rows` and continues from `nextStart` under the existing 10,000-offset rule, and ORCID's order is stable across calls, so a `start`-based continuation from any cut neither skips nor repeats. No field is added: `truncated` keeps meaning the 10,000-offset ceiling, and `rows` keeps its 1,000 maximum, since record size, not count, is what varies.

**Free text is plain text at the normalizer boundary; the citation is the exception.** Depositing systems leave inline markup in work titles and abstracts (`<i>in vivo</i>`, `<sup>32</sup>P`, `<h4>Background</h4>`), which reached both result surfaces raw. One helper, `toPlainText` (`src/services/orcid/markup-text.ts`), cleans work summary and detail `title`, `subtitle`, `journalTitle`, and `abstract`, plus funding and research-resource titles. It strips tags generically and keeps their text. Inline formatting tags (`i`, `b`, `em`, `strong`, `sup`, `sub`, `u`, `span`, `a`, and their JATS counterparts such as `italic`) join their neighbours directly, so `<sup>32</sup>P` becomes `32P` and `<i>Editing</i>.` becomes `Editing.`. Every other tag, `<h4>` and unknown names included, leaves a single space, so block tags cannot fuse words. Whitespace beside a removed tag collapses to one space (`by  <i>in vivo</i>  editor` becomes `by in vivo editor`). It then decodes character references in one pass, so `&amp;lt;` becomes `&lt;` and an encoded `&lt;i&gt;` stays literal text. Text with no tag or reference passes through byte-identical, and the output is not Markdown-escaped. `citation.value` is left untouched: it is the deposited BibTeX, and the text surface renders it inside a code fence the value cannot close (next decision).

**Third-party text is marked as data in `content[]`.** Names, biographies, keywords, titles, abstracts, and organization and source names are written by researchers and depositing systems. A line break in one opened a heading or bold label that read as the server's own (`**Name:** Josiah Carberry` / `## Forged heading`), a biography rendered as bare paragraphs, and a backtick fence inside a citation closed its fence early. `format()` marks this text through `src/mcp-server/tools/third-party-text.ts`: `blockquote` for multi-line prose (profile `biography`, work-detail `abstract`) — CRLF and CR read as LF, each line prefixed `> `, a blank line `>`; `singleLine` for every inline slot — headings, `**Label:**` values, list items, joined name and institution lists, `sources` names, URLs, and organization identifiers — folding each run of CR/LF to one space; and `fence` for `citation.value`, a backtick fence one longer than the longest run inside it (three at minimum), enclosing the value byte for byte. URLs and organization identifiers are flattened because ORCID's member API checks neither for shape on deposit, so a depositor's value reaches the text as written. Dates, put-codes, country codes, enumerated fields, work and research-resource identifier types (from ORCID's identifier-type list), and ORCID's own bulk error messages — values ORCID validates or writes itself — render as before. Nothing is Markdown-escaped, so the previous decision's non-goal stands: once no line can start inside a value, a `#` or `*` in it cannot forge structure, and escaping every one in scientific titles would cost readability. `structuredContent` and the two JSON resources keep every value verbatim, CR/LF included. The marking happens inside `renderWork`, `renderWorkDetail`, and the search per-result renderer, so the response budget charges the rendered text (the `> ` prefix adds two bytes per abstract line), and the server `instructions` call this text data, never instructions. Rejected: `<data>` tags, since a value can contain `</data>`, and fencing every field, since a fence cannot sit inside a heading or list item.

**A work's identifiers are its ORCID group's.** ORCID groups the versions of one work that different sources added, preferred version first: on every multi-summary group sampled, `work-summary[0]` holds the highest `display-index`. `orcid_get_works` builds each record from that summary, but taking its identifiers alone dropped what only another source holds — typically a PMID or PMCID from an institutional import beside a Crossref DOI (187 of 329 works on `0000-0003-3632-5512` lost a PMID). `externalIds` is therefore the representative's own list in upstream order, `part-of` IDs included, followed by each group-level `external-ids` entry not already present. Entries match on type, relationship, and ORCID's `external-id-normalized.value` (trimmed raw value when absent), so a DOI spelled in two cases appears once, in the representative's spelling. Group-level `source-work-id` entries are skipped: a source-local ID detached from its source would read as the representative's own. Group-level entries are always `self`, so another summary's `part-of` ISSN is not reachable and container IDs stay consistent with the representative's `journalTitle`. `orcid_get_work_detail` stays per put-code — one source's record — so its list can be shorter.

**One funding record per ORCID funding group, with distinct periods kept.** ORCID groups funding items that share a grant identifier, preferred version first, exactly as it groups works; returning every summary double-counted grants deposited twice (`0000-0002-1665-4768`: 10 records for 5 grants) and split renewals into unrelated records. `orcid_get_funding` returns one record per group from `funding-summary[0]`, so `fundingCount` counts funding items. Unlike a work's versions, one grant number can legitimately span distinct award periods (`EY06338 NEI` on `0000-0002-3489-8176`: 1985-01, 1991-08 – 1994-07, 1994-08 – 1998-07), so when the versions record two or more distinct dated `{startDate, endDate}` pairs the record adds `periods`, every distinct pair ordered by start date; a version with neither date contributes none, and a duplicate deposit adds nothing. Rejected: merging the periods into one span (it states a span no version recorded, and an open-ended version makes the end ambiguous), and a `versionCount` field (it leaves the periods themselves unreachable, since funding has no detail tool). A non-representative version's differing title is not carried. Group-level funding identifiers are not unioned as works' are: across 285 sampled funding groups none held an identifier missing from the representative.

**Every activity record reports who asserted it.** ORCID stores a `source` on every item: `source-orcid` (a person) or `source-client-id` (a member organization system), plus an optional `assertion-origin-*` naming the party the source asserted on behalf of. Verification turns on that distinction, and much of ORCID is not researcher-entered (Oklahoma State University's own system asserted an employment on `0000-0003-3632-5512`; funders and institutions assert funding). Every record from the six activity tools therefore carries `sources: Array<{ name?, assertionOriginName?, selfAsserted }>`: `name` is `source-name`, `assertionOriginName` is `assertion-origin-name`, and `selfAsserted` is whether the asserting party — the assertion origin when recorded, otherwise the source — is the requested iD. Only `-orcid` references are compared, because a member client's path can share the iD format (Crossref's is `0000-0001-9884-1913`), so the activity normalizers take the requested iD. Search-and-link tools (Scopus, Europe PMC, DimensionsWizard) add items as a member client with the researcher as assertion origin, so those are `selfAsserted: true` and render `<researcher> via <tool> (self-asserted)`. A grouped work or funding record lists every distinct source in its group — distinct by source reference plus assertion-origin reference — the representative's first; other records list one; no `source` gives `[]`. Rejected: a `kind: 'researcher' | 'organization'` keyed on `source-orcid` vs `source-client-id`, which ignores assertion origin and would label every search-and-link deposit organizational; reporting only the representative's source, which hides an organization's corroboration in 208 of 329 works on `0000-0003-3632-5512`; and exposing the raw source IDs, which no tool resolves. The works resource stays compact, without `sources`.

---

## Known Limitations

- **`expanded-search` result fields are fixed** — `expanded-search` returns `orcid-id`, `given-names`, `family-names`, `credit-name`, `other-name[]`, `email[]`, `institution-name[]`. It cannot return keywords, biography, or external identifiers inline; those require a follow-up `/person` fetch.
- **Public API capped at 10,000 search results** — queries for common names at large institutions will hit the offset limit. The tool surfaces `numFound` so agents know the total.
- **Researcher-controlled visibility** — ORCID items come from the researcher or from member organizations, and the researcher controls their visibility. A researcher may have set affiliations, works, or contact info to private. The server returns what is public and notes when sections are empty.
- **Works list is summaries only** — the `/works` endpoint returns work summaries (title, type, date, external IDs), not abstracts or contributors. `orcid_get_work_detail` fetches those per put-code; for metadata ORCID does not hold, chain to Crossref (DOI), PubMed (PMID), or arXiv.
- **Funding sparsely populated** — most records carry no funding, even for researchers who hold grants. Absence of funding records does not mean absence of funding.
- **Org disambiguators are heterogeneous** — `disambiguated-organization-identifier` may carry a GRID ID, ROR ID, or Ringgold ID depending on what was recorded when the affiliation was added. Normalize by checking `disambiguation-source`.
- **ORCID iD format** — bare format is `0000-0001-2345-6789` (four groups of four digits, hyphen-separated, check digit `0`–`9` or `X`). Tool `orcid_id` also accepts the URI forms ORCID's resolver accepts (`https://orcid.org/…`, `http://`, scheme-less `orcid.org/…`, a `www.` host, a trailing slash) and a lowercase `x` check digit; `normalizeOrcidId` reduces every form to the bare iD with an uppercase `X` before the checksum check and every API call, because the Public API answers 404 for a lowercase `x`. Scheme and host stay lowercase and the iD stays hyphenated: the advertised JSON Schema `pattern` cannot carry regex flags, and the API 404s an unhyphenated iD. The shape check aborts, so the checksum message appears only for a well-shaped iD. Resource URI params take only the bare iD — a URI segment cannot carry `/` and is not percent-decoded.
- **No write access** — Public API is read-only. Adding or updating ORCID records requires the Member API with OAuth from the researcher.

---

## API Reference

### Search fields (Solr syntax)

**Biographical:** `given-names`, `family-name`, `given-and-family-names`, `credit-name`, `other-names`, `email`, `keyword`, `external-id-reference`, `external-id-type-and-value`, `biography`

**Affiliations:** `affiliation-org-name`, `ror-org-id` (quote full URL), `ringgold-org-id`, `grid-org-id`

**Funding:** `funding-titles`, `fundref-org-id`, `grant-numbers`

**Works:** `work-titles`, `digital-object-ids`, `doi-self`, `pmid-self`, `isbn`, and other `[id-type]-self` patterns

**Peer review:** `peer-review-type`, `peer-review-role`, `peer-review-group-id`

**Record:** `orcid`, `profile-submission-date`, `profile-last-modified-date`

**All fields:** `text` (default, searches across entire record)

Boolean operators: `AND`, `OR` (uppercase). Phrase search: `"quoted phrase"`. Max rows per call: 1000. Max offset for public API: 10,000.

Both `/search/` and `/expanded-search/` support the same Solr field syntax. Use `/expanded-search/` when inline name and institution data is needed (the default); use `/search/` only when consuming just ORCID iDs at scale.

**Query construction for `orcid_search_researchers`:** structured params map to Solr fields, are escaped, and are ANDed together in a fixed order (given name, family name, affiliation, keyword, ROR ID, DOI, PMID, grant number); blank values contribute no clause, and at least one field must remain. A `given_name` made only of initials (`J.`, `J. A.`) compiles to one `given-names:{letter}*` term per initial, since the phrase `given-names:"J."` matches only a literal "J."; any other value is a phrase. The `query` param is raw Solr, never escaped: alone, it is sent as written; after structured clauses it is ANDed as one group, `… AND (<query>)`, because ungrouped, ORCID's parser binds a top-level `OR` to its neighbor — the term before `OR` becomes required and the alternatives after it optional, so `family-name:"Doudna" AND given-names:Jennifer OR given-names:John` returned only Jennifer. A query whose every top-level clause is an exclusion (`-…`, `!…`, or `NOT …`) stays ungrouped, because a nested group of only exclusions matches nothing on ORCID's Solr (`family-name:"Doudna" AND (-given-names:John)` returns 0, the ungrouped form 5); wrapping it as `(*:* <query>)` was rejected because it widens a positive query to everything. Example: `given_name=Jennifer, family_name=Doudna, doi=https://doi.org/10.1126/science.1258096` → `given-names:"Jennifer" AND family-name:"Doudna" AND doi-self:"10.1126\/science.1258096"`.

### Key endpoint shapes

- `GET /search/?q={query}&rows={n}&start={offset}` → `{ result: [{ orcid-identifier: { path } }], num-found }`
- `GET /expanded-search/?q={query}&rows={n}&start={offset}` → `{ expanded-result: [{ orcid-id, given-names, family-names, credit-name, other-name[], email[], institution-name[] }], num-found }`
- `GET /{orcid_id}/person` → name, other-names (by descending display-index), biography, keywords, researcher-urls, addresses, emails, external-identifiers
- `GET /{orcid_id}/works` → grouped work summaries with external-ids (doi, pmid, arxiv, etc.) and journal-title
- `GET /{orcid_id}/activities` → all activity sections: distinctions, educations, employments, fundings, invited-positions, memberships, peer-reviews, qualifications, research-resources, services, works
- `GET /{orcid_id}/fundings` → group[] with title, type, funder org, grant numbers, start/end dates
- `GET /{orcid_id}/peer-reviews` → group[] keyed by ISSN with reviewer-role, review-type, completion-date, convening-organization

### Rate limits

- Anonymous Public API (per ORCID's API FAQ): 12 req/s, up to 40 requests queued before a 503; 25,000 reads per day per IP address, shared by every caller of a hosted deployment. The 24 req/s figure is the Member API's
- No API key required for public read endpoints
- `Accept: application/json` header required (API also serves XML)
