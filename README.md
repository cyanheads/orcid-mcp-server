<div align="center">
  <h1>@cyanheads/orcid-mcp-server</h1>
  <p><b>Search and retrieve researcher profiles, works, affiliations, funding, and peer review records from the ORCID registry via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/orcid-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/orcid-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/orcid-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/orcid-mcp-server/releases/latest/download/orcid-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=orcid-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3JjaWQtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22orcid-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Forcid-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://orcid.caseyjhand.com/mcp](https://orcid.caseyjhand.com/mcp)

</div>

---

## Overview

Researcher identity data from the ORCID registry. Search and disambiguate authors, build a researcher dossier from profile, works, affiliations, funding, and peer review records, and chain external identifiers to Crossref, PubMed, or arXiv from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `orcid_search_researchers` | Search the ORCID registry using structured field params (name, affiliation, keyword, ROR ID, DOI, PMID, grant number) |
| `orcid_get_profile` | Fetch a researcher's public profile — name, other names, biography, keywords, researcher URLs, external identifiers |
| `orcid_get_works` | Retrieve works (publications, datasets, software, preprints) for a researcher, paginated |
| `orcid_get_work_detail` | Fetch full detail records — abstracts, contributors, citations — for 1–100 works by put-code |
| `orcid_get_affiliations` | Fetch affiliation records: employment, education, memberships, and more |
| `orcid_get_funding` | Fetch funding records: grants, contracts, awards, and salary awards |
| `orcid_get_peer_reviews` | Fetch peer review activity: convening organizations, reviewer role, review type |
| `orcid_get_research_resources` | List research resources — compute allocations, equipment access, lab facilities |
| `orcid_resolve_researcher` | Disambiguate an ambiguous author name to a ranked list of verified ORCID iD candidates |

### Resources

| Resource | Description |
|:---|:---|
| `orcid://researcher/{orcid_id}/profile` | Researcher profile (person section) — name, other names, bio, keywords, external IDs |
| `orcid://researcher/{orcid_id}/works` | Works list for a researcher — the first 25 plus the total count |

All resource data is also reachable via tools. Use resources when injecting stable researcher context into a prompt; use tools when filtering or processing results is needed.

## Capability reference

### `orcid_search_researchers` <sub>tool</sub>

- Structured params — `given_name`, `family_name`, `affiliation`, `keyword`, `ror_id`, `doi`, `pmid`, `grant_number` — AND together automatically; `query` adds raw Solr syntax — sent as written when it is the only field, otherwise ANDed as one parenthesized group so a top-level `OR` keeps its alternatives (an exclusion-only query such as `-keyword:x` is ANDed ungrouped, since ORCID matches nothing for a group of only exclusions)
- At least one param must be non-blank — an empty or whitespace-only search is rejected rather than run against the whole registry
- `given_name` phrase-matches, except that a value of only initials (`J.`, `J. A.`) matches given names starting with each letter
- `doi` and `pmid` map to `doi-self` / `pmid-self` field queries — finds researchers who linked that specific work to their ORCID record. URL and label forms (`https://doi.org/…`, `doi:…`, `https://pubmed.ncbi.nlm.nih.gov/…/`, `PMID:…`) are accepted and reduced to the bare identifier
- `ror_id` takes a ROR ID bare (`00f54p054`) or as a `ror.org` URL (`https://ror.org/…`, `ror.org/…`, a `www.` host, a trailing slash), in either letter case, and is reduced to the `https://ror.org/<lowercase id>` form ORCID indexes; a value that is not a ROR ID, or whose check digits do not match, is rejected before any search runs
- `grant_number` phrase-matches the grant numbers on researchers' funding items, case-insensitively, over the parts between separators such as hyphens and slashes — `5F31MH010500` also matches `5F31MH010500-03`, but a number cut mid-part matches nothing — pair with `orcid_get_funding` to inspect each match
- `rows`: 1–1000 (default 20); `start`: 0–10,000 offset pagination (the ORCID Public API's ceiling for unauthenticated requests)
- A page also stops before its structured output or its text would pass 64,000 bytes, so the returned `rows` can come in below the requested count; `nextStart` continues from the first result left out
- Returns expanded-search results with inline name and institution data — no follow-up profile fetch needed for basic discovery
- Use for precise field-anchored lookups; use `orcid_resolve_researcher` for ambiguous names needing ranked disambiguation

---

### `orcid_get_profile` <sub>tool</sub>

- Accepts a bare ORCID iD (`0000-0001-2345-6789`) or an orcid.org URI (`https://orcid.org/…`, `orcid.org/…`, a `www.` host, a trailing slash); a lowercase `x` check digit is canonicalized to `X`. Every tool that takes `orcid_id` accepts the same forms; the `orcid://researcher/{orcid_id}/…` resources take the bare iD
- Returns name, other names (former names, transliterations, initialed forms), biography, keywords, researcher URLs, external identifiers (Scopus Author ID, ResearcherID, Loop, etc.), emails, and country codes — all in one response
- Only publicly visible fields are returned; researchers control per-field visibility. A `notice` names every section with no public data (e.g. "no public email addresses or countries"), since an empty section can be private rather than empty
- Entry point for building a researcher dossier before fetching works or affiliations

---

### `orcid_get_works` <sub>tool</sub>

- Returns the first 50 works by default (`limit` max 1000); page with `offset` and the returned `nextOffset` — `workCount` reports the total available
- A page also stops before its structured output or its text would pass 64,000 bytes, so `returnedCount` can come in below `limit`; `truncated` and `nextOffset` carry the continuation either way
- Set `include_external_ids` to `false` to drop DOI/PMID/arXiv/ISBN identifier lists for a lighter payload
- One record per ORCID work group; its identifiers are the group's — the preferred version's own, then any another source holds, such as a PMID beside a Crossref DOI
- External identifiers are pre-formatted for chaining to Crossref, PubMed, or arXiv
- Summaries only — pass a work's `putCode` to `orcid_get_work_detail` for abstracts and contributor lists
- Each work lists its `sources` — the researcher, or member organizations such as Crossref or a university system — with `selfAsserted` marking what the researcher asserted; an empty list does not mean no publications

---

### `orcid_get_work_detail` <sub>tool</sub>

- `put_codes`: 1–100 per call (from `orcid_get_works`), resolved in a single round-trip; a repeated put-code is fetched once
- Returns abstract, contributors with CRediT roles, the record's external IDs, citation metadata (BibTeX or other deposited formats), journal title, and URL
- A record listing more than 100 contributors keeps the first 100 plus the researcher's own entries, matched by ORCID iD, with `contributorCount` and `contributorsTruncated` marking the cut; a citation over 8,192 bytes is left out and flagged `citationOmitted`, so a large-collaboration paper fits beside other records
- Each put-code is one source's version of the work, so its identifiers can be fewer than `orcid_get_works` lists for the work group; `sources` names that source
- Per-put-code failures (not found or inaccessible) arrive as `errors` entries — the rest of the batch still resolves
- Records are added until the structured output or the text would pass 64,000 bytes; put-codes left out come back in `deferredPutCodes` with a notice, ready to pass as `put_codes` in the next call
- An upstream rate limit surfaces as a `RateLimited` error carrying ORCID's `retryAfter` when it sent one

---

### `orcid_get_affiliations` <sub>tool</sub>

- `types` filters which sections to return: `employment`, `education`, `invited-positions`, `distinctions`, `memberships`, `qualifications`, `services`, or `all` — default is employment + education; an explicit empty list is rejected
- One upstream call regardless of how many types are requested
- Returns organization name, disambiguated ID (ROR/GRID/Ringgold), department, role, and date range per record
- Each record's `sources` names who added it — the researcher, or a member organization such as a university research information system; an empty result does not mean no affiliation

---

### `orcid_get_funding` <sub>tool</sub>

- No filtering params — returns the complete funding list for the ORCID iD in one call
- Returns funding type (grant, contract, award, salary-award), funder name and disambiguated ID (Crossref Funder ID/ROR), grant numbers, and funding period
- One record per ORCID funding group, from its preferred version — a grant deposited twice counts once in `fundingCount`; when the group's versions record distinct award periods, such as renewals under one grant number, `periods` lists each
- Funding comes from the researcher or from member organizations (funders, institutions, search-and-link tools), and each record's `sources` names which; most researchers with real grants have no entries here, and absence does not imply no funding

---

### `orcid_get_peer_reviews` <sub>tool</sub>

- No filtering params — returns the complete peer review history for the ORCID iD in one call
- Returns reviewer role (`reviewer`, `editor`, `chair`, etc.), review type, completion date, an ISSN-keyed group identifier, and the convening organization ORCID records per record
- The convening organization is often the service that imported the review (Publons, Clarivate) rather than the journal; ORCID returns no journal name, so the ISSN is the journal key and heads each review that has one
- Reviews come from the researcher or from member organizations that import them, and each record's `sources` names which; coverage varies widely by researcher

---

### `orcid_get_research_resources` <sub>tool</sub>

- Covers compute allocations, equipment access, lab facilities, data resources, and clinical study registrations
- A newer, sparsely populated ORCID section — most researchers have zero entries, and absence does not imply none exist
- Entries are typically deposited by resource-allocation systems (e.g. ACCESS, XSEDE) rather than added by the researcher
- Returns resource title, hosting organization (with disambiguated ID), external identifiers (often a portal URI), access period, and the `sources` that deposited it

---

### `orcid_resolve_researcher` <sub>tool</sub>

- Returns ranked candidates (5 default, up to 20 via `rows`) with transparent disambiguation signals: name match type (`exact`/`partial`/`other-name`/`none`), institution overlap flag, and anchor type (`doi`/`pmid`/`none`)
- Name and institution comparisons are case- and accent-insensitive — `José Baselga` and `Jose Baselga` classify the same candidate identically
- When `doi` or `pmid` is provided (bare or as a URL), uses `doi-self` or `pmid-self` as an anchor — researchers who have linked that work to their ORCID record are near-deterministic matches
- Accepts a full name (`Jennifer Doudna`), a byline with initials (`J. Doudna`, `Jennifer A. Doudna`), or `Family, Given` (`Doudna, Jennifer`, read as `Jennifer Doudna`); an initial counts toward a `partial` match when the candidate's first given name starts with it
- Searches the exact name phrase first, so a name that matches as written sends one query. Each later stage runs only when every earlier one found nothing: the byline form of any initials with the affiliation, then the phrase and the byline without it, then the other names listed on ORCID records, then each supplied anchor alone
- No synthetic scores — raw signal fields only, so callers can apply their own ranking logic

---

### `orcid://researcher/{orcid_id}/profile` <sub>resource</sub>

- Returns name, other names, biography, keywords, researcher URLs, and external identifiers as `application/json`
- `{orcid_id}` is the bare iD, with an `X` or `x` check digit — a URI segment cannot carry the `https://orcid.org/` form
- Fails with a typed `data.reason` and a recovery hint, like the tools: `invalid_orcid_id` for a checksum-invalid iD (rejected locally, before any upstream call), `profile_not_found` for an iD ORCID does not know or a record with no public name
- Prefer the `orcid_get_profile` tool when the response needs to flow into conditional logic

---

### `orcid://researcher/{orcid_id}/works` <sub>resource</sub>

- Returns the first 25 works plus `workCount` (the total available) as `application/json`
- `{orcid_id}` is the bare iD, with an `X` or `x` check digit
- Fails with `invalid_orcid_id` (checksum, before any upstream call) or `profile_not_found` (unknown iD, `data.orcidId` included), each with a recovery hint
- No cursor pagination on this resource — use the `orcid_get_works` tool to page the full list or filter results
- DOIs and PMIDs in the response are ready for Crossref or PubMed chaining

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

ORCID-specific:

- ORCID Public API v3.0 (`https://pub.orcid.org/v3.0`) — no API key required for public read endpoints
- `expanded-search` as the primary search backend — returns ORCID iD, name, and institution data inline, eliminating N+1 profile fetches
- Single `/activities` call for affiliation queries, filtered client-side — eliminates up to 7 parallel upstream calls vs. per-section fetching
- External identifiers (DOIs, PMIDs, arXiv IDs) surfaced in works responses in formats ready for cross-server chaining to Crossref, PubMed, or arXiv
- Inline markup that depositing systems leave in work titles, abstracts, and funding and research-resource titles (`<i>`, `<sup>`, `<h4>`) is stripped to plain text; the deposited citation is relayed verbatim

Agent-friendly output:

- Provenance — `orcid_resolve_researcher` returns raw disambiguation signals (name match type, institution overlap, anchor type) instead of a synthetic confidence score
- Who asserted each item — every record from the six activity tools carries `sources`: the person or member organization that added it (a university system, funder, Crossref, Web of Science) and whether the researcher asserted it (`selfAsserted`); grouped works and funding list every source in the group
- Truncation awareness — `orcid_search_researchers` reports `numFound` and a `truncated` flag against the ORCID Public API's 10,000-offset ceiling, and cuts a page to a 64,000-byte response budget with `nextStart` to continue; `orcid_get_works` reports `workCount` and `truncated` against its own page size and a 64,000-byte response budget
- Partial failure isolation — `orcid_get_work_detail` returns per-put-code errors alongside successfully resolved works instead of failing the whole batch, and names any put-codes the response budget deferred
- Empty-result guidance — `orcid_get_works`, `orcid_get_affiliations`, `orcid_get_funding`, `orcid_get_peer_reviews`, and `orcid_get_research_resources` return a notice when a result is empty, explaining that this may mean neither the researcher nor a member organization added entries, or that visibility settings hide them, rather than confirmed absence; `orcid_get_profile` names each section with no public data
- Record text marked as data — in the text output, biographies and abstracts render as blockquotes, names, titles, and organization names are kept to one line, and a deposited citation sits in a code fence it cannot close, so text a researcher or depositing system wrote never reads as the server's own headings or labels; `structuredContent` carries every value verbatim

## Getting started

### Public Hosted Instance

A public instance is available at `https://orcid.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "orcid-mcp-server": {
      "type": "streamable-http",
      "url": "https://orcid.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. No API key is required — the ORCID Public API is open for public read access.

```json
{
  "mcpServers": {
    "orcid-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/orcid-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "orcid-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/orcid-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "orcid-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/orcid-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key required. The ORCID Public API is open for public read access. Non-commercial use only under [ORCID Public API ToS §2](https://info.orcid.org/public-client-terms-of-service/).

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/orcid-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd orcid-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env if needed — no required vars
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---------|:------------|:--------|
| `ORCID_API_BASE_URL` | Override the ORCID API base URL. Useful for pointing at the sandbox (`https://pub.sandbox.orcid.org/v3.0/`). | `https://pub.orcid.org/v3.0` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. This server declares `stateless` in `createApp()` — no tool asks the caller for input mid-handler — and a set value overrides it. | `stateless` |
| `MCP_PUBLIC_URL` | Public origin for TLS-terminating reverse-proxy deployments | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop (ms). Try `60000` if heap growth is observed under sustained HTTP load. | `0` (disabled) |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t orcid-mcp-server .
docker run --rm -p 3010:3010 orcid-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/orcid-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and resources, inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Nine tools across search, disambiguation, profile, works, work detail, affiliations, funding, peer reviews, and research resources. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Profile and works resources. |
| `src/services/orcid` | ORCID Public API v3.0 service layer — search, record section fetchers, retry/backoff. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in the `createApp()` arrays
- Wrap ORCID API calls: validate raw response → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
