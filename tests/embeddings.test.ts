import { describe, it, expect } from 'vitest';
import { cosineSimilarity, keywordScore } from '../server/embeddings';

describe('embeddings helpers (pure functions — no Ollama needed)', () => {
  it('cosineSimilarity: identical vectors score 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('cosineSimilarity: orthogonal vectors score 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('cosineSimilarity: opposite vectors score -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('cosineSimilarity: mismatched or empty vectors return -1', () => {
    expect(cosineSimilarity([], [])).toBe(-1);
    expect(cosineSimilarity([1], [1, 2])).toBe(-1);
    expect(cosineSimilarity(null as any, [1])).toBe(-1);
  });

  it('keywordScore: full overlap scores 1', () => {
    expect(keywordScore('run tests now', 'please run the tests now')).toBeCloseTo(1);
  });

  it('keywordScore: no overlap scores 0', () => {
    expect(keywordScore('quantum flux capacitor', 'npm test passes locally')).toBe(0);
  });

  it('keywordScore ignores very short stopword-like tokens', () => {
    // "to" and "is" are <=2 chars and excluded from scoring
    const score = keywordScore('to is refactoring', 'refactoring');
    expect(score).toBeCloseTo(1);
  });
});
