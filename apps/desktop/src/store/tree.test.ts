import { describe, expect, it, vi } from 'vitest';
import type { CatalogPath } from '../generated/catalog';
import { childrenKey, nodeRowId, serverRowId, type TreeRow } from '../servers/tree-rows';
import { catalogNode, commandsOf, failWith, group, mockCommands, server } from '../testing/backend';
import { rowWithId } from '../testing/tree';
import { useExplorerStore } from './explorer';
import { useServerStore } from './servers';
import { useTreeStore } from './tree';

const tree = () => useTreeStore.getState();
const info = { server_id: 'orders-dev', database: 'orders', server_version: '17.2', encryption: null };
const orders_path: CatalogPath = { level: 'database', database: 'orders' };
const databases = [catalogNode('db:orders', 'orders', orders_path), catalogNode('db:postgres', 'postgres', { level: 'database', database: 'postgres' })];
const schemas = [catalogNode('db:orders/schema:2200', 'public', { level: 'schema', database: 'orders', schema_oid: 2200 })];
const server_row = serverRowId('orders-dev');
const orders_row = nodeRowId('orders-dev', 'db:orders');

function catalogAnswers(args: Record<string, unknown>) {
  return args.path === null ? databases : schemas;
}

function connected() {
  useServerStore.setState({ servers: [server()], connections: { 'orders-dev': { status: 'connected', info } } });
}

describe('expanding a server', () => {
  it('connects, announces it, lists the databases and opens the saved one', async () => {
    useServerStore.setState({ servers: [server()] });
    const calls = mockCommands({ connect_server: () => info, catalog_children: catalogAnswers });

    await tree().expandRow(rowWithId(server_row));

    expect(commandsOf(calls)).toEqual(['connect_server', 'catalog_children', 'catalog_children']);
    expect(calls[2].args).toEqual({ server_id: 'orders-dev', path: orders_path, show_system: false });
    expect(tree().expanded).toEqual({ [server_row]: true, [orders_row]: true });
    expect(tree().children[childrenKey('orders-dev', 'db:orders')]).toEqual({ status: 'loaded', path: orders_path, nodes: schemas });
    expect(tree().announcement).toBe('Connected to orders-dev');
  });

  it('announces a failed connection and loads nothing', async () => {
    useServerStore.setState({ servers: [server()] });
    const calls = mockCommands({ connect_server: () => failWith('connection', 'password authentication failed') });

    await tree().expandRow(rowWithId(server_row));

    expect(commandsOf(calls)).toEqual(['connect_server']);
    expect(tree().announcement).toBe('password authentication failed');
  });

  it('collapses a server whose connect was cancelled, says so and loads nothing', async () => {
    useServerStore.setState({ servers: [server()] });
    const calls = mockCommands({ connect_server: () => failWith('cancelled', 'Connecting was cancelled.') });

    await tree().expandRow(rowWithId(server_row));

    expect(commandsOf(calls)).toEqual(['connect_server']);
    expect([tree().expanded, tree().announcement]).toEqual([{}, 'Stopped connecting to orders-dev']);
  });

  it('loads nothing again for a connected server whose databases are loaded', async () => {
    connected();
    useTreeStore.setState({ children: { [childrenKey('orders-dev')]: { status: 'loaded', path: null, nodes: databases } } });
    const calls = mockCommands({});

    await tree().expandRow(rowWithId(server_row));

    expect(calls).toEqual([]);
  });

  it('leaves the databases closed when the saved one is not on the server', async () => {
    connected();
    useServerStore.setState({ servers: [server({ database: 'archive' })] });
    mockCommands({ catalog_children: catalogAnswers });

    await tree().expandRow(rowWithId(server_row));

    expect(tree().expanded).toEqual({ [server_row]: true });
  });

  it('still opens a server the list no longer has, under a plain name', async () => {
    const ghost = server({ id: 'ghost' });
    const row: TreeRow = { ...rowWithIdFor(ghost.id), item: { type: 'server', server: ghost, connection: undefined } };
    const calls = mockCommands({ connect_server: () => info, catalog_children: catalogAnswers });

    await tree().expandRow(row);

    expect(tree().announcement).toBe('Connected to server');
    expect(commandsOf(calls)).toEqual(['connect_server', 'catalog_children']);
  });

  it('shows and announces a list that failed to load', async () => {
    connected();
    mockCommands({ catalog_children: () => failWith('connection', 'connection closed') });

    await tree().expandRow(rowWithId(server_row));

    expect(tree().children[childrenKey('orders-dev')]).toEqual({ status: 'failed', path: null, message: 'connection closed' });
    expect(tree().announcement).toBe('connection closed');
  });
});

function rowWithIdFor(server_id: string): TreeRow {
  return {
    id: serverRowId(server_id),
    parent_id: null,
    level: 1,
    setsize: 1,
    posinset: 1,
    label: server_id,
    expandable: true,
    expanded: false,
    chevron_slot: true,
    item: { type: 'loading' },
  };
}

describe('expanding and collapsing other rows', () => {
  it('loads a catalog node once', async () => {
    connected();
    useTreeStore.setState({
      expanded: { [server_row]: true },
      children: { [childrenKey('orders-dev')]: { status: 'loaded', path: null, nodes: databases } },
    });
    const calls = mockCommands({ catalog_children: catalogAnswers });

    await tree().expandRow(rowWithId(orders_row));
    tree().collapseRow(rowWithId(orders_row));
    await tree().expandRow(rowWithId(orders_row));

    expect(commandsOf(calls)).toEqual(['catalog_children']);
    expect(tree().expanded).toEqual({ [server_row]: true, [orders_row]: true });
  });

  it('expands and collapses groups through the explorer store, only when they need it', async () => {
    useServerStore.setState({ groups: [group()] });
    const group_row = 'group:orders-platform';

    await tree().expandRow(rowWithId(group_row));
    expect(useExplorerStore.getState().collapsed_groups).toEqual({});
    tree().collapseRow(rowWithId(group_row));
    expect(useExplorerStore.getState().collapsed_groups).toEqual({ 'orders-platform': true });
    tree().collapseRow(rowWithId(group_row));
    expect(useExplorerStore.getState().collapsed_groups).toEqual({ 'orders-platform': true });
    await tree().expandRow(rowWithId(group_row));
    expect(useExplorerStore.getState().collapsed_groups).toEqual({});
  });

  it('ignores loading and error rows', async () => {
    const calls = mockCommands({});
    await tree().expandRow(rowWithIdFor('orders-dev'));
    expect([calls, tree().expanded]).toEqual([[], {}]);
  });
});

describe('refreshing', () => {
  function loadedTree() {
    connected();
    useTreeStore.setState({
      expanded: { [server_row]: true, [orders_row]: true },
      children: {
        [childrenKey('orders-dev')]: { status: 'loaded', path: null, nodes: databases },
        [childrenKey('orders-dev', 'db:orders')]: { status: 'loaded', path: orders_path, nodes: schemas },
        [childrenKey('orders-dev', 'db:orders/schema:2200')]: { status: 'loaded', path: null, nodes: [] },
      },
    });
  }

  it('reloads an open server from its databases down', async () => {
    loadedTree();
    const calls = mockCommands({ catalog_children: catalogAnswers });

    await tree().refreshRow(rowWithId(server_row));

    expect(commandsOf(calls)).toEqual(['catalog_children', 'catalog_children']);
    expect(Object.keys(tree().children).sort()).toEqual([childrenKey('orders-dev'), childrenKey('orders-dev', 'db:orders')]);
  });

  it('drops a closed server or node without reloading it', async () => {
    loadedTree();
    const calls = mockCommands({});
    const closed_server = { ...rowWithId(server_row), expanded: false };
    const closed_node = { ...rowWithId(orders_row), expanded: false };

    await tree().refreshRow(closed_node);
    expect(Object.keys(tree().children)).toEqual([childrenKey('orders-dev')]);
    await tree().refreshRow(closed_server);
    expect([tree().children, calls]).toEqual([{}, []]);
  });

  it('reloads an open node and nothing above it', async () => {
    loadedTree();
    const calls = mockCommands({ catalog_children: catalogAnswers });

    await tree().refreshRow(rowWithId(orders_row));

    expect(calls.map((call) => call.args)).toEqual([{ server_id: 'orders-dev', path: orders_path, show_system: false }]);
  });

  it('does nothing for leaves and placeholder rows', async () => {
    loadedTree();
    const before = tree().children;
    const leaf: TreeRow = { ...rowWithId(orders_row), item: { type: 'node', server_id: 'orders-dev', node: catalogNode('db:orders/col:id', 'id') } };

    await tree().refreshRow(leaf);
    await tree().refreshRow(rowWithIdFor('orders-dev'));

    expect(tree().children).toBe(before);
  });
});

describe('system objects', () => {
  it('toggling reloads every database listing, announces it, and is remembered', async () => {
    useTreeStore.setState({
      children: {
        [childrenKey('orders-dev')]: { status: 'loaded', path: null, nodes: databases },
        [childrenKey('orders-dev', 'db:orders')]: { status: 'loaded', path: orders_path, nodes: schemas },
      },
    });
    const calls = mockCommands({ catalog_children: catalogAnswers });

    tree().toggleSystem();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].args).toEqual({ server_id: 'orders-dev', path: orders_path, show_system: true });
    expect(tree().announcement).toBe('Showing system objects');
    expect(JSON.parse(localStorage.getItem('tidewater-tree') ?? '{}').state).toMatchObject({ show_system: true });

    tree().toggleSystem();
    expect(tree().announcement).toBe('Hiding system objects');
  });
});

describe('forgetting a server', () => {
  it('drops its rows and listings and keeps other servers', () => {
    useTreeStore.setState({
      expanded: { [server_row]: true, [orders_row]: true, [serverRowId('billing')]: true },
      children: { [childrenKey('orders-dev')]: { status: 'loading', path: null }, [childrenKey('billing')]: { status: 'loading', path: null } },
    });

    tree().forgetServer('orders-dev');

    expect(tree().expanded).toEqual({ [serverRowId('billing')]: true });
    expect(tree().children).toEqual({ [childrenKey('billing')]: { status: 'loading', path: null } });
  });
});

describe('reopening servers at launch', () => {
  const second = serverRowId('billing');

  function saved() {
    useServerStore.setState({ store: { status: 'unlocked', has_saved_file: true, reason: null }, servers: [server(), server({ id: 'billing', name: 'billing', database: 'billing' })] });
  }

  it('remembers a server once it connects through the tree, and forgets it when it fails, is cancelled or is closed', async () => {
    useServerStore.setState({ servers: [server()] });
    const answers = [() => info, () => failWith('connection', 'refused')];
    mockCommands({ connect_server: () => (answers.shift() as () => unknown)(), catalog_children: catalogAnswers });

    await tree().expandRow(rowWithId(server_row));
    expect(tree().open_servers).toEqual(['orders-dev']);
    expect(JSON.parse(localStorage.getItem('tidewater-tree') ?? '{}').state).toMatchObject({ open_servers: ['orders-dev'], expanded: { [server_row]: true } });

    useServerStore.setState({ connections: {} });
    await tree().expandRow(rowWithId(server_row));
    expect(tree().open_servers).toEqual([]);

    useTreeStore.setState({ open_servers: ['orders-dev', 'billing'] });
    tree().forgetServer('orders-dev');
    expect(tree().open_servers).toEqual(['billing']);
  });

  it('reconnects the servers open at the last quit, reopening the expanded ones row by row and only connecting the rest', async () => {
    saved();
    useTreeStore.setState({
      open_servers: ['orders-dev', 'billing'],
      expanded: { [server_row]: true, [orders_row]: true, [nodeRowId('orders-dev', 'db:orders/schema:2200')]: true },
      children: { [childrenKey('orders-dev', 'db:postgres')]: { status: 'failed', path: null, message: 'permission denied' } },
    });
    const calls = mockCommands({ connect_server: () => info, catalog_children: catalogAnswers });

    await tree().reopen();

    expect(commandsOf(calls).filter((command) => command === 'connect_server')).toHaveLength(2);
    expect(calls.filter((call) => call.command === 'catalog_children').map((call) => call.args)).toEqual([
      { server_id: 'orders-dev', path: null, show_system: false },
      { server_id: 'orders-dev', path: orders_path, show_system: false },
      { server_id: 'orders-dev', path: schemas[0]!.children, show_system: false },
    ]);
    expect(useServerStore.getState().connections.billing).toEqual({ status: 'connected', info });
    expect(tree().expanded[second]).toBeUndefined();
  });

  it('drops servers that were deleted, and their rows, and reconnects nothing while saved servers are locked', async () => {
    saved();
    useTreeStore.setState({ open_servers: ['gone'], expanded: { [serverRowId('gone')]: true, 'group:orders': true } });
    const calls = mockCommands({});

    await tree().reopen();
    expect([tree().open_servers, tree().expanded, calls]).toEqual([[], { 'group:orders': true }, []]);

    useServerStore.setState({ store: { status: 'needs_passphrase', has_saved_file: true, reason: null } });
    useTreeStore.setState({ open_servers: ['orders-dev'] });
    await tree().reopen();
    expect(calls).toEqual([]);
  });
});

