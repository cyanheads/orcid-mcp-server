<div align="center">
  <h1>@cyanheads/orcid-mcp-server</h1>
  <p><b>Search and retrieve researcher profiles, works, affiliations, funding, and peer review records from the ORCID registry via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/orcid-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/orcid-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/orcid-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/orcid-mcp-server/releases/latest/download/orcid-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=orcid-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3JjaWQtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22orcid-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Forcid-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://orcid.caseyjhand.com/mcp](https://orcid.caseyjhand.com/mcp)

</div>

---

## Tools

Nine tools organized around three workflows — author disambiguation, researcher profiling, and cross-server identifier chaining:

| Tool | Description |
|:-----|:------------|
| `orcid_search_researchers` | Search the ORCID registry using structured field params (name, affiliation, keyword, ROR ID, DOI, PMID). All params are ANDed into a Solr query against the expanded-search endpoint, returning ORCID iDs with inline name and institution data. |
| `orcid_get_profile` | Fetch a researcher's public profile: name, biography, keywords, researcher URLs, and external identifiers (Scopus Author ID, ResearcherID, Loop, etc.). |
| `orcid_get_works` | Retrieve works (publications, datasets, software, preprints) for a researcher. Returns summaries with put-codes, titles, types, dates, journal names, and external identifiers. Pass put-codes to `orcid_get_work_detail` for abstracts and full contributor lists. |
| `orcid_get_work_detail` | Fetch full detail records for 1–100 works by their put-codes in a single bulk request (from `orcid_get_works`). Returns abstracts, all contributors with CRediT roles, complete external IDs, citation metadata, journal title, and URL. Per-record errors are surfaced without failing the whole call. |
| `orcid_get_affiliations` | Fetch affiliation records for a researcher. Accepts a `types` list to filter which sections to return: `employment`, `education`, `invited-positions`, `distinctions`, `memberships`, `qualifications`, `services`, or `all`. |
| `orcid_get_funding` | Fetch funding records: grants, contracts, awards, and salary awards, with funder names, grant numbers, and funding periods. |
| `orcid_get_peer_reviews` | Fetch peer review activity: convening organizations, reviewer role, review type, completion dates, and ISSN-keyed group identifiers. |
| `orcid_get_research_resources` | List research resources associated with a researcher — compute allocations, equipment access, lab facilities, and data resources. Sparsely populated; most researchers have no entries. |
| `orcid_resolve_researcher` | Disambiguate an ambiguous author name to a verified ORCID iD. Returns a ranked list of up to 5 candidates with transparent signals: name match type, institution overlap, and whether a DOI or PMID anchor was used. |

### `orcid_search_researchers`

Search the ORCID registry with structured field parameters mapped to Solr field queries.

- Structured params — `given_name`, `family_name`, `affiliation`, `keyword`, `ror_id`, `doi`, `pmid` — are ANDed into a Solr query automatically
- `doi` and `pmid` translate to `doi-self` and `pmid-self` field queries: "who has linked this work to their ORCID record?"
- `query` appends raw Solr to the generated clause for advanced use
- `ror_id` values (full URLs like `https://ror.org/00f54p054`) are quoted internally to handle Solr's colon parsing
- Returns expanded-search results with inline name and institution data — no follow-up profile fetch needed for basic discovery
- Use this for precise field-anchored lookups; use `orcid_resolve_researcher` for ambiguous names needing ranked disambiguation

---

### `orcid_get_profile`

Fetch a researcher's public person section by ORCID iD.

- Accepts bare ORCID iD (`0000-0001-2345-6789`) or full URI form
- Returns name, biography, keywords, researcher URLs, addresses, and external identifiers (Scopus Author ID, ResearcherID, Loop, etc.)
- External identifiers are embedded in the person response — no separate round-trip
- Entry point for building a researcher dossier before fetching works or affiliations

---

### `orcid_get_works`

Retrieve the works list for a researcher.

- Returns work summaries: title, type, publication date, journal name, and all external identifiers (DOI, PMID, arXiv ID, ISBN, etc.)
- External IDs are returned in formats consumable by downstream servers (Crossref, PubMed, arXiv)
- Works list is summaries only — chain to the relevant server for full metadata or abstracts

---

### `orcid_get_work_detail`

Fetch full detail records for 1–100 works in a single bulk request using the ORCID bulk works endpoint.

- `put_codes` is an array of 1–100 put-codes from `orcid_get_works`
- Single round-trip regardless of how many put-codes are requested
- Returns abstracts, all contributors with CRediT roles, the complete external ID list, citation metadata (BibTeX or other formats when deposited), journal title, and URL for each work
- Per-record errors (not-found or inaccessible put-codes) arrive as `errors` entries — the remaining works still resolve

---

### `orcid_get_affiliations`

Fetch affiliation records by type, using a single `/activities` call filtered client-side.

- `types` controls which sections to include: `employment`, `education`, `invited-positions`, `distinctions`, `memberships`, `qualifications`, `services`, or `all`
- Default is `['employment', 'education']` (the 90% case)
- Returns organization names, disambiguated org IDs (ROR/GRID/Ringgold), departments, roles, and date ranges
- One upstream call regardless of how many types are requested — the `/activities` endpoint returns all sections at once

---

### `orcid_get_funding`

Fetch funding records for a researcher.

- Returns grants, contracts, awards, and salary awards with funder names, grant numbers, and funding periods
- Funding data is self-reported and often sparse — absence does not mean no funding
- Useful when it exists; high-value (grant numbers, funder IDs) but a thin single-endpoint wrapper

---

### `orcid_get_peer_reviews`

Fetch peer review activity for a researcher.

- Returns convening organizations (journals/publishers), reviewer role (`reviewer`, `editor`, `chair`, etc.), review type, completion dates, and ISSN-keyed group identifiers
- Useful for assessing editorial activity and journal affiliations

---

### `orcid_get_research_resources`

List research resources associated with a researcher.

- Covers compute allocations, equipment access, lab facilities, data resources, and clinical study registrations
- A newer ORCID section that is sparsely populated — most researchers have no entries, and absence does not imply none exist
- Entries are typically deposited by resource-allocation systems (e.g. ACCESS, XSEDE) rather than self-reported
- Returns resource title, hosting organization (with disambiguated org ID), external identifiers (often a portal URI), and access period

---

### `orcid_resolve_researcher`

Disambiguate an author name to a verified ORCID iD.

- Returns up to 5 ranked candidates with transparent disambiguation signals: name match type (`exact`/`partial`/`other-name`), institution overlap flag, and anchor type (`doi`/`pmid`/`none`)
- When `doi` or `pmid` is provided, uses `doi-self` or `pmid-self` as an anchor — researchers who have linked that work to their ORCID record are near-deterministic matches
- Falls back to a relaxed query (dropping affiliation) if the initial candidate set is empty
- No synthetic scores — raw signal fields only, so callers can apply their own ranking logic

## Resources

| Type | Name | Description |
|:-----|:-----|:------------|
| Resource | `orcid://researcher/{orcid_id}/profile` | Researcher profile (person section: name, bio, keywords, external IDs). Prefer the tool when the response needs to flow into conditional logic. |
| Resource | `orcid://researcher/{orcid_id}/works` | Works list for a researcher. DOIs and PMIDs in the response are ready for Crossref/PubMed chaining. |

All resource data is also reachable via tools. Use resources when injecting stable researcher context into a prompt; use tools when filtering or processing results is needed.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

ORCID-specific:

- ORCID Public API v3.0 (`https://pub.orcid.org/v3.0/`) — no API key required for public read endpoints
- `expanded-search` as the primary search backend — returns ORCID iD, name, and institution data inline, eliminating N+1 profile fetches
- Single `/activities` call for affiliation queries, filtered client-side — eliminates up to 7 parallel upstream calls vs. per-section fetching
- External identifiers (DOIs, PMIDs, arXiv IDs) surfaced in works responses in formats ready for cross-server chaining

Agent-friendly output:

- Transparent disambiguation signals in `orcid_resolve_researcher` — name match type, institution overlap, and anchor type are returned as raw fields, not a synthetic score, so agents can reason about match confidence
- Known-limitation annotations — works list surfaces `num_found` so agents know when the 10,000-result public API cap was hit; funding and profile tools note when sections are empty due to researcher-controlled visibility
- External identifier pass-through — DOIs, PMIDs, arXiv IDs, Scopus Author IDs are normalized to formats consumable by downstream servers without parsing

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

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v24+).
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
| `ORCID_API_BASE_URL` | Override the ORCID API base URL. Useful for pointing at the sandbox (`https://pub.sandbox.orcid.org/v3.0/`). | `https://pub.orcid.org/v3.0/` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path | `/mcp` |
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
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Seven tools across search, profile, works, affiliations, funding, peer reviews, and disambiguation. |
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
