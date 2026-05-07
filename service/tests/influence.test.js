'use strict';

const { cosineSimilarity, computeTopInfluences, parseEmbedding } = require('../src/influence');

describe('cosineSimilarity', () => {
  test('identical vectors return 1', () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  test('orthogonal vectors return 0', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  test('opposite vectors return -1', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  test('zero vector returns 0', () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  test('mismatched lengths return 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  test('partial similarity', () => {
    const a = [1, 1, 0];
    const b = [1, 0, 0];
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

describe('computeTopInfluences', () => {
  const makeChunk = (id, nodeId, embedding) => ({ id, node_id: nodeId, embedding });

  test('returns empty array when no synthesis chunks', () => {
    const priors = [makeChunk('p1', 'n1', [1, 0, 0])];
    expect(computeTopInfluences([], priors, 5)).toEqual([]);
  });

  test('returns empty array when no prior chunks', () => {
    const syn = [makeChunk('s1', 'n_syn', [1, 0, 0])];
    expect(computeTopInfluences(syn, [], 5)).toEqual([]);
  });

  test('returns top-k results sorted by weight desc', () => {
    const syn = [makeChunk('s1', 'n_syn', [1, 0, 0])];
    const priors = [
      makeChunk('p1', 'n1', [1, 0, 0]),   // sim = 1.0
      makeChunk('p2', 'n2', [0, 1, 0]),   // sim = 0.0
      makeChunk('p3', 'n3', [0.9, 0.1, 0]), // sim ~ 0.99
    ];
    const result = computeTopInfluences(syn, priors, 2);
    expect(result.length).toBe(2);
    expect(result[0].weight).toBeGreaterThanOrEqual(result[1].weight);
  });

  test('does not include self (same id)', () => {
    const synChunk = makeChunk('s1', 'n_syn', [1, 0, 0]);
    // Prior includes a copy with same id (shouldn't happen in practice but guard anyway)
    const priors = [
      { ...synChunk }, // same id
      makeChunk('p1', 'n1', [0.8, 0.1, 0]),
    ];
    const result = computeTopInfluences([synChunk], priors, 5);
    const ids = result.map(r => r.source_chunk_id);
    expect(ids).not.toContain('s1');
  });

  test('skips chunks without embeddings', () => {
    const syn = [makeChunk('s1', 'n_syn', [1, 0, 0])];
    const priors = [
      makeChunk('p1', 'n1', null),
      makeChunk('p2', 'n2', [1, 0, 0]),
    ];
    const result = computeTopInfluences(syn, priors, 5);
    const ids = result.map(r => r.source_chunk_id);
    expect(ids).not.toContain('p1');
    expect(ids).toContain('p2');
  });
});

describe('parseEmbedding', () => {
  test('returns null for null input', () => {
    expect(parseEmbedding(null)).toBeNull();
  });

  test('returns array as-is', () => {
    const v = [1, 2, 3];
    expect(parseEmbedding(v)).toBe(v);
  });

  test('parses JSON string', () => {
    expect(parseEmbedding('[1,2,3]')).toEqual([1, 2, 3]);
  });

  test('returns null for invalid JSON', () => {
    expect(parseEmbedding('not-json')).toBeNull();
  });
});
