# TODO

## Phase 1 — Scaffolding
- [ ] Root package.json with convenience scripts
- [ ] service/package.json with all deps
- [ ] viewer/package.json with Vite + React + D3

## Phase 2 — Service Core
- [ ] service/src/db.js — SQLite schema + CRUD helpers
- [ ] service/src/chunker.js — sliding-window chunker
- [ ] service/src/influence.js — cosine similarity + top-k
- [ ] service/src/embeddings.js — local/@xenova/openai/stub fallback
- [ ] service/src/server.js — Express routes + SSE

## Phase 3 — Viewer
- [ ] viewer/vite.config.js
- [ ] viewer/index.html
- [ ] viewer/src/main.jsx
- [ ] viewer/src/App.jsx + App.css
- [ ] viewer/src/components/Graph.jsx
- [ ] viewer/src/components/NodeDetail.jsx

## Phase 4 — Hooks + Config
- [ ] hooks/user_prompt_submit.sh
- [ ] hooks/post_tool_use.sh
- [ ] settings.snippet.json

## Phase 5 — Tests + README
- [ ] service/tests/chunker.test.js
- [ ] service/tests/influence.test.js
- [ ] README.md

## Phase 6 — Build + Verify
- [ ] npm install (service + viewer)
- [ ] npm run build (viewer)
- [ ] npm test (service)
- [ ] git diff --staged review
- [ ] Commit + push + PR + merge
