'use strict';

const { chunkText, approxTokenCount, CHUNK_TOKENS, STRIDE_TOKENS } = require('../src/chunker');

describe('chunkText', () => {
  test('returns single chunk for short text', () => {
    const text = 'Hello world, this is a short piece of text.';
    const chunks = chunkText(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].content).toBe(text);
  });

  test('returns empty chunk for empty string', () => {
    const chunks = chunkText('');
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe('');
  });

  test('returns empty chunk for null', () => {
    const chunks = chunkText(null);
    expect(chunks.length).toBe(1);
  });

  test('produces multiple chunks for long text', () => {
    // 512 tokens * 4 chars/token = 2048 chars per chunk
    // Create text longer than 2048 chars to force multiple chunks
    const text = 'a '.repeat(1500); // 3000 chars ~ 750 tokens
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('chunks have sequential indexes', () => {
    const text = 'word '.repeat(600); // 3000 chars ~ 750 tokens
    const chunks = chunkText(text);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
    });
  });

  test('chunks overlap (stride < window)', () => {
    // window = 2048 chars, stride = 512 chars
    // With text of 2600 chars: chunk 0 = [0, 2048], chunk 1 = [512, 2560], chunk 2 = [1024, 2600]
    const text = 'x'.repeat(2600);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should start 512 chars after the previous
    expect(chunks[1].content[0]).toBe(text[512]);
  });

  test('last chunk covers the end of text', () => {
    const text = 'word '.repeat(600);
    const chunks = chunkText(text);
    const last = chunks[chunks.length - 1];
    expect(last.content).toBe(text.slice(text.length - last.content.length));
    // Make sure last chunk ends at the very end
    const allEnds = chunks.map((c, i) => {
      const start = i * 512; // STRIDE_CHARS
      return start + c.content.length;
    });
    expect(allEnds[allEnds.length - 1]).toBe(text.length);
  });
});

describe('approxTokenCount', () => {
  test('returns 0 for empty string', () => {
    expect(approxTokenCount('')).toBe(0);
  });

  test('returns 1 for 4 chars', () => {
    expect(approxTokenCount('abcd')).toBe(1);
  });

  test('returns ceiling', () => {
    expect(approxTokenCount('abcde')).toBe(2);
  });

  test('CHUNK_TOKENS and STRIDE_TOKENS are positive integers', () => {
    expect(CHUNK_TOKENS).toBeGreaterThan(0);
    expect(STRIDE_TOKENS).toBeGreaterThan(0);
    expect(STRIDE_TOKENS).toBeLessThan(CHUNK_TOKENS);
  });
});
