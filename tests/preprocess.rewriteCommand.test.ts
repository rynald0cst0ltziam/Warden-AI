import { rewriteCommand } from '../src/pruner/preprocess';
import { describe, it, expect } from 'vitest';

describe('rewriteCommand', () => {
  it('adds --silent to npm install when missing', () => {
    const out = rewriteCommand('npm install');
    expect(out).toContain('--silent');
    expect(out.startsWith('npm install')).toBe(true);
  });

  it('does not duplicate flags when already present', () => {
    expect(rewriteCommand('npm install --silent')).toBe('npm install --silent');
  });

  it('adds --no-color to git diff when missing', () => {
    const out = rewriteCommand('git diff');
    expect(out).toContain('--no-color');
  });
});
