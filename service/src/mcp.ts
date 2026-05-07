/**
 * Nexus Memory MCP Server
 *
 * Exposes cross-session/project memory via the Model Context Protocol (stdio transport).
 * Tools: search_memory, get_tool_calls, get_session_graph, get_project_summary,
 *        list_projects, get_bash_history
 *
 * Usage:
 *   npm run mcp        (tsx src/mcp.ts — dev)
 *   node dist/mcp.js   (production)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import * as db from './db';
import { embed, init as initEmbeddings } from './embeddings';

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_memory',
    description: 'Semantic search over all indexed chunks via pgvector cosine similarity.',
    inputSchema: {
      type: 'object',
      properties: {
        query:       { type: 'string',  description: 'Search query text' },
        project_cwd: { type: 'string',  description: 'Filter by project working directory (optional)' },
        limit:       { type: 'number',  description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_tool_calls',
    description: 'Retrieve tool calls filtered by project, tool name, and/or date.',
    inputSchema: {
      type: 'object',
      properties: {
        project_cwd: { type: 'string', description: 'Filter by project cwd (optional)' },
        tool_name:   { type: 'string', description: 'Filter by tool name e.g. "Bash" (optional)' },
        since:       { type: 'string', description: 'ISO 8601 datetime lower bound (optional)' },
        limit:       { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'get_session_graph',
    description: 'Return all nodes and influence edges for a session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Textual session ID from Claude Code hook' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'get_project_summary',
    description: 'Count of sessions, tool calls, and top tools for a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_cwd: { type: 'string', description: 'Absolute path of the project working directory' },
      },
      required: ['project_cwd'],
    },
  },
  {
    name: 'list_projects',
    description: 'List all indexed projects.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_bash_history',
    description: 'Return Bash tool calls, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        project_cwd: { type: 'string', description: 'Filter by project cwd (optional)' },
        limit:       { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
] as const;

type ToolName = (typeof TOOLS)[number]['name'];

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function handleSearchMemory(args: {
  query: string;
  project_cwd?: string;
  limit?: number;
}): Promise<unknown> {
  const embedding = await embed(args.query);
  if (!embedding) {
    return { error: 'Embedding model not available — no results.' };
  }
  const results = await db.semanticSearch(embedding, {
    cwd:   args.project_cwd,
    limit: args.limit ?? 10,
  });
  return results;
}

async function handleGetToolCalls(args: {
  project_cwd?: string;
  tool_name?: string;
  since?: string;
  limit?: number;
}): Promise<unknown> {
  return db.getFilteredToolCalls({
    cwd:       args.project_cwd,
    tool_name: args.tool_name,
    since:     args.since,
    limit:     args.limit ?? 50,
  });
}

async function handleGetSessionGraph(args: { session_id: string }): Promise<unknown> {
  const [nodes, edges, chunks] = await Promise.all([
    db.getNodesBySession(args.session_id),
    db.getEdgesBySession(args.session_id),
    db.getChunksBySession(args.session_id),
  ]);
  return { session_id: args.session_id, nodes, edges, chunks };
}

async function handleGetProjectSummary(args: { project_cwd: string }): Promise<unknown> {
  return db.getProjectSummary(args.project_cwd);
}

async function handleListProjects(): Promise<unknown> {
  return db.listProjects();
}

async function handleGetBashHistory(args: {
  project_cwd?: string;
  limit?: number;
}): Promise<unknown> {
  return db.getFilteredToolCalls({
    cwd:       args.project_cwd,
    tool_name: 'Bash',
    limit:     args.limit ?? 50,
  });
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name as ToolName) {
    case 'search_memory':
      return handleSearchMemory(args as { query: string; project_cwd?: string; limit?: number });
    case 'get_tool_calls':
      return handleGetToolCalls(
        args as { project_cwd?: string; tool_name?: string; since?: string; limit?: number },
      );
    case 'get_session_graph':
      return handleGetSessionGraph(args as { session_id: string });
    case 'get_project_summary':
      return handleGetProjectSummary(args as { project_cwd: string });
    case 'list_projects':
      return handleListProjects();
    case 'get_bash_history':
      return handleGetBashHistory(args as { project_cwd?: string; limit?: number });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Server setup ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await db.runMigrations();
  initEmbeddings().catch(() => {});

  const server = new Server(
    { name: 'nexus-memory', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name:        t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    try {
      const result = await dispatch(name, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[nexus-mcp] fatal:', err);
  process.exit(1);
});
