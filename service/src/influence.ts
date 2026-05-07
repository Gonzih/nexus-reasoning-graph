export interface ChunkInput {
  id: string;
  node_id: string;
  embedding: number[] | null;
}

export interface InfluenceEdge {
  source_chunk_id: string;
  target_chunk_id: string;
  weight: number;
}

/**
 * Compute cosine similarity between two numeric arrays.
 * Returns 0 if either vector is zero-magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Given a synthesis node's chunks (with embeddings) and an array of
 * candidate prior chunks (with embeddings), return the top-k influence
 * edges per synthesis chunk.
 */
export function computeTopInfluences(
  synthesisChunks: ChunkInput[],
  priorChunks: ChunkInput[],
  topK = 5,
): InfluenceEdge[] {
  const results: InfluenceEdge[] = [];

  for (const synChunk of synthesisChunks) {
    if (!synChunk.embedding) continue;

    const scored = priorChunks
      .filter(c => c.id !== synChunk.id && c.embedding)
      .map(c => ({
        source_chunk_id: c.id,
        source_node_id: c.node_id,
        weight: cosineSimilarity(synChunk.embedding as number[], c.embedding as number[]),
      }))
      .filter(r => r.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, topK);

    results.push(...scored.map(r => ({
      source_chunk_id: r.source_chunk_id,
      target_chunk_id: synChunk.id,
      weight: r.weight,
    })));
  }

  return results;
}

/**
 * Parse stored embedding from JSON string or return array as-is.
 */
export function parseEmbedding(raw: string | number[] | null | undefined): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  try {
    return JSON.parse(raw) as number[];
  } catch {
    return null;
  }
}
