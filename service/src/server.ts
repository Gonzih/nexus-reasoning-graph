import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

import * as db from './db';
import { chunkText } from './chunker';
import { embed, init as initEmbeddings } from './embeddings';
import { computeTopInfluences, parseEmbedding } from './influence';

const PORT = process.env.PORT || 7702;
const app = express();
const events = new EventEmitter();
events.setMaxListeners(200);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve built viewer from public/
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── Sessions ────────────────────────────────────────────────────────────────

app.get('/sessions', async (_req: Request, res: Response) => {
  try {
    res.json(await db.listSessions());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── SSE per-session ─────────────────────────────────────────────────────────

app.get('/events/:session_id', (req: Request<{ session_id: string }>, res: Response) => {
  const { session_id } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const listener = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  events.on(`update:${session_id}`, listener);

  req.on('close', () => {
    events.off(`update:${session_id}`, listener);
  });
});

// ─── Ingest node ─────────────────────────────────────────────────────────────

interface NodeRequestBody {
  session_id: string;
  type: string;
  tool_name?: string;
  content: unknown;
  timestamp?: string;
  cwd?: string;
}

app.post('/node', async (req: Request<Record<string, never>, unknown, NodeRequestBody>, res: Response) => {
  const { session_id, type, tool_name, content, timestamp, cwd } = req.body;

  if (!session_id || !type || content === undefined) {
    return res.status(400).json({ error: 'session_id, type, and content are required' });
  }

  const nodeId = uuidv4();
  const ts = timestamp || new Date().toISOString();

  try {
    const sequence = await db.insertNode({
      id: nodeId,
      session_id,
      type,
      tool_name,
      content: String(content),
      timestamp: ts,
      cwd,
    });

    // Return immediately — do heavy work in background
    res.json({ id: nodeId, sequence });

    // Background: chunk + embed + maybe compute influences
    setImmediate(() => {
      processNodeAsync(nodeId, session_id, type, String(content)).catch((err: Error) => {
        console.error('[processNode] error:', err.message);
      });
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

async function processNodeAsync(
  nodeId: string,
  sessionId: string,
  type: string,
  content: string,
): Promise<void> {
  // 1. Chunk
  const chunks = chunkText(content);
  const chunkIds: string[] = [];

  for (const { index, content: chunkContent } of chunks) {
    const chunkId = uuidv4();
    await db.insertChunk({ id: chunkId, node_id: nodeId, chunk_index: index, content: chunkContent });
    chunkIds.push(chunkId);
  }

  // 2. Embed each chunk
  for (let i = 0; i < chunkIds.length; i++) {
    const embedding = await embed(chunks[i].content);
    if (embedding) {
      await db.updateChunkEmbedding(chunkIds[i], embedding);
    }
  }

  // 3. If synthesis node, compute influences
  if (type === 'synthesis') {
    await computeAndStoreInfluences(nodeId, sessionId);
  }

  // Emit update
  events.emit(`update:${sessionId}`, { event: 'node_processed', node_id: nodeId });
}

async function computeAndStoreInfluences(synthesisNodeId: string, sessionId: string): Promise<void> {
  const allChunks = (await db.getChunksWithEmbeddingsBySession(sessionId)).map((c) => ({
    ...c,
    embedding: parseEmbedding(c.embedding),
  }));

  const synChunks = allChunks.filter((c) => c.node_id === synthesisNodeId);
  const priorChunks = allChunks.filter((c) => c.node_id !== synthesisNodeId);

  if (!synChunks.length || !priorChunks.length) return;

  const influences = computeTopInfluences(synChunks, priorChunks, 5);

  await db.deleteEdgesByTarget(synthesisNodeId);

  for (const inf of influences) {
    await db.insertEdge({
      id: uuidv4(),
      session_id: sessionId,
      source_chunk_id: inf.source_chunk_id,
      target_node_id: synthesisNodeId,
      weight: inf.weight,
    });
  }
}

// ─── Compute influences on demand ────────────────────────────────────────────

app.post('/compute_influences/:session_id', async (req: Request<{ session_id: string }>, res: Response) => {
  const { session_id } = req.params;
  try {
    const nodes = await db.getNodesBySession(session_id);
    const synthesisNodes = nodes.filter((n) => n.type === 'synthesis');

    let computed = 0;
    for (const node of synthesisNodes) {
      await computeAndStoreInfluences(node.id, session_id);
      computed++;
    }

    res.json({ computed, session_id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Graph data ───────────────────────────────────────────────────────────────

app.get('/graph/:session_id', async (req: Request<{ session_id: string }>, res: Response) => {
  const { session_id } = req.params;
  try {
    const rawNodes = await db.getNodesBySession(session_id);

    if (!rawNodes.length) {
      return res.json({ session_id, nodes: [], edges: [], chunks: [], compression_cuts: [] });
    }

    const nodeChunkCounts = await Promise.all(
      rawNodes.map((n) => db.getChunksByNode(n.id).then((cs) => ({ id: n.id, count: cs.length }))),
    );
    const chunkCountMap = new Map(nodeChunkCounts.map((x) => [x.id, x.count]));

    const nodes = rawNodes.map((n) => ({
      id: n.id,
      session_id: n.session_id,
      sequence: n.sequence,
      type: n.type,
      tool_name: n.tool_name,
      content_preview: n.content.slice(0, 200),
      chunk_count: chunkCountMap.get(n.id) ?? 0,
      timestamp: n.timestamp,
    }));

    const edges = (await db.getEdgesBySession(session_id)).map((e) => ({
      source_chunk_id: e.source_chunk_id,
      target_node_id: e.target_node_id,
      weight: e.weight,
      type: e.type,
    }));

    const chunks = await db.getChunksBySession(session_id);

    const compression_cuts = rawNodes
      .filter((n) => n.type === 'compression_cut')
      .map((n) => n.sequence);

    res.json({ session_id, nodes, edges, chunks, compression_cuts });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── REST API: projects ───────────────────────────────────────────────────────

app.get('/api/projects', async (_req: Request, res: Response) => {
  try {
    res.json(await db.listProjects());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/projects/:cwd_encoded/sessions', async (
  req: Request<{ cwd_encoded: string }>,
  res: Response,
) => {
  try {
    const cwd = Buffer.from(req.params.cwd_encoded, 'base64url').toString('utf8');
    res.json(await db.getSessionsByProject(cwd));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── REST API: sessions ───────────────────────────────────────────────────────

app.get('/api/sessions/:session_id/graph', async (
  req: Request<{ session_id: string }>,
  res: Response,
) => {
  try {
    const { session_id } = req.params;
    const rawNodes = await db.getNodesBySession(session_id);
    const edges = await db.getEdgesBySession(session_id);
    const chunks = await db.getChunksBySession(session_id);
    res.json({ session_id, nodes: rawNodes, edges, chunks });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/sessions/:session_id/tool_calls', async (
  req: Request<{ session_id: string }>,
  res: Response,
) => {
  try {
    res.json(await db.getToolCallsBySession(req.params.session_id));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── REST API: search ─────────────────────────────────────────────────────────

app.get('/api/search', async (req: Request, res: Response) => {
  const q = req.query.q as string | undefined;
  const project = req.query.project as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;

  if (!q) {
    return res.status(400).json({ error: 'q is required' });
  }

  try {
    const embedding = await embed(q);
    if (!embedding) {
      return res.status(503).json({ error: 'Embedding model not available' });
    }
    const results = await db.semanticSearch(embedding, { cwd: project, limit });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── REST API: stats ──────────────────────────────────────────────────────────

app.get('/api/stats', async (_req: Request, res: Response) => {
  try {
    res.json(await db.getGlobalStats());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── REST API: filtered tool calls ───────────────────────────────────────────

app.get('/api/tool_calls', async (req: Request, res: Response) => {
  try {
    const filter: db.ToolCallFilter = {
      cwd:       req.query.project as string | undefined,
      tool_name: req.query.tool    as string | undefined,
      since:     req.query.since   as string | undefined,
      limit:     req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
    };
    res.json(await db.getFilteredToolCalls(filter));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── SSE: live stream of new tool calls (all projects) ───────────────────────

app.get('/sse/live', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const listener = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  events.on('tool_call:new', listener);

  req.on('close', () => {
    events.off('tool_call:new', listener);
  });
});

// ─── Fallback: serve viewer SPA ───────────────────────────────────────────────

app.get('*', (_req: Request, res: Response) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).send('Viewer not built. Run: cd viewer && npm run build');
  });
});

// ─── Boot ────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await db.runMigrations();
  app.listen(PORT, () => {
    console.log(`[nexus-provenance] Service running at http://localhost:${PORT}`);
    console.log(`[nexus-provenance] Viewer:  http://localhost:${PORT}`);
    console.log(`[nexus-provenance] Health:  http://localhost:${PORT}/health`);
  });
  initEmbeddings().catch(() => {});
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[nexus-provenance] Failed to start:', err);
    process.exit(1);
  });
}

export default app;
export { start };
