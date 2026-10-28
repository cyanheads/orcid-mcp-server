---
name: orcid-guide
description: Gates, identifier chains, and Solr query syntax for the orcid_* tools. Use when pinning an author name, DOI, grant number, or institution to an ORCID iD, building a researcher dossier, filtering works by type or year, following put-codes to abstracts and contributors, or writing a raw ORCID query.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

ORCID is an identity registry that researchers curate, not a bibliography or citation index. A record holds what the researcher and member organizations (publishers through Crossref, employers' research systems, funders, review services) added and left public, and it says who asserted each item. Use it to pin an author to a persistent iD and to read affiliations, funding, peer review, and provenance. It carries no citation counts and no full text, and its works list is often partial; use a citation index or Crossref/PubMed for those. Keyless; the anonymous Public API allows 25,000 reads per day per IP address, shared by every caller of a hosted deployment, so fetch what the task needs rather than whole records by reflex.

## Identifiers

| Identifier | Comes from | Pass to |
|:-----------|:-----------|:--------|
| ORCID iD (`0000-0002-1825-0097`; the last character is a check digit, `X` allowed) | `orcidId` on resolver and search results, on every record response, and on linked contributors in work detail | `orcid_id` on every record tool |
| Work put-code | `putCode` on `orcid_get_works` | `put_codes` on `orcid_get_work_detail`, with the same `orcid_id` |
| Funding put-code | `putCode` on an `orcid_get_funding` summary (the preferred deposit of a grant group) | `put_code` on `orcid_get_funding` |
| Proposal put-code | `putCode` on an `orcid_get_research_resources` summary | `put_code` on the same tool, which item paging requires |
| `nextStart` | `orcid_search_researchers` | `start`, same query |
| `nextOffset` | `orcid_get_works`, `orcid_get_peer_reviews` | `offset`, same filters |
| `nextItemOffset` | research-resource detail | `item_offset`, same `put_code` |
| `deferredPutCodes` | `orcid_get_work_detail` | `put_codes` on the next call |
| ROR URL (`https://ror.org/05gq02987`) | `organization.disambiguatedId` on an affiliation whose `disambiguationSource` is ROR | `ror_id` on `orcid_search_researchers` |
| Funder ID (`http://dx.doi.org/10.13039/100000001`) | `funder.disambiguatedId` on funding, source FUNDREF | raw `query` as `fundref-org-id:"…"` |

Put-codes belong to one record. A work put-code sent with another researcher's iD comes back in `errors` as "not a valid put code", not as a work.

## Gates

- **Carry the returned `orcidId`, not the one you sent.** A deprecated (merged) iD is served from its primary record: the response reports the primary iD as `orcidId` and the notice names both. Use the primary in every later call, and treat the two as the same person when matching bylines or other sources.
- **Confirm identity before attributing anything.** `nameMatchType: exact` means only that the names fold equal, and common names have many exact matches. Confirm with a DOI or PMID anchor (`anchorType` other than `none`), `institutionOverlap`, or overlap between the candidate's works and the ones you hold. When `totalFound` exceeds the candidates returned, the person may not be in the list: add `affiliation` or an anchor, or page `orcid_search_researchers`.
- **Absence is not evidence.** An empty or short works, funding, affiliation, or peer-review list means nothing public was added. Never report "no publications", "no grants", or "never worked at X" from ORCID, and a name with no ORCID record may still be a real, published researcher.
- **Weigh who asserted it.** On every item, a source with `selfAsserted: true` is the researcher's own claim (a search-and-link tool acting for them included); `false` means a member organization (or another ORCID user) asserted it. To check a disputed affiliation or authorship, an item the organization concerned asserted is evidence from outside the researcher; a self-asserted one is their word alone.
- **Institutions span past and present.** The `affiliation` search field and the `institutionNames` on search and resolver rows include former institutions. For current or former only, use the raw fields in the query table below. An affiliation without `endDate` is open-ended as deposited, not proof of a current post.
- **Confirm a grant-number hit.** `grant_number` matches the number's parts as a phrase, not as an exact identifier. Read each hit's `orcid_get_funding` summary and check `grantNumbers` holds the exact number. Several people (PI and co-investigators) can list one award.
- **Take the DOI with `relationship: self`.** A work's `externalIds` can also carry `part-of` identifiers that name its container, such as the journal's ISSN or the book's ISBN.
- **Work detail is one version.** The put-code `orcid_get_works` returns is the group's preferred version, so `orcid_get_work_detail` shows that source's record: its `externalIds` and `sources` can be fewer than the work list shows (keep the list's), and `abstract` and `contributors` appear only when that source deposited them. Empty `contributors` does not mean a sole author. Missing abstract or byline: take the DOI or PMID to Crossref or PubMed.
- **Ask for the put-codes you need.** Large-collaboration records are big, so a full batch of 100 can run past a megabyte; send the subset the task uses.
- **Amounts are deposited text.** Funding detail returns `amount.value` and `currency` exactly as deposited. Don't convert, round, or sum across currencies.

## Workflows

### Find the researcher

| You hold | Call |
|:---------|:-----|
| An author name, initials included | `orcid_resolve_researcher`, with the `doi` or `pmid` of one of their works when known and `affiliation` when known |
| A DOI or PMID and no name | `orcid_search_researchers` with `doi` or `pmid`: every record that linked the work, so the paper's co-authors who keep ORCID records |
| A grant number | `orcid_search_researchers` with `grant_number`, then the funding check above |
| An institution | `ror_id` (taken from an affiliation) or `affiliation`; raw fields to split current from former |
| A research topic | `keyword` matches only the keywords researchers set on their profiles; for the topic of their work, raw `work-titles:"…"` or `funding-titles:"…"` |

### Slice a works list

`work_types` takes ORCID's work-type vocabulary, which the schema lists: `journal-article`, `preprint`, `conference-paper`, `book-chapter`, `dissertation-thesis`, `software`, and `data-set` (never `dataset`), among others. It matches the preferred version's type, and a preprint and its journal article can appear as two works. `year_from` and `year_to` read the leading year of `publicationDate`; dates carry whatever precision was deposited (`YYYY`, `YYYY-MM`, or `YYYY-MM-DD`), so never pad a missing month or day. Undated works drop out under a year filter and the notice counts them; when completeness matters, run the type filter alone and check them. `workCount` is the whole record, `matchedCount` the filtered set; page with `nextOffset` and the same filters until it is absent.

### From a work to its people

1. `orcid_get_work_detail` with the iD the put-code came from.
2. A contributor with `orcidId` goes straight to `orcid_get_profile`.
3. A contributor without one: `orcid_resolve_researcher` with their name and this work's DOI as `doi`. A hit with `anchorType: doi` is a record that linked this exact work.
4. A list over 100 contributors keeps the first 100 plus the record owner's own entries; `contributorCount` gives the full byline length.

### Raw Solr queries

`query` takes ORCID's Solr syntax. Operators are uppercase: lowercase `and` is read as a search term, so `family-name:Doudna and given-names:Jennifer` matches millions of records where `AND` matches one. Quote phrases and identifiers that hold punctuation; a leading `-` excludes. Next to structured fields, `query` is ANDed as one parenthesized group.

| Field | Matches |
|:------|:--------|
| `current-institution-affiliation-name`, `past-institution-affiliation-name` | A current or a former affiliation, by organization name |
| `affiliation-org-name` | Either (the `affiliation` parameter) |
| `ringgold-org-id` | A Ringgold ID, bare digits (`ringgold-org-id:6752`) |
| `fundref-org-id` | A funder, as the full quoted URL ORCID stores (`fundref-org-id:"http://dx.doi.org/10.13039/100000001"`); bare and `https://doi.org/` forms match nothing |
| `work-titles`, `funding-titles` | Words in work or funding titles |
| `given-names`, `family-name`, `other-names`, `keyword` | Name parts and profile keywords |

Example, people currently at Brown University with CRISPR in a work title: `current-institution-affiliation-name:"Brown University" AND work-titles:"CRISPR"`. These clauses are also how to split a search whose `truncated` flag says it outruns the 10,000-offset ceiling; current and former affiliations overlap, so dedupe the parts by `orcidId`.
