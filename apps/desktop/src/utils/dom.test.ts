import { describe, expect, it } from 'vitest';
import { parentOf } from './dom';

describe('parentOf', () => {
  it('finds the containing element and throws for a detached one', () => {
    const parent = document.createElement('aside');
    const child = document.createElement('div');
    parent.append(child);
    expect(parentOf(child)).toBe(parent);
    expect(() => parentOf(document.createElement('div'))).toThrow('The element is not inside another element');
  });
});
