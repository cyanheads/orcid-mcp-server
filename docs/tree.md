# orcid-mcp-server - Directory Structure

Generated on: 2026-08-25 05:16:14

```text
orcid-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── researcher-profile.resource.ts
│   │   │       └── researcher-works.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── get-affiliations.tool.ts
│   │           ├── get-funding.tool.ts
│   │           ├── get-peer-reviews.tool.ts
│   │           ├── get-profile.tool.ts
│   │           ├── get-research-resources.tool.ts
│   │           ├── get-work-detail.tool.ts
│   │           ├── get-works.tool.ts
│   │           ├── resolve-researcher.tool.ts
│   │           └── search-researchers.tool.ts
│   ├── services/
│   │   └── orcid/
│   │       ├── normalizers.ts
│   │       ├── orcid-id.ts
│   │       ├── orcid-service.ts
│   │       ├── solr-query.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── fuzz/
│   │   ├── resources.fuzz.test.ts
│   │   └── tools.fuzz.test.ts
│   ├── integration/
│   │   ├── activity-contracts.int.test.ts
│   │   ├── orcid-api-fixtures.ts
│   │   ├── record-contracts.int.test.ts
│   │   └── search-contracts.int.test.ts
│   ├── resources/
│   │   ├── researcher-profile.resource.test.ts
│   │   ├── researcher-works.resource.test.ts
│   │   └── resources-extended.test.ts
│   ├── services/
│   │   └── orcid/
│   │       ├── normalizers-extended.test.ts
│   │       ├── normalizers.test.ts
│   │       ├── orcid-id.test.ts
│   │       ├── orcid-service.test.ts
│   │       └── solr-query.test.ts
│   ├── smoke/
│   │   └── definitions.smoke.test.ts
│   └── tools/
│       ├── get-affiliations.tool.test.ts
│       ├── get-funding.tool.test.ts
│       ├── get-peer-reviews.tool.test.ts
│       ├── get-profile.tool.test.ts
│       ├── get-research-resources.tool.test.ts
│       ├── get-work-detail.tool.test.ts
│       ├── get-works.tool.test.ts
│       ├── resolve-researcher-extended.tool.test.ts
│       ├── resolve-researcher.tool.test.ts
│       ├── search-researchers-extended.tool.test.ts
│       ├── search-researchers.tool.test.ts
│       └── security.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
