import { Pool, PoolClient } from 'pg';
import path from 'path';

// ─── Connection pool ──────────────────────────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://localhost:5432/nexus_memory';

export const pool = new Pool({ connectionString: DATABASE_URL });

// ─── Schema migration ─────────────────────────────────────────────────────────

const MIGRATION_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cwd TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  session_id TEXT UNIQUE NOT NULL,
  started_at TIMESTAMPTZ DEFAULT now(),
  prompt TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id),
  project_id UUID REFERENCES projects(id),
  tool_use_id TEXT UNIQUE,
  tool_name TEXT NOT NULL,
  input JSONB,
  output TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_call_id UUID REFERENCES tool_calls(id),
  session_id UUID REFERENCES sessions(id),
  project_id UUID REFERENCES projects(id),
  text TEXT NOT NULL,
  embedding vector(384),
  window_index INTEGER,
  token_start INTEGER,
  token_end INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS influence_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_chunk_id UUID REFERENCES chunks(id),
  target_tool_call_id UUID REFERENCES tool_calls(id),
  session_id UUID REFERENCES sessions(id),
  weight FLOAT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
`;

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(MIGRATION_SQL);
  } finally {
    client.release();
  }
}

// ─── Row types ───────────────────────────────────────────────────────────────

/** Backward-compatible session row (old API returns this shape) */
export interface DbSession {
  id: string;        // the textual session_id from the hook
  created_at: string;
  updated_at: string;
}

export interface DbNode {
  id: string;         // tool_call UUID
  session_id: string; // textual session_id
  sequence: number;
  type: string;       // from input->>'node_type'
  tool_name: string | null;
  content: string;    // output column
  timestamp: string;  // from input->>'timestamp'
}

export interface DbChunk {
  id: string;
  node_id: string;    // tool_call UUID
  chunk_index: number;
  content: string;
  embedding: string | null;  // JSON string or null (backward compat)
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
  session_id: string;   // textual
  type: string;
  tool_name: string | null | undefined;
  content: string;
  timestamp: string;
  cwd?: string;
}

export interface InsertChunkParams {
  id: string;
  node_id: string;      // tool_call UUID
  chunk_index: number;
  content: string;
}

export interface InsertEdgeParams {
  id: string;
  session_id: string;   // textual
  source_chunk_id: string;
  target_node_id: string; // tool_call UUID
  weight: number;
}

// ─── Project helpers ──────────────────────────────────────────────────────────

export async function ensureProject(cwd: string): Promise<string> {
  const name = path.basename(cwd);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO projects(cwd, name)
     VALUES($1, $2)
     ON CONFLICT(cwd) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [cwd, name],
  );
  return res.rows[0].id;
}

export async function listProjects(): Promise<Array<{ id: string; cwd: string; name: string; created_at: string }>> {
  const res = await pool.query(
    `SELECT id, cwd, name, created_at FROM projects ORDER BY created_at DESC`,
  );
  return res.rows;
}

// ─── Session helpers ──────────────────────────────────────────────────────────

/** Upsert a session by its textual hook session_id. Returns the UUID PK. */
export async function ensureSession(
  sessionId: string,
  projectId?: string,
  prompt?: string,
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions(session_id, project_id, prompt)
     VALUES($1, $2, $3)
     ON CONFLICT(session_id) DO UPDATE
       SET project_id = COALESCE(EXCLUDED.project_id, sessions.project_id),
           prompt     = COALESCE(EXCLUDED.prompt,     sessions.prompt)
     RETURNING id`,
    [sessionId, projectId ?? null, prompt ?? null],
  );
  return res.rows[0].id;
}

/** Returns sessions in backward-compatible DbSession shape. */
export async function listSessions(): Promise<DbSession[]> {
  const res = await pool.query(
    `SELECT session_id AS id, started_at AS created_at, started_at AS updated_at
     FROM sessions
     ORDER BY started_at DESC
     LIMIT 50`,
  );
  return res.rows as DbSession[];
}

/** Resolve textual session_id → UUID id */
async function getSessionUUID(sessionId: string): Promise<string | null> {
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM sessions WHERE session_id = $1`,
    [sessionId],
  );
  return res.rows[0]?.id ?? null;
}

// ─── Node (tool_call) helpers ─────────────────────────────────────────────────

export async function insertNode({
  id,
  session_id,
  type,
  tool_name,
  content,
  timestamp,
  cwd,
}: InsertNodeParams): Promise<number> {
  let projectId: string | null = null;
  if (cwd) {
    projectId = await ensureProject(cwd);
  }

  const sessionUUID = await ensureSession(session_id, projectId ?? undefined);

  const input = JSON.stringify({ node_type: type, timestamp });

  await pool.query(
    `INSERT INTO tool_calls(id, session_id, project_id, tool_name, input, output)
     VALUES($1, $2, $3, $4, $5::jsonb, $6)`,
    [id, sessionUUID, projectId, tool_name ?? type, input, content],
  );

  // Compute 1-based sequence for this session
  const seqRes = await pool.query<{ seq: string }>(
    `SELECT COUNT(*) AS seq FROM tool_calls WHERE session_id = $1`,
    [sessionUUID],
  );
  return parseInt(seqRes.rows[0].seq, 10);
}

export async function getNodesBySession(sessionId: string): Promise<DbNode[]> {
  const res = await pool.query(
    `SELECT
       tc.id,
       s.session_id,
       ROW_NUMBER() OVER (ORDER BY tc.created_at) AS sequence,
       tc.input->>'node_type'  AS type,
       tc.tool_name,
       COALESCE(tc.output, '') AS content,
       COALESCE(tc.input->>'timestamp', tc.created_at::text) AS timestamp
     FROM tool_calls tc
     JOIN sessions s ON tc.session_id = s.id
     WHERE s.session_id = $1
     ORDER BY tc.created_at ASC`,
    [sessionId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    session_id: r.session_id,
    sequence: parseInt(r.sequence, 10),
    type: r.type ?? 'bash',
    tool_name: r.tool_name,
    content: r.content,
    timestamp: r.timestamp,
  }));
}

// ─── Chunk helpers ────────────────────────────────────────────────────────────

export async function insertChunk({
  id,
  node_id,
  chunk_index,
  content,
}: InsertChunkParams): Promise<void> {
  // Resolve project_id and session_id from the tool_call
  const res = await pool.query<{ session_id: string; project_id: string }>(
    `SELECT session_id, project_id FROM tool_calls WHERE id = $1`,
    [node_id],
  );
  const row = res.rows[0];

  await pool.query(
    `INSERT INTO chunks(id, tool_call_id, session_id, project_id, text, window_index)
     VALUES($1, $2, $3, $4, $5, $6)`,
    [id, node_id, row?.session_id ?? null, row?.project_id ?? null, content, chunk_index],
  );
}

export async function updateChunkEmbedding(id: string, embedding: number[]): Promise<void> {
  const vecStr = '[' + embedding.join(',') + ']';
  await pool.query(
    `UPDATE chunks SET embedding = $1::vector WHERE id = $2`,
    [vecStr, id],
  );
}

export async function getChunksByNode(nodeId: string): Promise<DbChunk[]> {
  const res = await pool.query(
    `SELECT id, tool_call_id AS node_id, window_index AS chunk_index, text AS content,
            embedding::text AS embedding
     FROM chunks
     WHERE tool_call_id = $1
     ORDER BY window_index ASC`,
    [nodeId],
  );
  return res.rows as DbChunk[];
}

export async function getChunksWithEmbeddingsBySession(sessionId: string): Promise<DbChunkWithMeta[]> {
  const res = await pool.query(
    `SELECT
       c.id,
       c.tool_call_id AS node_id,
       c.window_index AS chunk_index,
       c.text AS content,
       c.embedding::text AS embedding,
       s.session_id,
       COALESCE(tc.input->>'node_type', 'bash') AS node_type,
       ROW_NUMBER() OVER (PARTITION BY c.session_id ORDER BY tc.created_at) AS node_sequence
     FROM chunks c
     JOIN sessions s ON c.session_id = s.id
     JOIN tool_calls tc ON c.tool_call_id = tc.id
     WHERE s.session_id = $1 AND c.embedding IS NOT NULL
     ORDER BY tc.created_at ASC, c.window_index ASC`,
    [sessionId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    node_id: r.node_id,
    chunk_index: parseInt(r.chunk_index, 10),
    content: r.content,
    embedding: r.embedding,
    session_id: r.session_id,
    node_type: r.node_type,
    node_sequence: parseInt(r.node_sequence, 10),
  }));
}

export async function getChunksBySession(sessionId: string): Promise<DbChunkRef[]> {
  const res = await pool.query(
    `SELECT c.id, c.tool_call_id AS node_id, c.window_index AS chunk_index
     FROM chunks c
     JOIN sessions s ON c.session_id = s.id
     WHERE s.session_id = $1
     ORDER BY c.created_at ASC`,
    [sessionId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    node_id: r.node_id,
    chunk_index: parseInt(r.chunk_index, 10),
  }));
}

// ─── Edge (influence) helpers ─────────────────────────────────────────────────

export async function insertEdge({
  id,
  session_id,
  source_chunk_id,
  target_node_id,
  weight,
}: InsertEdgeParams): Promise<void> {
  const sessionUUID = await getSessionUUID(session_id);
  await pool.query(
    `INSERT INTO influence_edges(id, source_chunk_id, target_tool_call_id, session_id, weight)
     VALUES($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [id, source_chunk_id, target_node_id, sessionUUID, weight],
  );
}

export async function getEdgesBySession(sessionId: string): Promise<DbEdge[]> {
  const res = await pool.query(
    `SELECT
       ie.id,
       s.session_id,
       ie.source_chunk_id,
       ie.target_tool_call_id AS target_node_id,
       ie.weight,
       'influence' AS type
     FROM influence_edges ie
     JOIN sessions s ON ie.session_id = s.id
     WHERE s.session_id = $1
     ORDER BY ie.weight DESC`,
    [sessionId],
  );
  return res.rows as DbEdge[];
}

export async function deleteEdgesByTarget(targetNodeId: string): Promise<void> {
  await pool.query(
    `DELETE FROM influence_edges WHERE target_tool_call_id = $1`,
    [targetNodeId],
  );
}

// ─── API helpers (new REST endpoints) ────────────────────────────────────────

export async function getSessionsByProject(cwd: string): Promise<Array<{
  id: string; session_id: string; started_at: string; prompt: string | null;
}>> {
  const res = await pool.query(
    `SELECT s.id, s.session_id, s.started_at, s.prompt
     FROM sessions s
     JOIN projects p ON s.project_id = p.id
     WHERE p.cwd = $1
     ORDER BY s.started_at DESC`,
    [cwd],
  );
  return res.rows;
}

export async function getToolCallsBySession(sessionId: string): Promise<Array<{
  id: string; tool_name: string; input: unknown; output: string | null; created_at: string;
}>> {
  const res = await pool.query(
    `SELECT tc.id, tc.tool_name, tc.input, tc.output, tc.created_at
     FROM tool_calls tc
     JOIN sessions s ON tc.session_id = s.id
     WHERE s.session_id = $1
     ORDER BY tc.created_at ASC`,
    [sessionId],
  );
  return res.rows;
}

export interface ToolCallFilter {
  cwd?: string;
  tool_name?: string;
  since?: string;
  limit?: number;
}

export async function getFilteredToolCalls(filter: ToolCallFilter): Promise<Array<{
  id: string; tool_name: string; input: unknown; output: string | null;
  created_at: string; session_id: string; cwd: string | null;
}>> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filter.cwd) {
    conditions.push(`p.cwd = $${idx++}`);
    params.push(filter.cwd);
  }
  if (filter.tool_name) {
    conditions.push(`tc.tool_name = $${idx++}`);
    params.push(filter.tool_name);
  }
  if (filter.since) {
    conditions.push(`tc.created_at >= $${idx++}`);
    params.push(filter.since);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const limitClause = `LIMIT $${idx}`;
  params.push(filter.limit ?? 50);

  const res = await pool.query(
    `SELECT tc.id, tc.tool_name, tc.input, tc.output, tc.created_at,
            s.session_id, p.cwd
     FROM tool_calls tc
     JOIN sessions s ON tc.session_id = s.id
     LEFT JOIN projects p ON tc.project_id = p.id
     ${where}
     ORDER BY tc.created_at DESC
     ${limitClause}`,
    params,
  );
  return res.rows;
}

export async function semanticSearch(
  embedding: number[],
  opts: { cwd?: string; limit?: number },
): Promise<Array<{
  id: string; text: string; similarity: number;
  tool_call_id: string; session_id: string; cwd: string | null;
}>> {
  const vecStr = '[' + embedding.join(',') + ']';
  const conditions: string[] = ['c.embedding IS NOT NULL'];
  const params: unknown[] = [vecStr];
  let idx = 2;

  if (opts.cwd) {
    conditions.push(`p.cwd = $${idx++}`);
    params.push(opts.cwd);
  }

  params.push(opts.limit ?? 10);
  const limitClause = `LIMIT $${idx}`;

  const where = 'WHERE ' + conditions.join(' AND ');

  const res = await pool.query(
    `SELECT c.id, c.text, 1 - (c.embedding <=> $1::vector) AS similarity,
            c.tool_call_id, s.session_id, p.cwd
     FROM chunks c
     JOIN sessions s ON c.session_id = s.id
     LEFT JOIN projects p ON c.project_id = p.id
     ${where}
     ORDER BY c.embedding <=> $1::vector
     ${limitClause}`,
    params,
  );
  return res.rows.map((r) => ({
    ...r,
    similarity: parseFloat(r.similarity),
  }));
}

export async function getGlobalStats(): Promise<{
  projects: number; sessions: number; tool_calls: number; chunks: number;
}> {
  const res = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM projects)   AS projects,
       (SELECT COUNT(*) FROM sessions)   AS sessions,
       (SELECT COUNT(*) FROM tool_calls) AS tool_calls,
       (SELECT COUNT(*) FROM chunks)     AS chunks`,
  );
  const r = res.rows[0];
  return {
    projects:   parseInt(r.projects,   10),
    sessions:   parseInt(r.sessions,   10),
    tool_calls: parseInt(r.tool_calls, 10),
    chunks:     parseInt(r.chunks,     10),
  };
}

export async function getProjectSummary(cwd: string): Promise<{
  project: { id: string; cwd: string; name: string } | null;
  sessions: number;
  tool_calls: number;
  top_tools: Array<{ tool_name: string; count: number }>;
}> {
  const projRes = await pool.query(
    `SELECT id, cwd, name FROM projects WHERE cwd = $1`,
    [cwd],
  );
  if (!projRes.rows.length) {
    return { project: null, sessions: 0, tool_calls: 0, top_tools: [] };
  }
  const project = projRes.rows[0];

  const countsRes = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM sessions   WHERE project_id = $1) AS sessions,
       (SELECT COUNT(*) FROM tool_calls WHERE project_id = $1) AS tool_calls`,
    [project.id],
  );

  const topRes = await pool.query(
    `SELECT tool_name, COUNT(*) AS count
     FROM tool_calls
     WHERE project_id = $1
     GROUP BY tool_name
     ORDER BY count DESC
     LIMIT 10`,
    [project.id],
  );

  return {
    project,
    sessions:   parseInt(countsRes.rows[0].sessions,   10),
    tool_calls: parseInt(countsRes.rows[0].tool_calls, 10),
    top_tools: topRes.rows.map((r) => ({
      tool_name: r.tool_name,
      count: parseInt(r.count, 10),
    })),
  };
}
