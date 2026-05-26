# orcid-mcp-server

ORCID — persistent digital identifiers for researchers. Connects researchers to their works, affiliations, grants, and peer review activities.

## API

- **Base**: `https://pub.orcid.org/v3.0/`
- **Auth**: Public API — free, no key required for read access. Member API requires institutional membership.
- **Rate limits**: Public API — 24 requests/second, 40 burst
- **Docs**: https://info.orcid.org/documentation/api-tutorials/
- **Search**: `https://pub.orcid.org/v3.0/search/`

## Key data

- **Researcher profiles**: Name, biography, keywords, external identifiers
- **Works**: Publications linked to ORCID iDs (DOIs, PMIDs, arXiv IDs)
- **Affiliations**: Employment, education, invited positions, memberships, qualifications
- **Funding**: Grants and awards received
- **Peer review**: Review activity (journal, group, subject)
- **External identifiers**: Scopus, ResearcherID, Loop, etc.

## Cross-domain value

| Chain to | Query |
|---|---|
| OpenAlex | ORCID → full publication record with citations and co-authors |
| PubMed | ORCID → biomedical publications |
| Crossref | ORCID → DOI-level metadata |
| arXiv / bioRxiv | ORCID → preprints |
| ClinicalTrials.gov | Researcher → trials they're involved in |
| USPTO | Researcher → patents they hold |
| Wikidata | ORCID ↔ Wikidata researcher entity (P496 property) |

## Tool ideas

- `orcid_search_researchers` — find researchers by name, keyword, affiliation, ORCID iD
- `orcid_get_profile` — full researcher profile
- `orcid_get_works` — publications associated with an ORCID iD
- `orcid_get_affiliations` — employment and education history
- `orcid_get_funding` — grants and awards
- `orcid_get_peer_review` — review activity summary

## Licensing (audited 2026-05-25)

- **Status: Caution — non-commercial restriction on Public API**
- Public API ToS §2: "non-commercial use" only — "you may not charge any re-use fees for the Public APIs, and you may not make use of the public APIs in connection with any revenue-generating product or service"
- Fine for open-source / free hosted MCP server
- If the server becomes part of a commercial offering, ORCID **organizational membership** (paid) is required to access the Member API
- Source: https://info.orcid.org/public-client-terms-of-service/
- Rate limits are generous: 24 req/s, 40 burst on public API

## Notes

- ORCID is the researcher disambiguation layer — 19M+ registered researchers
- Natural complement to OpenAlex (which already indexes ORCID iDs) but ORCID has authoritative self-reported data (affiliations, funding) that OpenAlex doesn't
- Public API is generous: no auth, 24 req/s — one of the easiest to build against
- "Research literature mapping" scenario in CROSS-DOMAIN.md benefits directly from researcher identity resolution
