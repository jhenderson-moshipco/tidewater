import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { childrenKey, groupRowId, nodeRowId, serverRowId } from './tree-rows';
import { useDialogStore } from '../store/dialogs';
import { useObjectEditorStore, type EditorRequest } from '../store/object-editors';
import { useServerStore } from '../store/servers';
import { useTreeStore } from '../store/tree';
import { catalogNode, commandsOf, group, mockCommands, objectRef, server } from '../testing/backend';
import { renderWithUser } from '../testing/render';
import { ServerTree } from './server-tree';

const info = { server_id: 'orders-dev', database: 'orders', server_version: '17.2', encryption: null };
const orders_path = { level: 'database', database: 'orders' } as const;
const dialog = () => useDialogStore.getState().open;

/** A group with one server, an open server with loaded databases, and a server whose listing failed. */
function populatedTree() {
  useServerStore.setState({
    groups: [group(), group({ id: 'empty', name: 'Archive' })],
    servers: [
      server({ id: 'billing', name: 'billing', group_id: 'orders-platform', environment: 'prod' }),
      server(),
      server({ id: 'broken', name: 'broken' }),
    ],
    connections: { 'orders-dev': { status: 'connected', info }, broken: { status: 'connected', info } },
  });
  useTreeStore.setState({
    expanded: { [serverRowId('orders-dev')]: true, [nodeRowId('orders-dev', 'db:orders')]: true, [serverRowId('broken')]: true },
    children: {
      [childrenKey('orders-dev')]: { status: 'loaded', path: null, nodes: [catalogNode('db:orders', 'orders', orders_path, '3 schemas')] },
      [childrenKey('orders-dev', 'db:orders')]: { status: 'loading', path: orders_path },
      [childrenKey('broken')]: { status: 'failed', path: null, message: 'connection closed' },
    },
  });
}

const items = () => screen.getAllByRole('treeitem');
function item(text: RegExp): HTMLElement {
  const found = items().find((row) => text.test(row.textContent ?? ''));
  if (!found) throw new Error(`No tree item matches ${text}`);
  return found;
}
const tree = () => screen.getByRole('tree', { name: 'Servers' });
const active = () => tree().getAttribute('aria-activedescendant');

describe('the server tree', () => {
  it('shows every row as a tree item with its level, position and state', () => {
    populatedTree();
    renderWithUser(<ServerTree />);

    expect(items().map((row) => row.textContent)).toEqual([
      'Orders platform1 server',
      'billingPRODNot connected',
      'Archive0 servers',
      'orders-devDEVConnected · PG 17.2',
      'orders3 schemas',
      'Loading…',
      'brokenDEVConnected · PG 17.2',
      'connection closed',
    ]);
    const orders = item(/^orders3 schemas/);
    expect([orders.getAttribute('aria-level'), orders.getAttribute('aria-expanded')]).toEqual(['2', 'true']);
    expect([item(/^Archive/).getAttribute('aria-setsize'), item(/^Archive/).getAttribute('aria-posinset')]).toEqual(['4', '2']);
    expect(item(/^Loading/).getAttribute('aria-expanded')).toBeNull();
    expect(active()).toBe(`tree-row-${groupRowId('orders-platform')}`);
  });

  it('announces what the tree store reports', () => {
    populatedTree();
    renderWithUser(<ServerTree />);
    act(() => useTreeStore.setState({ announcement: 'Connected to orders-dev' }));
    expect(screen.getByRole('status').textContent).toBe('Connected to orders-dev');
  });

  it('moves with the arrow keys, Home, End and type-ahead, and expands and collapses', async () => {
    populatedTree();
    const expandRow = vi.fn(async () => undefined);
    const collapseRow = vi.fn();
    useTreeStore.setState({ expandRow, collapseRow });
    const { user } = renderWithUser(<ServerTree />);
    tree().focus();

    await user.keyboard('{ArrowDown}');
    expect(active()).toBe(`tree-row-${serverRowId('billing')}`);
    await user.keyboard('{ArrowRight}');
    expect(expandRow).toHaveBeenCalledWith(expect.objectContaining({ id: serverRowId('billing') }));
    await user.keyboard('{ArrowUp}{ArrowLeft}');
    expect(collapseRow).toHaveBeenCalledWith(expect.objectContaining({ id: groupRowId('orders-platform') }));
    await user.keyboard('{End}');
    expect(active()).toBe(`tree-row-${serverRowId('broken')}|error`);
    await user.keyboard('{Home}o');
    expect(active()).toBe(`tree-row-${serverRowId('orders-dev')}`);
    await user.keyboard('{Tab}');
  });

  it('runs a row with Enter or a double-click: toggling it, or retrying an error', async () => {
    populatedTree();
    const refreshRow = vi.fn(async () => undefined);
    const collapseRow = vi.fn();
    const expandRow = vi.fn(async () => undefined);
    useTreeStore.setState({ refreshRow, collapseRow, expandRow, active_id: `${serverRowId('broken')}|error` });
    const { user } = renderWithUser(<ServerTree />);
    tree().focus();

    await user.keyboard('{Enter}');
    expect(refreshRow).toHaveBeenCalledWith(expect.objectContaining({ id: serverRowId('broken') }));
    await user.dblClick(item(/^orders-dev/));
    expect(collapseRow).toHaveBeenCalledWith(expect.objectContaining({ id: serverRowId('orders-dev') }));
    await user.dblClick(item(/^billing/));
    expect(expandRow).toHaveBeenCalledWith(expect.objectContaining({ id: serverRowId('billing') }));
    await user.dblClick(item(/^Loading/));
    expect(expandRow).toHaveBeenCalledTimes(1);
  });

  it('opens the edit, rename and delete dialogs with F2, Delete and Backspace, and refreshes with F5', async () => {
    populatedTree();
    const refreshRow = vi.fn(async () => undefined);
    useTreeStore.setState({ refreshRow });
    const { user } = renderWithUser(<ServerTree />);
    tree().focus();

    await user.keyboard('{F2}');
    expect(dialog()).toEqual({ kind: 'group', editing: group() });
    await user.keyboard('{Backspace}');
    expect(dialog()).toEqual({ kind: 'delete-group', group: group(), server_count: 1 });
    await user.keyboard('{ArrowDown}{F2}');
    expect(dialog()).toMatchObject({ kind: 'connection', editing: { id: 'billing' } });
    await user.keyboard('{Delete}');
    expect(dialog()).toMatchObject({ kind: 'delete-server', server: { id: 'billing' } });
    await user.keyboard('{F5}');
    expect(refreshRow).toHaveBeenCalledWith(expect.objectContaining({ id: serverRowId('billing') }));

    act(() => useDialogStore.getState().close());
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{F2}{Delete}{F10}');
    expect(dialog()).toBeNull();
  });

  it('opens the row menu from the keyboard and with a right-click', async () => {
    populatedTree();
    const calls = mockCommands({ 'plugin:menu|new': () => [1, 'menu'], 'plugin:menu|popup': () => null });
    const { user } = renderWithUser(<ServerTree />);
    tree().focus();

    await user.keyboard('{Shift>}{F10}{/Shift}');
    await user.keyboard('{ContextMenu}');
    await user.pointer({ keys: '[MouseRight]', target: item(/^billing/) });

    await vi.waitFor(() => expect(commandsOf(calls).filter((command) => command === 'plugin:menu|popup')).toHaveLength(3));
    expect(active()).toBe(`tree-row-${serverRowId('billing')}`);
  });

  it('makes a clicked row active, and the chevron toggles it', async () => {
    populatedTree();
    const collapseRow = vi.fn();
    useTreeStore.setState({ collapseRow });
    const { user } = renderWithUser(<ServerTree />);
    const orders_dev = item(/^orders-dev/);

    await user.click(orders_dev);
    expect([active(), orders_dev.getAttribute('aria-selected'), document.activeElement]).toEqual([`tree-row-${serverRowId('orders-dev')}`, 'true', tree()]);

    await user.click(orders_dev.firstElementChild as HTMLElement);
    expect(collapseRow).toHaveBeenCalledWith(expect.objectContaining({ id: serverRowId('orders-dev') }));
  });

  it('renders only the rows in view, plus the active row when it is scrolled away', async () => {
    useServerStore.setState({ servers: Array.from({ length: 100 }, (_, index) => server({ id: `s${index}`, name: `server ${index}` })) });
    const { user } = renderWithUser(<ServerTree />);
    const visible = Math.ceil(window.innerHeight / 24) + 24;
    expect(items()).toHaveLength(visible);
    tree().focus();

    await user.keyboard('{End}');
    expect(items()).toHaveLength(visible + 1);
    expect(tree().scrollTop).toBe(100 * 24);

    fireEvent.scroll(tree(), { target: { scrollTop: 1200 } });
    expect(items()[0].textContent).toMatch(/^server 38/);

    Object.defineProperty(tree(), 'clientHeight', { value: 240 });
    tree().scrollTop = 0;
    await user.keyboard('{Home}{ArrowDown}');
    expect(tree().scrollTop).toBe(0);
    tree().scrollTop = 480;
    await user.keyboard('{ArrowUp}');
    expect(tree().scrollTop).toBe(0);
  });

  it('ignores keys when there are no rows', async () => {
    const { user } = renderWithUser(<ServerTree />);
    tree().focus();
    await user.keyboard('{ArrowDown}');
    expect(active()).toBeNull();
  });

  it('shows a connecting server with a spinner and its seconds so far, and Escape cancels it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(20_000);
    useServerStore.setState({ servers: [server()], connections: { 'orders-dev': { status: 'connecting', started: 16_000 } } });
    useTreeStore.setState({ active_id: serverRowId('orders-dev') });
    const calls = mockCommands({ cancel_connect: () => null });
    const { unmount } = renderWithUser(<ServerTree />);
    const connecting = item(/orders-dev/);

    expect(connecting.textContent).toContain('Connecting… 4 s');
    expect(connecting.getAttribute('aria-keyshortcuts')).toBe('Escape');
    act(() => vi.advanceTimersByTime(1_000));
    expect(connecting.textContent).toContain('Connecting… 5 s');
    fireEvent.keyDown(tree(), { key: 'Escape' });
    unmount();
    vi.useRealTimers();

    expect(calls).toEqual([{ command: 'cancel_connect', args: { id: 'orders-dev' } }]);
  });

  it('leaves Escape alone on a server that is not connecting', () => {
    useServerStore.setState({ servers: [server()] });
    useTreeStore.setState({ active_id: serverRowId('orders-dev') });
    const calls = mockCommands({});
    renderWithUser(<ServerTree />);

    fireEvent.keyDown(tree(), { key: 'Escape' });

    expect([calls, item(/orders-dev/).getAttribute('aria-keyshortcuts')]).toEqual([[], null]);
  });

  it('gives an error row as many lines as its message needs, so none of it is cut off', () => {
    useServerStore.setState({ servers: [server()], connections: { 'orders-dev': { status: 'failed', message: 'x'.repeat(120) } } });
    useTreeStore.setState({ expanded: { [serverRowId('orders-dev')]: true } });
    renderWithUser(<ServerTree />);

    const error = item(/^x+$/);

    expect(error.style.height).toBe(`${5 * 18 + 6}px`);
  });

  it('shows a failed server as Failed after its badge', () => {
    useServerStore.setState({ servers: [server()], connections: { 'orders-dev': { status: 'failed', message: 'refused' } } });
    renderWithUser(<ServerTree />);
    expect(item(/^orders-dev/).textContent).toBe('orders-devDEVFailed');
  });
});

describe('editing objects from the tree', () => {
  const schema_ref = objectRef({ object_type: 'schema', oid: 2200 });
  const view_ref = objectRef();
  const folder = (kind: 'view' | 'table') => ({ level: 'folder', database: 'orders', schema_oid: 2200, kind }) as const;

  /** orders-dev open down to a view in public's Views folder, beside a Tables folder the editors don't cover yet. */
  function objectTree() {
    useServerStore.setState({ servers: [server()], connections: { 'orders-dev': { status: 'connected', info } } });
    const db = 'db:orders';
    const schema = `${db}/schema:2200`;
    useTreeStore.setState({
      expanded: {
        [serverRowId('orders-dev')]: true,
        [nodeRowId('orders-dev', db)]: true,
        [nodeRowId('orders-dev', schema)]: true,
        [nodeRowId('orders-dev', `${schema}/View`)]: true,
      },
      children: {
        [childrenKey('orders-dev')]: { status: 'loaded', path: null, nodes: [catalogNode(db, 'orders', orders_path)] },
        [childrenKey('orders-dev', db)]: {
          status: 'loaded',
          path: orders_path,
          nodes: [catalogNode(schema, 'public', { level: 'schema', database: 'orders', schema_oid: 2200 }, null, schema_ref)],
        },
        [childrenKey('orders-dev', schema)]: {
          status: 'loaded',
          path: { level: 'schema', database: 'orders', schema_oid: 2200 },
          nodes: [catalogNode(`${schema}/Table`, 'Tables', folder('table'), '0'), catalogNode(`${schema}/View`, 'Views', folder('view'), '1')],
        },
        [childrenKey('orders-dev', `${schema}/View`)]: {
          status: 'loaded',
          path: folder('view'),
          nodes: [catalogNode(`${db}/rel:16400`, 'open_orders', null, null, view_ref)],
        },
      },
    });
  }

  function spyOnOpen() {
    const open = vi.fn((_request: EditorRequest) => 'editor-a');
    useObjectEditorStore.setState({ open });
    return open;
  }

  it('names the shortcuts each row answers to: F2 and Delete on an object, Insert where something can be created', () => {
    objectTree();
    renderWithUser(<ServerTree />);

    const shortcuts = [/^orders$/, /^public/, /^Tables/, /^Views/, /^open_orders/].map((label) => item(label).getAttribute('aria-keyshortcuts'));

    expect(shortcuts).toEqual(['Insert', 'F2 Delete', null, 'Insert', 'F2 Delete']);
    expect(screen.queryByRole('button', { name: /Edit|New/ })).toBeNull();
  });

  it('opens the editor with F2, a new object in the folder schema with Insert, and a drop with Delete', () => {
    objectTree();
    const open = spyOnOpen();
    renderWithUser(<ServerTree />);
    const press = (label: RegExp, key: string) => {
      act(() => useTreeStore.setState({ active_id: item(label).id.slice('tree-row-'.length) }));
      fireEvent.keyDown(tree(), { key });
    };

    press(/^open_orders/, 'F2');
    press(/^Views/, 'Insert');
    press(/^open_orders/, 'Backspace');
    press(/^orders$/, 'Insert');
    press(/^Tables/, 'Insert');
    press(/^Tables/, 'F2');
    press(/^Tables/, 'Delete');

    expect(open.mock.calls.map(([request]) => [request.mode, request.object_type, request.schema])).toEqual([
      ['edit', 'view', null],
      ['create', 'view', 'public'],
      ['drop', 'view', null],
      ['create', 'schema', null],
    ]);
    expect(open.mock.calls[0]?.[0]).toMatchObject({ server_id: 'orders-dev', database: 'orders', object: view_ref, label: 'open_orders' });
  });

  it('opens editors from the pencil and +, selecting their row first', async () => {
    objectTree();
    const open = spyOnOpen();
    const { user } = renderWithUser(<ServerTree />);

    await user.click(item(/^open_orders/).querySelector('[title="Edit (F2)"]') as HTMLElement);
    expect(active()).toBe(`tree-row-${nodeRowId('orders-dev', 'db:orders/rel:16400')}`);
    await user.click(item(/^Views/).querySelector('[title="New view (Insert)"]') as HTMLElement);

    expect(open.mock.calls.map(([request]) => request.mode)).toEqual(['edit', 'create']);
    expect(active()).toBe(`tree-row-${nodeRowId('orders-dev', 'db:orders/schema:2200/View')}`);
    expect(item(/^Tables/).querySelector('[title]')).toBeNull();
  });
});
