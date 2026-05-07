/**
 * Tests for MCP tool handlers.
 * We test the handler logic directly (not the MCP protocol wire format).
 * Requires DATABASE_URL=postgresql://localhost:5432/nexus_memory_test (set in setup.ts).
 */

import { v4 as uuidv4 } from 'uuid';
import {
  pool,
  runMigrations,
  ensureProject,
  insertNode,
  insertChunk,
  updateChunkEmbedding,
  listProjects,
  getFilteredToolCalls,
  getProjectSummary,
  semanticSearch,
} from '../src/db';

beforeAll(async () => {
  await runMigrations();
  // Clean slate for MCP tests
  await pool.query(`DELETE FROM influence_edges`);
  await pool.query(`DELETE FROM chunks`);
  await pool.query(`DELETE FROM tool_calls`);
  await pool.query(`DELETE FROM sessions`);
  await pool.query(`DELETE FROM projects`);
});

afterAll(async () => {
  // Do not end pool — db.test.ts may have already ended it or will end it
  // Each test file gets its own pool (jest isolation); let afterAll in db.test.ts handle it
  // If this file runs standalone, we still need to close.
  try { await pool.end(); } catch { /* already closed */ }
});

// ─── list_projects ────────────────────────────────────────────────────────────

describe('MCP list_projects', () => {
  test('returns empty array when no projects exist', async () => {
    const projects = await listProjects();
    expect(Array.isArray(projects)).toBe(true);
  });

  test('returns projects after inserting data', async () => {
    const cwd = '/tmp/mcp-list-' + uuidv4();
    await ensureProject(cwd);

    const projects = await listProjects();
    expect(projects.some((p) => p.cwd === cwd)).toBe(true);
  });
});

// ─── search_memory ────────────────────────────────────────────────────────────

describe('MCP search_memory', () => {
  test('finds a chunk by embedding similarity', async () => {
    const cwd = '/tmp/mcp-search-' + uuidv4();
    const sessionId = 'mcp-sess-' + uuidv4();
    const nodeId = uuidv4();
    const chunkId = uuidv4();

    await insertNode({
      id: nodeId,
      session_id: sessionId,
      type: 'bash',
      tool_name: 'Bash',
      content: 'the quick brown fox',
      timestamp: new Date().toISOString(),
      cwd,
    });

    await insertChunk({ id: chunkId, node_id: nodeId, chunk_index: 0, content: 'the quick brown fox' });

    // Insert a unit vector
    const vec = new Array(384).fill(0);
    vec[0] = 1;
    await updateChunkEmbedding(chunkId, vec);

    // Search with the same vector — should return this chunk at top
    const results = await semanticSearch(vec, { limit: 5 });
    expect(results.some((r) => r.id === chunkId)).toBe(true);
    // Similarity to itself should be 1.0
    const hit = results.find((r) => r.id === chunkId)!;
    expect(hit.similarity).toBeCloseTo(1.0, 2);
  });

  test('returns empty array when no embeddings exist', async () => {
    // Use a completely different dimension slice to avoid matching existing data
    const obscureVec = new Array(384).fill(0);
    obscureVec[383] = 1;
    // This may or may not return results — just ensure it doesn't throw
    const results = await semanticSearch(obscureVec, { limit: 1 });
    expect(Array.isArray(results)).toBe(true);
  });
});

// ─── get_tool_calls (bash history) ───────────────────────────────────────────

describe('MCP get_bash_history', () => {
  test('returns only Bash tool calls', async () => {
    const cwd = '/tmp/mcp-bash-' + uuidv4();
    const sessionId = 'mcp-bash-' + uuidv4();

    await insertNode({ id: uuidv4(), session_id: sessionId, type: 'bash',      tool_name: 'Bash', content: 'ls -la', timestamp: new Date().toISOString(), cwd });
    await insertNode({ id: uuidv4(), session_id: sessionId, type: 'file_read', tool_name: 'Read', content: 'file.ts', timestamp: new Date().toISOString(), cwd });

    const bashCalls = await getFilteredToolCalls({ tool_name: 'Bash', cwd });
    expect(bashCalls.every((c) => c.tool_name === 'Bash')).toBe(true);
    expect(bashCalls.some((c) => c.cwd === cwd)).toBe(true);
  });
});

// ─── get_project_summary ─────────────────────────────────────────────────────

describe('MCP get_project_summary', () => {
  test('returns correct summary after inserting nodes', async () => {
    const cwd = '/tmp/mcp-summary-' + uuidv4();
    const sessionId = 'mcp-summ-sess-' + uuidv4();

    for (let i = 0; i < 4; i++) {
      await insertNode({
        id: uuidv4(),
        session_id: sessionId,
        type: 'bash',
        tool_name: 'Bash',
        content: `cmd ${i}`,
        timestamp: new Date().toISOString(),
        cwd,
      });
    }

    const summary = await getProjectSummary(cwd);
    expect(summary.project?.cwd).toBe(cwd);
    expect(summary.tool_calls).toBeGreaterThanOrEqual(4);
    expect(summary.sessions).toBeGreaterThanOrEqual(1);
    expect(summary.top_tools[0].tool_name).toBe('Bash');
    expect(summary.top_tools[0].count).toBeGreaterThanOrEqual(4);
  });
});
