# PLAN: PostgreSQL + pgvector + MCP Server + REST API

## Task Restatement

Upgrade nexus-provenance from SQLite (better-sqlite3) to PostgreSQL + pgvector, add an MCP
server exposing 6 tools, add cross-session/project memory (projects table + cwd tagging), and
add a REST API for external visualization. Hooks must forward cwd + session_id. All 26
existing tests must pass, plus new tests for project upsert, cross-project search, and MCP
tools.

## Approaches Considered

### A — Full replacement (chosen)
Replace all db.ts SQLite code with pg pool; rewrite helper functions as async; map old node
concept onto new tool_calls table via JSONB input field for type/timestamp; keep existing
REST endpoints backward-compatible while adding new /api/* and /sse/live.
- Pro: clean, no dual-path code, fully uses pgvector operators for semantic search
- Con: all DB helpers become async, server.ts needs await everywhere

### B — Abstraction layer
Define a DB interface, implement both SQLite and PostgreSQL backends, feature-flag at startup.
- Pro: keeps SQLite for offline use
- Con: massively more code, contradicts the spec which says "remove better-sqlite3"

### C — ORM (Prisma / Drizzle)
- Pro: nice DX
- Con: adds heavy build step, complex migration setup, overkill for this service

**Chosen: A** — full replacement, clean async pg pool.

## Schema Mapping

Old → New:
- `sessions.id TEXT` (hook's textual ID) → `sessions.session_id TEXT UNIQUE`
- `sessions` gets a UUID PK + project_id FK
- `nodes` → `tool_calls` + sequence computed via ROW_NUMBER() in queries
- `nodes.type` stored in `tool_calls.input JSONB` as `{node_type: string, timestamp: string}`
- `nodes.content` stored in `tool_calls.output TEXT`
- `chunks.embedding TEXT` (JSON) → `chunks.embedding vector(384)`
- `edges` → `influence_edges`

The existing REST endpoints (/node, /sessions, /graph/:session_id, /compute_influences/:session_id)
are preserved by mapping between old and new representations in db.ts functions.

## Files to Touch

- `PLAN.md` (this file)
- `TODO.md`
- `service/package.json` — remove better-sqlite3; add pg, pgvector, @modelcontextprotocol/sdk
- `service/tsconfig.json` — add types for pg if needed
- `service/src/db.ts` — full rewrite (async pg)
- `service/src/server.ts` — update to await all DB calls; add /api/* + /sse/live
- `service/src/mcp.ts` — new MCP server (stdio)
- `hooks/post_tool_use.sh` — add cwd extraction
- `hooks/user_prompt_submit.sh` — add cwd extraction
- `settings.snippet.json` — add mcpServers config block
- `service/tests/setup.ts` — new: set DATABASE_URL env for tests
- `service/tests/db.test.ts` — new: project upsert, cross-project search
- `service/tests/mcp.test.ts` — new: search_memory, list_projects MCP tools

## Risks and Unknowns

1. PostgreSQL must be running locally for tests (`nexus_memory_test` DB must exist)
2. pgvector extension must be installed in that database
3. `@modelcontextprotocol/sdk` package version — need to pick a stable version
4. tool_use_id UNIQUE constraint: make nullable so old /node route works (PG allows multiple NULLs)
5. The sequence field in old API is now computed via ROW_NUMBER() — ORDER BY created_at
6. The viewer polls /graph/:session_id — that endpoint response format must stay identical
