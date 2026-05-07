'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'nexus.db');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    tool_name TEXT,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_nodes_session ON nodes(session_id, sequence);

  CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding TEXT,
    FOREIGN KEY (node_id) REFERENCES nodes(id)
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_node ON chunks(node_id);

  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    source_chunk_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    weight REAL NOT NULL,
    type TEXT NOT NULL DEFAULT 'influence',
    FOREIGN KEY (source_chunk_id) REFERENCES chunks(id),
    FOREIGN KEY (target_node_id) REFERENCES nodes(id)
  );

  CREATE INDEX IF NOT EXISTS idx_edges_session ON edges(session_id);
`);

// ─── Session helpers ─────────────────────────────────────────────────────────

function ensureSession(sessionId) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions(id, created_at, updated_at)
    VALUES(?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `).run(sessionId, now, now);
}

function touchSession(sessionId) {
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), sessionId);
}

function listSessions() {
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 50').all();
}

// ─── Node helpers ────────────────────────────────────────────────────────────

function insertNode({ id, session_id, type, tool_name, content, timestamp }) {
  const seq = nextSequence(session_id);
  db.prepare(`
    INSERT INTO nodes(id, session_id, sequence, type, tool_name, content, timestamp)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(id, session_id, seq, type, tool_name || null, content, timestamp);
  touchSession(session_id);
  return seq;
}

function nextSequence(sessionId) {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM nodes WHERE session_id = ?').get(sessionId);
  return (row ? row.cnt : 0) + 1;
}

function getNode(id) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
}

function getNodesBySession(sessionId) {
  return db.prepare('SELECT * FROM nodes WHERE session_id = ? ORDER BY sequence ASC').all(sessionId);
}

// ─── Chunk helpers ───────────────────────────────────────────────────────────

function insertChunk({ id, node_id, chunk_index, content }) {
  db.prepare(`
    INSERT INTO chunks(id, node_id, chunk_index, content)
    VALUES(?, ?, ?, ?)
  `).run(id, node_id, chunk_index, content);
}

function updateChunkEmbedding(id, embedding) {
  db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?')
    .run(JSON.stringify(embedding), id);
}

function getChunksByNode(nodeId) {
  return db.prepare('SELECT * FROM chunks WHERE node_id = ? ORDER BY chunk_index ASC').all(nodeId);
}

function getChunksWithEmbeddingsBySession(sessionId) {
  return db.prepare(`
    SELECT c.*, n.session_id, n.type AS node_type, n.sequence AS node_sequence
    FROM chunks c
    JOIN nodes n ON c.node_id = n.id
    WHERE n.session_id = ? AND c.embedding IS NOT NULL
    ORDER BY n.sequence ASC, c.chunk_index ASC
  `).all(sessionId);
}

function getChunksBySession(sessionId) {
  return db.prepare(`
    SELECT c.id, c.node_id, c.chunk_index
    FROM chunks c
    JOIN nodes n ON c.node_id = n.id
    WHERE n.session_id = ?
    ORDER BY n.sequence ASC, c.chunk_index ASC
  `).all(sessionId);
}

// ─── Edge helpers ────────────────────────────────────────────────────────────

function insertEdge({ id, session_id, source_chunk_id, target_node_id, weight }) {
  db.prepare(`
    INSERT OR REPLACE INTO edges(id, session_id, source_chunk_id, target_node_id, weight, type)
    VALUES(?, ?, ?, ?, ?, 'influence')
  `).run(id, session_id, source_chunk_id, target_node_id, weight);
}

function getEdgesBySession(sessionId) {
  return db.prepare('SELECT * FROM edges WHERE session_id = ? ORDER BY weight DESC').all(sessionId);
}

function deleteEdgesByTarget(targetNodeId) {
  db.prepare('DELETE FROM edges WHERE target_node_id = ?').run(targetNodeId);
}

module.exports = {
  db,
  ensureSession,
  listSessions,
  insertNode,
  getNode,
  getNodesBySession,
  insertChunk,
  updateChunkEmbedding,
  getChunksByNode,
  getChunksWithEmbeddingsBySession,
  getChunksBySession,
  insertEdge,
  getEdgesBySession,
  deleteEdgesByTarget,
};
