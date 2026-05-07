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

app.get('/sessions', (_req: Request, res: Response) => {
  res.json(db.listSessions());
});

// ─── SSE live updates ─────────────────────────────────────────────────────────

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
}

app.post('/node', (req: Request<Record<string, never>, unknown, NodeRequestBody>, res: Response) => {
  const { session_id, type, tool_name, content, timestamp } = req.body;

  if (!session_id || !type || content === undefined) {
    return res.status(400).json({ error: 'session_id, type, and content are required' });
  }

  const nodeId = uuidv4();
  const ts = timestamp || new Date().toISOString();

  db.ensureSession(session_id);
  const sequence = db.insertNode({ id: nodeId, session_id, type, tool_name, content: String(content), timestamp: ts });

  // Return immediately — do heavy work in background
  res.json({ id: nodeId, sequence });

  // Background: chunk + embed + maybe compute influences
  setImmediate(() => {
    processNodeAsync(nodeId, session_id, type, String(content)).catch((err: Error) => {
      console.error('[processNode] error:', err.message);
    });
  });
});

async function processNodeAsync(nodeId: string, sessionId: string, type: string, content: string): Promise<void> {
  // 1. Chunk
  const chunks = chunkText(content);
  const chunkIds: string[] = [];

  for (const { index, content: chunkContent } of chunks) {
    const chunkId = uuidv4();
    db.insertChunk({ id: chunkId, node_id: nodeId, chunk_index: index, content: chunkContent });
    chunkIds.push(chunkId);
  }

  // 2. Embed each chunk
  for (let i = 0; i < chunkIds.length; i++) {
    const embedding = await embed(chunks[i].content);
    if (embedding) {
      db.updateChunkEmbedding(chunkIds[i], embedding);
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
  // Get all chunks in session with embeddings
  const allChunks = db.getChunksWithEmbeddingsBySession(sessionId).map(c => ({
    ...c,
    embedding: parseEmbedding(c.embedding),
  }));

  // Synthesis node's own chunks
  const synChunks = allChunks.filter(c => c.node_id === synthesisNodeId);
  // Prior chunks (from earlier nodes, not the synthesis node itself)
  const priorChunks = allChunks.filter(c => c.node_id !== synthesisNodeId);

  if (!synChunks.length || !priorChunks.length) return;

  const influences = computeTopInfluences(synChunks, priorChunks, 5);

  // Delete existing edges for this target node to allow recomputation
  db.deleteEdgesByTarget(synthesisNodeId);

  for (const inf of influences) {
    db.insertEdge({
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
  const nodes = db.getNodesBySession(session_id);
  const synthesisNodes = nodes.filter(n => n.type === 'synthesis');

  let computed = 0;
  for (const node of synthesisNodes) {
    await computeAndStoreInfluences(node.id, session_id);
    computed++;
  }

  res.json({ computed, session_id });
});

// ─── Graph data ───────────────────────────────────────────────────────────────

app.get('/graph/:session_id', (req: Request<{ session_id: string }>, res: Response) => {
  const { session_id } = req.params;
  const rawNodes = db.getNodesBySession(session_id);

  if (!rawNodes.length) {
    return res.json({ session_id, nodes: [], edges: [], chunks: [], compression_cuts: [] });
  }

  const nodes = rawNodes.map(n => ({
    id: n.id,
    session_id: n.session_id,
    sequence: n.sequence,
    type: n.type,
    tool_name: n.tool_name,
    content_preview: n.content.slice(0, 200),
    chunk_count: db.getChunksByNode(n.id).length,
    timestamp: n.timestamp,
  }));

  const edges = db.getEdgesBySession(session_id).map(e => ({
    source_chunk_id: e.source_chunk_id,
    target_node_id: e.target_node_id,
    weight: e.weight,
    type: e.type,
  }));

  // Chunk-to-node mapping for the viewer
  const chunks = db.getChunksBySession(session_id);

  // Compression cut sequences
  const compression_cuts = rawNodes
    .filter(n => n.type === 'compression_cut')
    .map(n => n.sequence);

  res.json({ session_id, nodes, edges, chunks, compression_cuts });
});

// ─── Fallback: serve viewer SPA ───────────────────────────────────────────────

app.get('*', (_req: Request, res: Response) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).send('Viewer not built. Run: cd viewer && npm run build');
  });
});

// ─── Boot ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[nexus-provenance] Service running at http://localhost:${PORT}`);
  console.log(`[nexus-provenance] Viewer:  http://localhost:${PORT}`);
  console.log(`[nexus-provenance] Health:  http://localhost:${PORT}/health`);
});

// Warm up the embedding model in the background
initEmbeddings().catch(() => {});

export default app;
