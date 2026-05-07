'use strict';

// Approximate token count: ~4 chars per token (BPE rough estimate)
const CHARS_PER_TOKEN = 4;
const CHUNK_TOKENS = 512;
const STRIDE_TOKENS = 128;
const CHUNK_CHARS = CHUNK_TOKENS * CHARS_PER_TOKEN;   // 2048
const STRIDE_CHARS = STRIDE_TOKENS * CHARS_PER_TOKEN; // 512

/**
 * Split text into overlapping chunks using a sliding window.
 * Returns an array of { index, content } objects.
 *
 * Window:  512 tokens (~2048 chars)
 * Stride:  128 tokens (~512 chars)
 */
function chunkText(text) {
  if (!text || text.length === 0) return [{ index: 0, content: '' }];

  const chunks = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    const end = Math.min(start + CHUNK_CHARS, text.length);
    chunks.push({ index, content: text.slice(start, end) });
    index += 1;

    if (end >= text.length) break;
    start += STRIDE_CHARS;
  }

  // Always produce at least one chunk
  if (chunks.length === 0) {
    chunks.push({ index: 0, content: text });
  }

  return chunks;
}

/**
 * Approximate token count for a string.
 */
function approxTokenCount(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

module.exports = { chunkText, approxTokenCount, CHUNK_TOKENS, STRIDE_TOKENS };
