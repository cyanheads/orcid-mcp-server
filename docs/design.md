# orcid-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `orcid_search_researchers` | Search the ORCID registry. Structured params build a Solr query; all provided params are ANDed. Returns ORCID iDs with inline name and institution data via `expanded-search`. Use when you know specific field values (name, affiliation, keyword). For author disambiguation from an ambiguous name, use `orcid_resolve_researcher` instead. | `given_name`, `family_name`, `affiliation`, `keyword`, `ror_id`, `doi`, `pmid`, `query` (raw Solr, appended to structured params), `rows`, `start` | `readOnlyHint: true`, `openWorldHint: true` |
| `orcid_get_profile` | Fetch a researcher's public profile: name, biography, keywords, researcher URLs, and external identifiers (Scopus ID, ResearcherID, Loop, etc.). The entry point for building a researcher dossier. Pass a bare ORCID iD (`0000-0001-2345-6789`) or full URI. | `orcid_id` | `readOnlyHint: true`, `openWorldHint: false` |
| `orcid_get_works` | Retrieve works (publications, datasets, software, preprints, etc.) associated with an ORCID iD. Returns titles, work types, publication dates, journal names, and all external identifiers — DOIs, PMIDs, arXiv IDs — ready for chaining to Crossref, PubMed, or arXiv servers. | `orcid_id` | `readOnlyHint: true`, `openWorldHint: false` |
| `orcid_get_work_detail` | Fetch full detail records for 1–100 works by their put-codes in a single bulk request. Returns abstracts, contributors with CRediT roles, the complete external ID list (DOI, PMID, arXiv, ISBN), citation metadata, journal title, and URL per work. Put-codes come from the `putCode` field of `orcid_get_works`; per-record errors are surfaced rather than failing the whole call. | `orcid_id`, `put_codes` | `readOnlyHint: true`, `openWorldHint: false` |
| `orcid_get_affiliations` | Fetch affiliation records for a researcher. `types` controls which sections to return: `employment`, `education`, `invited-positions`, `distinctions`, `memberships`, `qualifications`, `services`, or `all`. Default is `employment` and `education`. Returns organization names, disambiguated org IDs (ROR/GRID/Ringgold), departments, roles, and date ranges. | `orcid_id`, `types` | `readOnlyHint: true`, `openWorldHint: false` |
| `orcid_get_funding` | Fetch funding records for a researcher: grants, contracts, awards, and salary awards, with funder names, grant numbers, and funding periods. Funding data is self-reported and often sparse — absence does not mean no funding. | `orcid_id` | `readOnlyHint: true`, `openWorldHint: false` |
| `orcid_get_peer_reviews` | Fetch peer review activity: convening organizations (journals/publishers), reviewer role (`reviewer`, `editor`, `chair`, etc.), review type, completion dates, and ISSN-keyed group identifiers. Use to assess a researcher's editorial activity and journal affiliations. | `orcid_id` | `readOnlyHint: true`, `openWorldHint: false` |
| `orcid_get_research_resources` | List research resources associated with a researcher — compute allocations, equipment access, lab facilities, data resources, and clinical study registrations. A newer, sparsely-populated ORCID section; most researchers have no entries. Returns resource title, hosting organization, external identifiers, and access period. | `orcid_id` | `readOnlyHint: true`, `openWorldHint: false` |
| `orcid_resolve_researcher` | Disambiguate an author name to a verified ORCID iD. Returns a ranked list of candidates (5 by default, up to 20 via `rows`) with transparent signals: name match type, institution overlap, and whether a DOI/PMID anchor was used. Use this (not `orcid_search_researchers`) when the input is an ambiguous name that needs ranked disambiguation. `doi` or `pmid` anchor the search to a specific work. | `name`, `affiliation`, `doi`, `pmid`, `rows` | `readOnlyHint: true`, `openWorldHint: true` |

### Resources

| URI Template | Description | When to use | Pagination |
|:-------------|:------------|:------------|:-----------|
| `orcid://researcher/{orcid_id}/profile` | Researcher profile (person section: name, bio, keywords, external IDs). Use when injecting researcher identity context into a prompt or when the agent needs to check whether a profile includes a specific external ID (e.g., Scopus ID for chaining). | Stable inline context; prefer the tool when the response needs to flow into conditional logic. | No |
| `orcid://researcher/{orcid_id}/works` | Works list for a researcher. Use when providing a researcher's publication list as background context for summarizing or reviewing a body of work. DOIs and PMIDs in the response are ready for Crossref/PubMed chaining. | Stable inline context; prefer the tool when filtering or processing results is needed. | No |

### Prompts

None — the server is data-oriented. No recurring interaction patterns warrant a structured prompt.

---

## Overview

`orcid-mcp-server` wraps the ORCID Public API v3.0 (`https://pub.orcid.org/v3.0/`), exposing the ORCID registry as a researcher identity and activity layer for LLM agents.

ORCID is the canonical disambiguation namespace for researchers: 19M+ registered profiles, each with a persistent `0000-XXXX-XXXX-XXXX` identifier. It carries authoritative self-reported data — affiliations, funding, peer review activity — that complementary servers like OpenAlex and PubMed don't have. The primary agent workflows are:

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
- Rate limit: 24 req/s, 40 burst — generous, no throttling logic needed beyond basic retry
- Public API search is limited to 10,000 results (offset limit); queries returning more than this should note the truncation
- Non-commercial use only under Public API ToS

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OrcidService` | ORCID Public API v3.0 (`https://pub.orcid.org/v3.0/`) | All tools |

Single service with two method groups: `search()` (calls `/expanded-search/` and `/search/`) and `record()` (calls `/{orcid_id}/{section}` endpoints). Both share a base URL, retry logic, and JSON Accept header.

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
| Researcher (search) | `GET /expanded-search/?q=...` `GET /search/?q=...` | `orcid_search_researchers`, `orcid_resolve_researcher` |
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

### `orcid_resolve_researcher` (1–2 upstream calls)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /expanded-search/?q={query}&rows={rows}` | Candidate list with inline name and institution data. Query is built from: `given-and-family-names:{name}` + optional `doi-self:{doi}` or `pmid-self:{pmid}` anchor + optional `affiliation-org-name:{affiliation}`. |
| 2 | (conditional) `GET /expanded-search/?q={relaxed_query}&rows={rows}` | Relaxed query (drop affiliation constraint) if initial results are zero. |

The handler scores candidates by: exact name match weight, affiliation string overlap with the `affiliation` input, and presence of the provided DOI/PMID in the query anchor (a DOI/PMID match is near-deterministic). Returns candidates with transparent disambiguation signals: name match type (`exact`/`partial`/`other-name`), institution overlap flag, and anchor type (`doi`/`pmid`/`none`). No synthetic scores — raw signals only.

**When DOI or PMID is provided:** `doi-self:{doi}` in the query acts as an anchor — the result set will include only researchers who have linked that work to their ORCID record. The name is still included in the query to guard against edge cases (works linked by institutions, not the author). If no match returns with the name included, the handler retries with only the identifier anchor.

---

## Design Decisions

**`expanded-search` as the primary search backend for all queries.** ORCID has two search endpoints: `/search/` (returns only ORCID iDs, requiring N+1 follow-up profile fetches) and `/expanded-search/` (returns iD + name + institutions inline). Both support the same Solr field syntax including `doi-self`, `pmid-self`, `ror-org-id`, `affiliation-org-name`, `given-names`, and `family-name`. `orcid_search_researchers` and `orcid_resolve_researcher` use `expanded-search` exclusively — agents get useful results in one call.

**`doi` and `pmid` added to `orcid_search_researchers`.** Because `expanded-search` supports `doi-self` and `pmid-self` field queries, identifier-anchored search (e.g., "who authored this DOI?") belongs directly in the search tool. The `doi`/`pmid` params translate to `doi-self:{value}` / `pmid-self:{value}` Solr field clauses ANDed into the query. Use `orcid_search_researchers` for precise lookups; use `orcid_resolve_researcher` when the input is ambiguous and ranked candidates with scoring are needed.

**`orcid_get_affiliations` uses `/activities` — one call, not seven.** The `/activities` endpoint returns all affiliation types (employment, education, invited-positions, distinctions, memberships, qualifications, services) plus works, funding, and peer reviews in a single response. The handler reads `/activities` once and filters the desired sections client-side. This eliminates 6 parallel upstream calls vs. fetching each section independently. Valid `types` values: `employment`, `education`, `invited-positions`, `distinctions`, `memberships`, `qualifications`, `services`, `all`. Default is `['employment', 'education']` (the 90% case).

**No `orcid_get_record` mega-tool.** A single "get everything" tool would be convenient but outputs a massive payload that wastes context budget. The section tools are small, composable, and let agents fetch exactly what they need for their current step.

**Peer review deferred from `orcid_get_affiliations`.** Peer review has a different structure (group IDs, review types, ISSN-keyed groups vs. org-keyed affiliations, `convening-organization` rather than `organization`) and different use cases (editorial activity vs. career history). It stays as its own tool rather than being folded into affiliations.

**Funding is a thin tool.** Funding records are rarely populated. The tool is kept because when it exists it's high-value (grant numbers, funder IDs) — but it's a single-endpoint wrapper, not a workflow.

**External identifiers surface in `orcid_get_profile`, not a separate tool.** The `/external-identifiers` data is embedded in the `/person` response. Profile already fetches person data; including external IDs (Scopus Author ID, ResearcherID, etc.) in the profile response avoids a round-trip and is always relevant when profiling a researcher.

**`ror-org-id` values must be quoted in Solr queries.** ROR IDs are full URLs (`https://ror.org/XXXXXXX`) containing colons, which break bare Solr field queries. The handler must URL-encode or quote the value: `ror-org-id:"https://ror.org/00f54p054"`. The `ror_id` input parameter accepts the raw URL; quoting is handled internally.

**Structured Solr values are escaped, not just quoted.** Quoting alone is insufficient — an embedded quote or backslash still breaks phrase scoping, and unquoted punctuation-heavy DOIs (`10.1002/(SICI)…17:4<290::…`) produce an upstream Solr 500. Both query builders (`search-researchers`, `resolve-researcher`) route every structured value through a single shared `escapeSolrValue` (`src/services/orcid/solr-query.ts`) that backslash-escapes the Lucene reserved set (`\ + - ! ( ) { } [ ] ^ " ~ * ? : | & /`). A universal escaper — applied to every value, quoted or not — is simpler and safer than tracking which fields are quoted; escaping a character that is already literal inside a phrase quote was verified against the live API to be a no-op (identical result count and status). The raw `query` passthrough on `orcid_search_researchers` is deliberately left unescaped so callers can supply intentional Solr operators.

**Upstream Solr error bodies stay off the wire.** ORCID's Solr error responses echo its internal Solr host and Java exception class names. The shared fetch path throws with `captureBody: false` so that upstream body is never forwarded into client-visible `error.data` — only the request URL, status, and status text remain.

---

## Known Limitations

- **`expanded-search` result fields are fixed** — `expanded-search` returns `orcid-id`, `given-names`, `family-names`, `credit-name`, `other-name[]`, `email[]`, `institution-name[]`. It cannot return keywords, biography, or external identifiers inline; those require a follow-up `/person` fetch.
- **Public API capped at 10,000 search results** — queries for common names at large institutions will hit the offset limit. The tool surfaces `num_found` so agents know the total.
- **Researcher-controlled visibility** — ORCID records are self-reported. A researcher may have set affiliations, works, or contact info to private. The server returns what is public and notes when sections are empty.
- **Works list is summaries only** — the `/works` endpoint returns work summaries (title, type, date, external IDs) not full abstracts. For full metadata, chain to Crossref (DOI), PubMed (PMID), or arXiv.
- **Funding sparsely populated** — most researchers don't enter funding data even if they have grants. Absence of funding records does not mean absence of funding.
- **Org disambiguators are heterogeneous** — `disambiguated-organization-identifier` may carry a GRID ID, ROR ID, or Ringgold ID depending on what was recorded when the affiliation was added. Normalize by checking `disambiguation-source`.
- **ORCID iD format** — bare format is `0000-0001-2345-6789` (four groups of four digits, hyphen-separated); the full URI form `https://orcid.org/0000-0001-2345-6789` is also accepted and must be stripped to the path before use in API calls.
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

**Query construction for `orcid_search_researchers`:** structured params map to Solr fields and are ANDed together. The `query` param appends raw Solr to the end of the generated clause. Example: `given_name=Jennifer, family_name=Doudna, doi=10.1126/science.1258096` → `given-names:Jennifer AND family-name:Doudna AND doi-self:10.1126/science.1258096`.

### Key endpoint shapes

- `GET /search/?q={query}&rows={n}&start={offset}` → `{ result: [{ orcid-identifier: { path } }], num-found }`
- `GET /expanded-search/?q={query}&rows={n}&start={offset}` → `{ expanded-result: [{ orcid-id, given-names, family-names, credit-name, other-name[], email[], institution-name[] }], num-found }`
- `GET /{orcid_id}/person` → name, biography, keywords, researcher-urls, addresses, emails, external-identifiers
- `GET /{orcid_id}/works` → grouped work summaries with external-ids (doi, pmid, arxiv, etc.) and journal-title
- `GET /{orcid_id}/activities` → all activity sections: distinctions, educations, employments, fundings, invited-positions, memberships, peer-reviews, qualifications, research-resources, services, works
- `GET /{orcid_id}/fundings` → group[] with title, type, funder org, grant numbers, start/end dates
- `GET /{orcid_id}/peer-reviews` → group[] keyed by ISSN with reviewer-role, review-type, completion-date, convening-organization

### Rate limits

- 24 req/s sustained, 40 req/s burst
- No API key required for public read endpoints
- `Accept: application/json` header required (API also serves XML)
