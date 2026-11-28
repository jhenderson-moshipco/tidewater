import { describe, expect, it } from 'vitest';
import type { TreeRow } from '../servers/tree-rows';
import { useQueryTabStore } from '../store/query-tabs';
import { useTreeStore } from '../store/tree';
import { catalogNode, changePlan, commandsOf, failWith, mockCommands, objectRef, viewDefinition } from '../testing/backend';
import { countRows, insertName, isQueryable, scriptCreate, selectTopRows, sqlTarget } from './tree-queries';

const tabs = () => useQueryTabStore.getState();

function row(id: string, label: string, parent_id: string | null, object: ReturnType<typeof objectRef> | null = null): TreeRow {
  return {
    id,
    parent_id,
    level: 1,
    setsize: 1,
    posinset: 1,
    label,
    expandable: false,
    expanded: false,
    chevron_slot: false,
    item: { type: 'node', server_id: 'orders-dev', node: catalogNode(id, label, null, null, object) },
  };
}

const ancestors = [row('schema', 'Sales Data', null), row('folder', 'Views', 'schema')];

describe('naming a tree row in SQL', () => {
  it('names objects in a schema with it, quoting what needs quotes, and a routine without its arguments', () => {
    const view = sqlTarget(row('v', 'open_orders', 'folder', objectRef()), ancestors);
    const routine = sqlTarget(row('f', 'Total(a integer)', 'folder', objectRef({ object_type: 'function' })), ancestors);
    const schema = sqlTarget(row('s', 'sales', null, objectRef({ object_type: 'schema' })), []);

    expect([view?.name, routine?.name, schema?.name]).toEqual(['"Sales Data".open_orders', '"Sales Data"."Total"', 'sales']);
    expect([isQueryable(view), isQueryable(routine), isQueryable(null)]).toEqual([true, false, false]);
    expect(sqlTarget(row('c', 'id', 'v'), ancestors)).toBeNull();
    expect(sqlTarget({ ...row('x', 'x', null), item: { type: 'loading' } }, [])).toBeNull();
  });
});

describe('querying from the tree', () => {
  const target = { server_id: 'orders-dev', object: objectRef(), name: 'public.open_orders' };

  it('selects the top 100 rows or counts them in a new tab on the object’s database, and runs it', async () => {
    const calls = mockCommands({ run_query: () => ({ statements: [], transaction: 'idle', session_replaced: false }) });

    selectTopRows(target);
    countRows(target);

    await waitForRuns(calls, 2);
    expect(tabs().order.map((id) => tabs().tabs[id]?.text)).toEqual(['SELECT *\nFROM public.open_orders\nLIMIT 100', 'SELECT count(*)\nFROM public.open_orders']);
    expect(calls.map((call) => (call.args as { database: string }).database)).toEqual(['orders', 'orders']);
  });

  it('puts the name in a new tab when no query tab is showing', () => {
    const behind = tabs().openTab(null);
    insertName(target);
    expect(tabs().order).toHaveLength(2);
    expect(tabs().tabs[behind]?.text).toBe('');

    const tab = tabs().tabs[tabs().active_id as string];
    expect([tab?.text, tab?.selection, tab?.connection]).toEqual(['public.open_orders', { from: 18, to: 18 }, { server_id: 'orders-dev', database: 'orders' }]);
  });

  it('writes the CREATE statement for the object into a new tab without running it, or says why it could not', async () => {
    const calls = mockCommands({ object_definition: () => viewDefinition(), plan_object_change: () => changePlan({ statements: ['CREATE VIEW v AS SELECT 1'], after_commit: ['COMMENT'] }) });
    await scriptCreate(target);
    expect(tabs().tabs[tabs().active_id as string]?.text).toBe('CREATE VIEW v AS SELECT 1;\n\nCOMMENT;\n');
    expect(commandsOf(calls)).toEqual(['object_definition', 'plan_object_change']);

    mockCommands({ object_definition: () => failWith('not_found', 'This object no longer exists.') });
    await scriptCreate(target);
    expect(useTreeStore.getState().announcement).toBe("The CREATE statement couldn't be written: This object no longer exists.");
  });
});

async function waitForRuns(calls: ReadonlyArray<{ command: string }>, count: number): Promise<void> {
  const { vi } = await import('vitest');
  await vi.waitFor(() => expect(calls.filter((call) => call.command === 'run_query')).toHaveLength(count));
}
