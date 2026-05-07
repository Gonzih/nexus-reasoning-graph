# Nexus Reasoning Provenance Graph — PLAN

## Task Restatement
Build a local system that captures every Claude Code tool call (expansion) and synthesis (contraction), embeds them, computes cosine-similarity influence edges, and renders the whole session as a live directed graph.

## Approaches Considered

### A: Python FastAPI + sentence-transformers
- Pros: Best-in-class embedding support, rich ML ecosystem
- Cons: Requires Python runtime, heavier setup, mismatches "Nexus ecosystem" preference

### B: Node.js (Express) + @xenova/transformers (chosen)
- Pros: Single JS runtime, fits project style, local ONNX model, no Python needed
- Cons: @xenova/transformers has initial model-download overhead; WASM quirks possible

### C: Bun + native SQLite
- Pros: Faster startup
- Cons: Less universal, Bun not always available

**Chosen: Approach B** — Node.js with Express, better-sqlite3, @xenova/transformers (local), OpenAI API fallback, TF-IDF stub as final fallback.

## Files To Touch

```
PLAN.md              (this file)
TODO.md
README.md
settings.snippet.json
package.json         (root convenience scripts)
hooks/
  user_prompt_submit.sh
  post_tool_use.sh
service/
  package.json
  src/
    server.js        (Express routes + SSE)
    db.js            (SQLite schema + CRUD)
    embeddings.js    (local model → OpenAI → TF-IDF stub)
    chunker.js       (sliding-window 512tok/128tok-stride)
    influence.js     (cosine similarity, top-k edges)
  tests/
    chunker.test.js
    influence.test.js
viewer/
  package.json
  vite.config.js
  index.html
  src/
    main.jsx
    App.jsx
    App.css
    components/
      Graph.jsx      (D3 force + hierarchy, SSE/poll)
      NodeDetail.jsx (sidebar panel)
```

## Risks / Unknowns
- @xenova/transformers downloads ~80 MB model on first use; graceful fallback essential
- Claude Code hook stdin format must match the scripts exactly; test with `echo | sh hook.sh`
- D3 + React refs pattern can get messy on re-renders; use "teardown + rebuild" on every data update
- `better-sqlite3` native addon needs node-gyp at install time; document requirement
