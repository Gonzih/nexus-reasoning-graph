# TODO — PostgreSQL + MCP Server + REST API

## Setup
- [ ] Create branch feat/postgres-mcp
- [ ] Update service/package.json (add pg, @types/pg, @modelcontextprotocol/sdk; remove better-sqlite3)
- [ ] npm install in service/

## Core DB rewrite
- [ ] Rewrite service/src/db.ts for PostgreSQL (async pool, migrations, all helpers)

## Server updates
- [ ] Update service/src/server.ts (await all db calls, new /api/* endpoints, /sse/live)

## MCP server
- [ ] Create service/src/mcp.ts (6 tools: search_memory, get_tool_calls, get_session_graph, get_project_summary, list_projects, get_bash_history)
- [ ] Add "mcp" script to service/package.json

## Hooks
- [ ] Update hooks/post_tool_use.sh (extract cwd, send with payload)
- [ ] Update hooks/user_prompt_submit.sh (extract cwd, send with payload)

## Config
- [ ] Update settings.snippet.json (add mcpServers block)

## Tests
- [ ] Create service/tests/setup.ts (set DATABASE_URL env)
- [ ] Create service/tests/db.test.ts (project upsert, cross-project search)
- [ ] Create service/tests/mcp.test.ts (search_memory, list_projects)
- [ ] Update jest config to use setup file

## Verify
- [ ] npm test (all tests pass)
- [ ] npm run build (clean compile)

## Deploy
- [ ] git diff --staged review
- [ ] Commit + push + PR + merge
