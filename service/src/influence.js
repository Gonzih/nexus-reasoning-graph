'use strict';

/**
 * Compute cosine similarity between two numeric arrays.
 * Returns 0 if either vector is zero-magnitude.
 */
function cosineSimilarity(a, b) {
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
 *
 * @param {Array<{id: string, embedding: number[]}>} synthesisChunks
 * @param {Array<{id: string, node_id: string, embedding: number[]}>} priorChunks
 * @param {number} topK
 * @returns {Array<{source_chunk_id, target_chunk_id, weight}>}
 */
function computeTopInfluences(synthesisChunks, priorChunks, topK = 5) {
  const results = [];

  for (const synChunk of synthesisChunks) {
    if (!synChunk.embedding) continue;

    const scored = priorChunks
      .filter(c => c.id !== synChunk.id && c.embedding)
      .map(c => ({
        source_chunk_id: c.id,
        source_node_id: c.node_id,
        weight: cosineSimilarity(synChunk.embedding, c.embedding),
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
function parseEmbedding(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = { cosineSimilarity, computeTopInfluences, parseEmbedding };
