/**
 * Embedding provider with three tiers:
 *  1. Local @xenova/transformers (all-MiniLM-L6-v2, 384-dim) — preferred
 *  2. OpenAI text-embedding-3-small — if OPENAI_API_KEY is set
 *  3. TF-IDF bag-of-words stub — always available, lower quality
 */

import type OpenAI from 'openai';

type EmbeddingProvider = 'xenova' | 'openai' | 'tfidf' | null;

// Xenova pipeline callable: returns an object with a Float32Array `data` field
type XenovaPipeline = (
  text: string,
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

let _provider: EmbeddingProvider = null;
let _pipe: XenovaPipeline | null = null;
let _openaiClient: OpenAI | null = null;
let _initPromise: Promise<void> | null = null;

export async function init(): Promise<void> {
  if (_provider) return;

  // ── Tier 1: @xenova/transformers ───────────────────────────────────────────
  try {
    const { pipeline, env } = await import('@xenova/transformers');
    // Suppress progress bar spam in server logs
    (env as { allowLocalModels: boolean }).allowLocalModels = false;
    const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
    });
    _pipe = pipe as unknown as XenovaPipeline;
    _provider = 'xenova';
    console.log('[embeddings] Using local Xenova/all-MiniLM-L6-v2');
    return;
  } catch (err) {
    console.warn('[embeddings] Local model unavailable:', (err as Error).message);
  }

  // ── Tier 2: OpenAI ─────────────────────────────────────────────────────────
  if (process.env.OPENAI_API_KEY) {
    try {
      const { default: OpenAIClass } = await import('openai');
      const client = new OpenAIClass({ apiKey: process.env.OPENAI_API_KEY });
      // Quick health-check
      await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: 'ping',
      });
      _openaiClient = client;
      _provider = 'openai';
      console.log('[embeddings] Using OpenAI text-embedding-3-small');
      return;
    } catch (err) {
      console.warn('[embeddings] OpenAI embeddings failed:', (err as Error).message);
    }
  }

  // ── Tier 3: TF-IDF stub ────────────────────────────────────────────────────
  _provider = 'tfidf';
  console.warn('[embeddings] Falling back to TF-IDF stub (lower quality)');
}

/**
 * Embed a single text string. Returns a number[] or null on failure.
 */
export async function embed(text: string): Promise<number[] | null> {
  if (!_initPromise) {
    _initPromise = init();
  }
  await _initPromise;

  try {
    if (_provider === 'xenova' && _pipe) {
      const output = await _pipe(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data);
    }

    if (_provider === 'openai' && _openaiClient) {
      const res = await _openaiClient.embeddings.create({
        model: 'text-embedding-3-small',
        input: text.slice(0, 8192), // API limit
      });
      return res.data[0].embedding;
    }

    if (_provider === 'tfidf') {
      return tfidfEmbed(text);
    }
  } catch (err) {
    console.error('[embeddings] embed() failed:', (err as Error).message);
  }
  return null;
}

/**
 * Simple TF-IDF-inspired bag-of-words vector (512-dim, hashed).
 * Enables cosine similarity without any ML dependency.
 */
function tfidfEmbed(text: string): number[] {
  const DIM = 512;
  const vec = new Array<number>(DIM).fill(0);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

  for (const word of words) {
    const h = hashWord(word);
    vec[Math.abs(h) % DIM] += 1;
    // Negative slot for rudimentary sign-hash to reduce collision bias
    vec[Math.abs(h * 1000003) % DIM] -= 0.5;
  }

  // L2 normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

function hashWord(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}
