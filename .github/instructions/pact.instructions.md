---
applyTo: "src/services/**/*.ts,src/auth/**/*.ts,test/contract/**/*.ts,.github/mcp.json"
---

# Pact contract testing

- Use Pact for inter-process HTTP or message boundaries. Use deterministic Effect test Layers for in-process ports, filesystems, clocks, prompts, and orchestration.
- A consumer test must invoke the production adapter. Calling `fetch` directly only tests the Pact mock server and is not a valid consumer contract.
- Keep one stable consumer name (`ado-to-github-teams`) and one provider name per external API. Run each provider suite sequentially so pact artifacts are not overwritten concurrently.
- Model the complete production call sequence, including preflight reads, pagination, GraphQL request bodies, idempotency checks, and mutation payloads.
- Use matchers for provider-owned values and never place credentials, tokens, tenant data, or generated pact artifacts in source control.
- GitHub, Azure DevOps, and Microsoft Graph are third-party SaaS providers. Their pacts are consumer-side compatibility checks unless a controlled provider verification environment exists; do not claim `can-i-deploy` guarantees from unverified pacts.
- The SmartBear MCP server is read-only by default in this repository. It inherits `PACT_BROKER_BASE_URL` plus either `PACT_BROKER_TOKEN` or `PACT_BROKER_USERNAME` and `PACT_BROKER_PASSWORD` from the GHCP process environment.
