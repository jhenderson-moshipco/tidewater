import { describe, expect, it } from 'vitest';
import { routineDefinition } from '../testing/backend';
import { blankDefinition, qualifiedName } from './describe';

describe('object names and blank definitions', () => {
  it('names a schema alone, and a routine by its schema and argument types', () => {
    expect([qualifiedName({ type: 'schema', name: 'sales', comment: null }), qualifiedName(routineDefinition())]).toEqual([
      'sales',
      'public.apply_discount(p_id bigint, p_pct numeric)',
    ]);
  });

  it('starts a new function returning void, and a new procedure with no return type', () => {
    expect([blankDefinition('function', 'public'), blankDefinition('procedure', 'public')]).toMatchObject([
      { procedure: false, returns: 'void' },
      { procedure: true, returns: '' },
    ]);
  });
});
