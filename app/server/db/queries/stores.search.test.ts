import { describe, it, expect } from 'vitest';
import { rrfFuse } from './stores.js';

// ---------------------------------------------------------------------------
// rrfFuse unit tests
//
// RRF score for an item = 1/(k + rank₁) + 1/(k + rank₂), where rank is
// 1-based (position index + 1) and k defaults to 60.  Items appearing in only
// one list contribute a single term.  Ties are broken by product_id ascending.
// ---------------------------------------------------------------------------

describe('rrfFuse', () => {
  it('fuses two overlapping ranked lists by summed reciprocal rank', () => {
    // k = 60 (default)
    // A: rank 1 in bm25 → 1/61, rank 3 in ann → 1/63  → total ≈ 0.032266
    // B: rank 2 in bm25 → 1/62, rank 1 in ann → 1/61  → total ≈ 0.032522
    // C: rank 3 in bm25 → 1/63 only                   → total ≈ 0.015873
    // D: rank 2 in ann  → 1/62 only                   → total ≈ 0.016129
    // Expected order (descending score): B, A, D, C
    const bm25 = [{ product_id: 'A' }, { product_id: 'B' }, { product_id: 'C' }];
    const ann = [{ product_id: 'B' }, { product_id: 'D' }, { product_id: 'A' }];
    expect(rrfFuse(bm25, ann)).toEqual(['B', 'A', 'D', 'C']);
  });

  it('handles items that appear in only one list', () => {
    // X: rank 1 in bm25 → 1/61; not in ann
    // Y: rank 2 in bm25 → 1/62; not in ann
    // Z: not in bm25;  rank 1 in ann → 1/61
    // X and Z tie at 1/61; tie-break: 'X' < 'Z' → X first
    // Expected order: X, Z, Y
    const bm25 = [{ product_id: 'X' }, { product_id: 'Y' }];
    const ann = [{ product_id: 'Z' }];
    expect(rrfFuse(bm25, ann)).toEqual(['X', 'Z', 'Y']);
  });

  it('returns empty array for two empty lists', () => {
    expect(rrfFuse([], [])).toEqual([]);
  });

  it('returns items from a single non-empty list in rank order', () => {
    const bm25 = [{ product_id: 'P1' }, { product_id: 'P2' }, { product_id: 'P3' }];
    const result = rrfFuse(bm25, []);
    // 1/61 > 1/62 > 1/63 → same input order
    expect(result).toEqual(['P1', 'P2', 'P3']);
  });

  it('respects a custom k value', () => {
    // k = 0 → scores are 1/1, 1/2, 1/3, …
    // A: rank 1 in bm25 → 1/1 = 1.0; rank 2 in ann → 1/2 = 0.5  → 1.5
    // B: rank 2 in bm25 → 1/2 = 0.5; rank 1 in ann → 1/1 = 1.0  → 1.5  (tie → 'A' < 'B')
    // C: rank 3 in bm25 → 1/3; not in ann                         → 0.333
    const bm25 = [{ product_id: 'A' }, { product_id: 'B' }, { product_id: 'C' }];
    const ann = [{ product_id: 'B' }, { product_id: 'A' }];
    const result = rrfFuse(bm25, ann, 0);
    expect(result[0]).toBe('A'); // tie-break: 'A' < 'B'
    expect(result[1]).toBe('B');
    expect(result[2]).toBe('C');
  });

  it('deduplicates items that appear multiple times only in the fused view', () => {
    // Same item 'X' is the first result in both lists → score = 1/61 + 1/61
    // Item 'Y' is second in both → 1/62 + 1/62
    const bm25 = [{ product_id: 'X' }, { product_id: 'Y' }];
    const ann = [{ product_id: 'X' }, { product_id: 'Y' }];
    const result = rrfFuse(bm25, ann);
    // X > Y; no duplicates in result
    expect(result).toEqual(['X', 'Y']);
  });
});
