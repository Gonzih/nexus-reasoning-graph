/**
 * Integration tests for the PostgreSQL db layer.
 * Requires DATABASE_URL=postgresql://localhost:5432/nexus_memory_test (set in setup.ts).
 * Tables are created by runMigrations(); we clean up test data in afterAll.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  pool,
  runMigrations,
  ensureProject,
  ensureSession,
  insertNode,
  insertChunk,
  updateChunkEmbedding,
  getNodesBySession,
  getChunksByNode,
  getFilteredToolCalls,
  listProjects,
  getProjectSummary,
  semanticSearch,
} from '../src/db';

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await runMigrations();
  // Clean out any leftover test data from previous runs
  await pool.query(`DELETE FROM influence_edges`);
  await pool.query(`DELETE FROM chunks`);
  await pool.query(`DELETE FROM tool_calls`);
  await pool.query(`DELETE FROM sessions`);
  await pool.query(`DELETE FROM projects`);
});

afterAll(async () => {
  await pool.end();
});

// ─── Project upsert ───────────────────────────────────────────────────────────

describe('ensureProject', () => {
  test('creates a new project from cwd', async () => {
    const cwd = '/tmp/test-project-' + uuidv4();
    const id = await ensureProject(cwd);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('upsert is idempotent — returns same UUID', async () => {
    const cwd = '/tmp/idempotent-' + uuidv4();
    const id1 = await ensureProject(cwd);
    const id2 = await ensureProject(cwd);
    expect(id1).toBe(id2);
  });

  test('name is basename of cwd', async () => {
    const cwd = '/home/user/my-cool-project-' + uuidv4();
    await ensureProject(cwd);
    const projects = await listProjects();
    const proj = projects.find((p) => p.cwd === cwd);
    expect(proj).toBeDefined();
    // name should be the directory's basename
    expect(proj!.name).toBe(cwd.split('/').pop());
  });
});

// ─── Session upsert ───────────────────────────────────────────────────────────

describe('ensureSession', () => {
  test('creates session linked to a project', async () => {
    const cwd = '/tmp/sess-proj-' + uuidv4();
    const projectId = await ensureProject(cwd);
    const sessionTextId = 'sess-' + uuidv4();

    const uuid = await ensureSession(sessionTextId, projectId);
    expect(typeof uuid).toBe('string');
    expect(uuid.length).toBeGreaterThan(0);
  });

  test('session upsert is idempotent', async () => {
    const sessionTextId = 'sess-idem-' + uuidv4();
    const id1 = await ensureSession(sessionTextId);
    const id2 = await ensureSession(sessionTextId);
    expect(id1).toBe(id2);
  });
});

// ─── Node insert & retrieval ──────────────────────────────────────────────────

describe('insertNode / getNodesBySession', () => {
  test('inserts a node and retrieves it by session', async () => {
    const sessionId = 'node-sess-' + uuidv4();
    const nodeId = uuidv4();

    await insertNode({
      id: nodeId,
      session_id: sessionId,
      type: 'bash',
      tool_name: 'Bash',
      content: 'echo hello',
      timestamp: new Date().toISOString(),
    });

    const nodes = await getNodesBySession(sessionId);
    expect(nodes.length).toBe(1);
    expect(nodes[0].id).toBe(nodeId);
    expect(nodes[0].type).toBe('bash');
    expect(nodes[0].content).toBe('echo hello');
    expect(nodes[0].sequence).toBe(1);
  });

  test('sequence increments across nodes in same session', async () => {
    const sessionId = 'seq-sess-' + uuidv4();

    for (let i = 0; i < 3; i++) {
      await insertNode({
        id: uuidv4(),
        session_id: sessionId,
        type: 'bash',
        tool_name: 'Bash',
        content: `cmd ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    const nodes = await getNodesBySession(sessionId);
    expect(nodes.length).toBe(3);
    expect(nodes.map((n) => n.sequence)).toEqual([1, 2, 3]);
  });

  test('insertNode with cwd creates project', async () => {
    const cwd = '/tmp/node-cwd-' + uuidv4();
    const sessionId = 'cwd-sess-' + uuidv4();

    await insertNode({
      id: uuidv4(),
      session_id: sessionId,
      type: 'intent',
      tool_name: null,
      content: 'test prompt',
      timestamp: new Date().toISOString(),
      cwd,
    });

    const projects = await listProjects();
    const proj = projects.find((p) => p.cwd === cwd);
    expect(proj).toBeDefined();
  });
});

// ─── Chunk helpers ────────────────────────────────────────────────────────────

describe('insertChunk / getChunksByNode', () => {
  test('inserts chunks for a node', async () => {
    const sessionId = 'chunk-sess-' + uuidv4();
    const nodeId = uuidv4();

    await insertNode({
      id: nodeId,
      session_id: sessionId,
      type: 'file_read',
      tool_name: 'Read',
      content: 'file content',
      timestamp: new Date().toISOString(),
    });

    await insertChunk({ id: uuidv4(), node_id: nodeId, chunk_index: 0, content: 'chunk zero' });
    await insertChunk({ id: uuidv4(), node_id: nodeId, chunk_index: 1, content: 'chunk one' });

    const chunks = await getChunksByNode(nodeId);
    expect(chunks.length).toBe(2);
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[1].chunk_index).toBe(1);
  });
});

// ─── Cross-project search ─────────────────────────────────────────────────────

describe('semanticSearch (cross-project)', () => {
  test('returns results across projects when no cwd filter', async () => {
    const cwdA = '/tmp/proj-a-' + uuidv4();
    const cwdB = '/tmp/proj-b-' + uuidv4();
    const sessA = 'search-sess-a-' + uuidv4();
    const sessB = 'search-sess-b-' + uuidv4();
    const nodeA = uuidv4();
    const nodeB = uuidv4();
    const chunkAId = uuidv4();
    const chunkBId = uuidv4();

    await insertNode({ id: nodeA, session_id: sessA, type: 'bash', tool_name: 'Bash', content: 'hello world', timestamp: new Date().toISOString(), cwd: cwdA });
    await insertNode({ id: nodeB, session_id: sessB, type: 'bash', tool_name: 'Bash', content: 'hello world', timestamp: new Date().toISOString(), cwd: cwdB });

    await insertChunk({ id: chunkAId, node_id: nodeA, chunk_index: 0, content: 'hello world from project A' });
    await insertChunk({ id: chunkBId, node_id: nodeB, chunk_index: 0, content: 'hello world from project B' });

    // Use a trivial embedding (non-zero so it's valid for cosine sim)
    const vec = new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    await updateChunkEmbedding(chunkAId, vec);
    await updateChunkEmbedding(chunkBId, vec);

    const results = await semanticSearch(vec, { limit: 10 });
    const foundIds = results.map((r) => r.id);
    expect(foundIds).toContain(chunkAId);
    expect(foundIds).toContain(chunkBId);
  });

  test('filters results by cwd', async () => {
    const cwdC = '/tmp/proj-c-' + uuidv4();
    const cwdD = '/tmp/proj-d-' + uuidv4();
    const nodeC = uuidv4();
    const nodeD = uuidv4();
    const chunkCId = uuidv4();
    const chunkDId = uuidv4();

    await insertNode({ id: nodeC, session_id: 'filter-c-' + uuidv4(), type: 'bash', tool_name: 'Bash', content: 'alpha', timestamp: new Date().toISOString(), cwd: cwdC });
    await insertNode({ id: nodeD, session_id: 'filter-d-' + uuidv4(), type: 'bash', tool_name: 'Bash', content: 'beta',  timestamp: new Date().toISOString(), cwd: cwdD });

    await insertChunk({ id: chunkCId, node_id: nodeC, chunk_index: 0, content: 'alpha chunk' });
    await insertChunk({ id: chunkDId, node_id: nodeD, chunk_index: 0, content: 'beta chunk' });

    const vec = new Array(384).fill(0).map((_, i) => (i === 1 ? 1 : 0));
    await updateChunkEmbedding(chunkCId, vec);
    await updateChunkEmbedding(chunkDId, vec);

    const results = await semanticSearch(vec, { cwd: cwdC, limit: 10 });
    const foundIds = results.map((r) => r.id);
    expect(foundIds).toContain(chunkCId);
    expect(foundIds).not.toContain(chunkDId);
  });
});

// ─── getFilteredToolCalls ─────────────────────────────────────────────────────

describe('getFilteredToolCalls', () => {
  test('filters by tool_name', async () => {
    const sessionId = 'filter-tool-' + uuidv4();
    const bashId = uuidv4();
    const readId = uuidv4();

    await insertNode({ id: bashId, session_id: sessionId, type: 'bash',      tool_name: 'Bash', content: 'ls', timestamp: new Date().toISOString() });
    await insertNode({ id: readId, session_id: sessionId, type: 'file_read', tool_name: 'Read', content: 'x',  timestamp: new Date().toISOString() });

    const bashCalls = await getFilteredToolCalls({ tool_name: 'Bash' });
    const readCalls = await getFilteredToolCalls({ tool_name: 'Read' });

    expect(bashCalls.some((c) => c.id === bashId)).toBe(true);
    expect(readCalls.some((c) => c.id === readId)).toBe(true);
    expect(bashCalls.some((c) => c.id === readId)).toBe(false);
  });
});

// ─── getProjectSummary ────────────────────────────────────────────────────────

describe('getProjectSummary', () => {
  test('returns correct counts for a project', async () => {
    const cwd = '/tmp/summary-' + uuidv4();
    const sessionId = 'summ-sess-' + uuidv4();

    await insertNode({ id: uuidv4(), session_id: sessionId, type: 'bash', tool_name: 'Bash', content: 'cmd1', timestamp: new Date().toISOString(), cwd });
    await insertNode({ id: uuidv4(), session_id: sessionId, type: 'bash', tool_name: 'Bash', content: 'cmd2', timestamp: new Date().toISOString(), cwd });

    const summary = await getProjectSummary(cwd);
    expect(summary.project).not.toBeNull();
    expect(summary.sessions).toBeGreaterThanOrEqual(1);
    expect(summary.tool_calls).toBeGreaterThanOrEqual(2);
    expect(summary.top_tools.length).toBeGreaterThan(0);
    expect(summary.top_tools[0].tool_name).toBe('Bash');
  });

  test('returns null project for unknown cwd', async () => {
    const summary = await getProjectSummary('/nonexistent/path/xyz');
    expect(summary.project).toBeNull();
    expect(summary.sessions).toBe(0);
  });
});
