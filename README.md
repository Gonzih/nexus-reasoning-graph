# Nexus Reasoning Provenance Graph

A Claude Code plugin + local service + viewer that tracks what influenced what in a Claude session.

When Claude processes a request it **expands** (searches, fetches, reads files, spawns agents) then **contracts** (synthesises toward an answer). This system captures every node in that cycle, embeds them with a local ML model, computes cross-influence cosine-similarity edges, and renders the whole session as a live directed graph.

---

## Architecture

```
Claude Code hooks
  └─ UserPromptSubmit  ──POST──► /node  (type: intent)
  └─ PostToolUse       ──POST──► /node  (type: web_search | file_read | bash | …)

Graph Service  (Node.js, localhost:7702)
  ├─ SQLite storage (service/data/nexus.db)
  ├─ Sliding-window chunker  (512 tok / 128 tok stride)
  ├─ Embeddings  (@xenova/transformers local → OpenAI → TF-IDF stub)
  └─ Cosine-similarity influence edges

Viewer  (React + D3, served at localhost:7702)
  └─ Force-directed graph, live-polling every 2 s
```

---

## Quick Start

### 1. Prerequisites

- Node.js ≥ 18
- `jq` CLI (for hook scripts)
- `curl` (for hook scripts)

```bash
# macOS
brew install jq
# Already have curl and node
```

### 2. Install dependencies & build viewer

```bash
# From the repo root:
npm run install:all   # installs service + viewer deps
npm run build:viewer  # builds React viewer into service/public/
```

### 3. Start the service

```bash
npm start
# Service: http://localhost:7702
# Viewer:  http://localhost:7702
```

On first start the service downloads `all-MiniLM-L6-v2` (~40 MB, once only).  
Set `OPENAI_API_KEY` to skip the download and use OpenAI embeddings instead.

### 4. Wire up the Claude Code hooks

Edit `settings.snippet.json` — replace `NEXUS_DIR` with the absolute path to this repo:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "/absolute/path/nexus-provenance/hooks/user_prompt_submit.sh" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "/absolute/path/nexus-provenance/hooks/post_tool_use.sh" }] }
    ]
  }
}
```

Add this to `~/.claude/settings.json` (global) or `.claude/settings.json` (project-level).

### 5. Open the viewer

```
http://localhost:7702
```

Start a Claude Code session — nodes appear in real time as Claude works.

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/sessions` | List recent sessions |
| `POST` | `/node` | Ingest a node |
| `GET` | `/graph/:session_id` | Full graph (nodes + edges + chunks) |
| `POST` | `/compute_influences/:session_id` | Trigger influence-edge computation |
| `GET` | `/events/:session_id` | SSE stream for live updates |

### POST /node payload

```json
{
  "session_id": "string",
  "type": "intent|web_search|web_fetch|file_read|bash|agent|synthesis|compression_cut",
  "tool_name": "string|null",
  "content": "full raw text",
  "timestamp": "ISO8601 (optional)"
}
```

### Manually mark a synthesis node

```bash
curl -X POST http://localhost:7702/node \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "YOUR_SESSION_ID",
    "type": "synthesis",
    "content": "Final answer text here..."
  }'
```

### Manually mark a context-compression event

```bash
curl -X POST http://localhost:7702/node \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "YOUR_SESSION_ID",
    "type": "compression_cut",
    "content": "context compressed"
  }'
```

---

## Node Colours

| Type | Colour |
|------|--------|
| intent | Gold |
| web_search | Blue |
| web_fetch | Teal |
| file_read | Green |
| bash | Orange |
| agent | Purple |
| synthesis | White |
| compression_cut | Red dashed line |

---

## Embedding Tiers

| Priority | Provider | Dimensionality |
|----------|----------|----------------|
| 1 | `@xenova/transformers` — `all-MiniLM-L6-v2` (local ONNX) | 384 |
| 2 | OpenAI `text-embedding-3-small` (requires `OPENAI_API_KEY`) | 1536 |
| 3 | TF-IDF bag-of-words stub (always available) | 512 |

---

## Development

```bash
# Run service with auto-reload
cd service && npm run dev

# Run viewer dev server (proxies API to :7702)
cd viewer && npm run dev   # opens http://localhost:5173

# Run tests
npm test
```

---

## Data Storage

SQLite database at `service/data/nexus.db`. Delete to reset all sessions.

```bash
rm service/data/nexus.db
```
