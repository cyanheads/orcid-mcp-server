# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.10](changelog/0.2.x/0.2.10.md) — 2026-07-16 · 🛡️ Security

orcid_get_work_detail attaches putCode to bulk errors and normalizes whole-request failures into a redacted, still-retryable error contract (#21, #22); record-fetch tools surface their profile_not_found recovery hint (#25); the ORCID API URL no longer leaks into HTML-guard errors (#28).

## [0.2.9](changelog/0.2.x/0.2.9.md) — 2026-07-16 · 🛡️ Security

Solr reserved-character escaping closes a query-injection and upstream-500 gap in both search tools (#18); orcid_resolve_researcher gains a DOI/PMID dual-anchor fallback (#19) and filters generic institution stopwords from overlap matching (#20).

## [0.2.8](changelog/0.2.x/0.2.8.md) — 2026-07-13

orcid_resolve_researcher pairs queryUsed/totalFound with the query that actually produced them, adding primaryQuery/primaryTotalFound for audit trail (#15); docs/design.md reconciled to the 9-tool surface (#17).

## [0.2.7](changelog/0.2.x/0.2.7.md) — 2026-07-13

Local ISO 7064 checksum validation rejects invalid ORCID iDs before upstream calls (#14); orcid_get_works gains limit/offset/include_external_ids pagination, the works resource caps to a compact first-25 page (#16); adopts mcp-ts-core ^0.10.14 and Bun/Socket supply-chain hardening.

## [0.2.6](changelog/0.2.x/0.2.6.md) — 2026-06-20

Adopt @cyanheads/mcp-ts-core ^0.10.9 — devcheck gains two static guards (floating dependency specifiers, plugin marketplace manifest correctness); synced framework scripts, skills, and devcheck config. No tool, resource, or server source changed.

## [0.2.5](changelog/0.2.x/0.2.5.md) — 2026-06-19

Adopt @cyanheads/mcp-ts-core ^0.10.8 — ctx.content media collector, canvas SQL-gate invalid_sql classification, DuckdbProvider.describe() filter fix, fresh-scaffold devcheck/changelog guards; dependency refresh and synced framework scripts/skills

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-06-19

Non-existent-iD handling for orcid_get_research_resources; start cap on orcid_search_researchers; researcher-profile resource no longer leaks the upstream URL or error body on 404

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-06-12

Adopt @cyanheads/mcp-ts-core 0.10.6; bundle cleaner strips dev deps and dependency-shipped agent docs; explicit createApp identity; Dockerfile healthcheck

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-06-04 · ⚠️ Breaking

orcid_get_work_detail bulk endpoint — accepts put_codes array (1–100); BREAKING: rename from put_code

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-06-02

Adopt @cyanheads/mcp-ts-core 0.9.21 — per-request log context fix, secret-stripped error messages, withRetry fail-fast; sync skills and scripts

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-05-30

Work detail fetch, research resources tool, notFound guard for missing ORCID iDs, Solr quote fixes for name searches

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-30

Enrichment adoption: query echoes, result totals, empty-result guidance in typed enrichment block; dead error contracts removed (no_results, no_candidates)

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-28

mcp-ts-core ^0.9.9 → ^0.9.13: 413 body cap, HTTP session gate, quieter auth error logs, GET /mcp keywords; hosted endpoint; dep refresh

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-26

Metadata alignment — author, funding, install badges, Docker badge, npm badge, FUNDING.yml

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-25

Fix Docker build — switch scripts from tsx to bun

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-25

Add mcpName field for MCP Registry publishing; trim server.json description to 100-char limit

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-25

ORCID iD format validation, 404 error contract fix, description cleanup

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-25

Initial release — 7 tools and 2 resources for the ORCID Public API v3.0
