import { describe, expect, it } from 'vitest';
import type { WorkspaceView } from '../store/workspace';
import { findView } from './views';

describe('findView', () => {
  it('finds a view by name and refuses one that does not exist', () => {
    expect(findView('explorer').title).toBe('Servers');
    expect(() => findView('settings' as WorkspaceView)).toThrow('Unknown view: settings');
  });
});
