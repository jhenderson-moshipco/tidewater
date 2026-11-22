import { describe, expect, it } from 'vitest';
import type { LoadedChildren } from '../servers/tree-rows';
import { catalogNode, server } from '../testing/backend';
import { explorerConnection } from './default-connection';

const servers = [server({ id: 'orders-dev', database: 'orders' })];
const children: Record<string, LoadedChildren> = {
  'other|': { status: 'loaded', path: null, nodes: [catalogNode('db:shared', 'shared', { level: 'database', database: 'elsewhere' })] },
  'orders-dev|': { status: 'loaded', path: null, nodes: [catalogNode('db:billing', 'billing', { level: 'database', database: 'billing' })] },
  'orders-dev|db:billing': { status: 'loaded', path: { level: 'database', database: 'billing' }, nodes: [catalogNode('schema:public', 'public')] },
  'orders-dev|schema:public': { status: 'loading', path: { level: 'database', database: 'billing' } },
};

const at = (active_id: string | null) => explorerConnection({ active_id, servers, children });

describe('explorerConnection', () => {
  it("uses a server row's saved database", () => {
    expect(at('server:orders-dev')).toEqual({ server_id: 'orders-dev', database: 'orders' });
  });

  it("uses a database row's own database, and the database an object row was listed under", () => {
    expect(at('server:orders-dev|db:billing')).toEqual({ server_id: 'orders-dev', database: 'billing' });
    expect(at('server:orders-dev|schema:public')).toEqual({ server_id: 'orders-dev', database: 'billing' });
  });

  it("falls back to the server's saved database for a row it can't place", () => {
    expect(at('server:orders-dev|db:shared')).toEqual({ server_id: 'orders-dev', database: 'orders' });
  });

  it('has no connection without an active server row, or for a server that is gone', () => {
    expect(at(null)).toBeNull();
    expect(at('group:orders')).toBeNull();
    expect(at('server:deleted')).toBeNull();
  });
});
