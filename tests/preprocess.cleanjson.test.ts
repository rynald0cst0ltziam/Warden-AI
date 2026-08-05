import { cleanJson } from '../src/pruner/preprocess';
import { describe, it, expect } from 'vitest';

describe('cleanJson', () => {
  it('preserves false booleans and empty arrays/objects, and removes null/empty strings', () => {
    const inputObj = {
      ok: true,
      none: null,
      flag: false,
      emptyArr: [],
      emptyObj: {},
      emptyStr: "",
      nested: { a: null, b: false, c: [] }
    };
    const input = JSON.stringify(inputObj, null, 2);
    const out = cleanJson(input);

    // If cleanJson returned the original string, parse the original to assert
    const parsed = JSON.parse(out);

    // false should be preserved
    expect(parsed.flag).toBe(false);

    // empty arrays/objects should be preserved (as per current conservative behaviour)
    expect(Array.isArray(parsed.emptyArr)).toBe(true);
    expect(typeof parsed.emptyObj).toBe('object');

    // nulls and empty strings should be removed
    expect(parsed).not.toHaveProperty('none');
    expect(parsed).not.toHaveProperty('emptyStr');

    // nested false preserved, nested null removed
    expect(parsed.nested.b).toBe(false);
    expect(parsed.nested).not.toHaveProperty('a');
  });

  it('returns original when cleanup does not reduce compact size', () => {
    const input = JSON.stringify({ a: [1,2,3] });
    const out = cleanJson(input);
    expect(out).toBe(input);
  });
});
