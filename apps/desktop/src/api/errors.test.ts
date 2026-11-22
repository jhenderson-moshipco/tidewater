import { describe, expect, it } from 'vitest';
import { messageOf } from './errors';

describe('messageOf', () => {
  it('reads the message of an error from the Rust core', () => {
    expect(messageOf({ kind: 'not_found', message: 'No saved server with id 7' })).toBe('No saved server with id 7');
  });

  it('reads the message of a JavaScript error', () => {
    expect(messageOf(new Error('The webview closed'))).toBe('The webview closed');
  });

  it('turns anything else into text', () => {
    expect(messageOf('timed out')).toBe('timed out');
    expect(messageOf(null)).toBe('null');
    expect(messageOf({ kind: 'not_found' })).toBe('[object Object]');
  });
});
