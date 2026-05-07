import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

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

// ─── Row types ───────────────────────────────────────────────────────────────

export interface DbSession {
  id: string;
  created_at: string;
  updated_at: string;
}

export interface DbNode {
  id: string;
  session_id: string;
  sequence: number;
  type: string;
  tool_name: string | null;
  content: string;
  timestamp: string;
}

export interface DbChunk {
  id: string;
  node_id: string;
  chunk_index: number;
  content: string;
  embedding: string | null;
}

export interface DbChunkWithMeta extends DbChunk {
  session_id: string;
  node_type: string;
  node_sequence: number;
}

export interface DbChunkRef {
  id: string;
  node_id: string;
  chunk_index: number;
}

export interface DbEdge {
  id: string;
  session_id: string;
  source_chunk_id: string;
  target_node_id: string;
  weight: number;
  type: string;
}

// ─── Insert param types ───────────────────────────────────────────────────────

export interface InsertNodeParams {
  id: string;
  session_id: string;
  type: string;
  tool_name: string | null | undefined;
  content: string;
  timestamp: string;
}

export interface InsertChunkParams {
  id: string;
  node_id: string;
  chunk_index: number;
  content: string;
}

export interface InsertEdgeParams {
  id: string;
  session_id: string;
  source_chunk_id: string;
  target_node_id: string;
  weight: number;
}

// ─── Session helpers ─────────────────────────────────────────────────────────

export function ensureSession(sessionId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions(id, created_at, updated_at)
    VALUES(?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `).run(sessionId, now, now);
}

function touchSession(sessionId: string): void {
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), sessionId);
}

export function listSessions(): DbSession[] {
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 50').all() as DbSession[];
}

// ─── Node helpers ────────────────────────────────────────────────────────────

export function insertNode({ id, session_id, type, tool_name, content, timestamp }: InsertNodeParams): number {
  const seq = nextSequence(session_id);
  db.prepare(`
    INSERT INTO nodes(id, session_id, sequence, type, tool_name, content, timestamp)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(id, session_id, seq, type, tool_name ?? null, content, timestamp);
  touchSession(session_id);
  return seq;
}

function nextSequence(sessionId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM nodes WHERE session_id = ?').get(sessionId) as { cnt: number } | undefined;
  return (row ? row.cnt : 0) + 1;
}

export function getNode(id: string): DbNode | undefined {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as DbNode | undefined;
}

export function getNodesBySession(sessionId: string): DbNode[] {
  return db.prepare('SELECT * FROM nodes WHERE session_id = ? ORDER BY sequence ASC').all(sessionId) as DbNode[];
}

// ─── Chunk helpers ───────────────────────────────────────────────────────────

export function insertChunk({ id, node_id, chunk_index, content }: InsertChunkParams): void {
  db.prepare(`
    INSERT INTO chunks(id, node_id, chunk_index, content)
    VALUES(?, ?, ?, ?)
  `).run(id, node_id, chunk_index, content);
}

export function updateChunkEmbedding(id: string, embedding: number[]): void {
  db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?')
    .run(JSON.stringify(embedding), id);
}

export function getChunksByNode(nodeId: string): DbChunk[] {
  return db.prepare('SELECT * FROM chunks WHERE node_id = ? ORDER BY chunk_index ASC').all(nodeId) as DbChunk[];
}

export function getChunksWithEmbeddingsBySession(sessionId: string): DbChunkWithMeta[] {
  return db.prepare(`
    SELECT c.*, n.session_id, n.type AS node_type, n.sequence AS node_sequence
    FROM chunks c
    JOIN nodes n ON c.node_id = n.id
    WHERE n.session_id = ? AND c.embedding IS NOT NULL
    ORDER BY n.sequence ASC, c.chunk_index ASC
  `).all(sessionId) as DbChunkWithMeta[];
}

export function getChunksBySession(sessionId: string): DbChunkRef[] {
  return db.prepare(`
    SELECT c.id, c.node_id, c.chunk_index
    FROM chunks c
    JOIN nodes n ON c.node_id = n.id
    WHERE n.session_id = ?
    ORDER BY n.sequence ASC, c.chunk_index ASC
  `).all(sessionId) as DbChunkRef[];
}

// ─── Edge helpers ────────────────────────────────────────────────────────────

export function insertEdge({ id, session_id, source_chunk_id, target_node_id, weight }: InsertEdgeParams): void {
  db.prepare(`
    INSERT OR REPLACE INTO edges(id, session_id, source_chunk_id, target_node_id, weight, type)
    VALUES(?, ?, ?, ?, ?, 'influence')
  `).run(id, session_id, source_chunk_id, target_node_id, weight);
}

export function getEdgesBySession(sessionId: string): DbEdge[] {
  return db.prepare('SELECT * FROM edges WHERE session_id = ? ORDER BY weight DESC').all(sessionId) as DbEdge[];
}

export function deleteEdgesByTarget(targetNodeId: string): void {
  db.prepare('DELETE FROM edges WHERE target_node_id = ?').run(targetNodeId);
}
