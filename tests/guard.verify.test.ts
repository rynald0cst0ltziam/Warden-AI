import { isAnnotation, verifyInclusion, annotation } from '../src/pruner/guard';
import { describe, it, expect } from 'vitest';

describe('guard', () => {
  it('recognizes annotation with leading whitespace (robustness)', () => {
    // Desired behavior: annotations with leading whitespace should be recognized.
    // If the implementation hasn't been updated yet this test will fail,
    // signaling the small robustness fix is still required.
    expect(isAnnotation('  ‹warden› collapsed')).toBe(true);
    expect(isAnnotation('\t‹warden› collapsed')).toBe(true);
  });

  it('verifyInclusion accepts pruned output with annotations and verbatim lines', () => {
    const raw = 'line1\nline2\nline3';
    const pruned = 'line1\n  ‹warden› collapsed\nline3';
    expect(verifyInclusion(raw, pruned)).toBe(true);
  });

  it('verifyInclusion rejects modified non-annotation line', () => {
    const raw = 'foo\nbar\nbaz';
    const pruned = 'foo\nbar_modified\nbaz';
    expect(verifyInclusion(raw, pruned)).toBe(false);
  });
});
