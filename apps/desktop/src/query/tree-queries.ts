import * as objects from '../api/objects';
import { messageOf } from '../api/errors';
import type { ObjectRef, ObjectType } from '../generated/objects';
import { planStatements, sqlName } from '../objects/describe';
import type { TreeRow } from '../servers/tree-rows';
import { useQueryTabStore } from '../store/query-tabs';
import { useTreeStore } from '../store/tree';
import { insertIntoEditor } from './sql-editor';

type Target = { server_id: string; object: ObjectRef; name: string };

/** The kinds that live in a schema, and so are named with it. */
const in_schema: ReadonlyArray<ObjectType> = ['table', 'view', 'materialized_view', 'sequence', 'function', 'procedure', 'type'];
const queryable: ReadonlyArray<ObjectType> = ['table', 'view', 'materialized_view'];

/** The row's object and its name as SQL spells it, schema first for what lives in a schema; `null` for other rows. */
export function sqlTarget(row: TreeRow, rows: ReadonlyArray<TreeRow>): Target | null {
  const item = row.item;
  if (item.type !== 'node' || !item.node.object) return null;
  const object = item.node.object;
  const name = sqlName(item.node.label.replace(/\(.*$/, ''));
  if (!in_schema.includes(object.object_type)) return { server_id: item.server_id, object, name };
  const folder = rows.find((candidate) => candidate.id === row.parent_id) as TreeRow;
  const schema = rows.find((candidate) => candidate.id === folder.parent_id) as TreeRow;
  return { server_id: item.server_id, object, name: `${sqlName(schema.label)}.${name}` };
}

/** Whether the row is a table, view or materialized view, whose rows can be selected and counted. */
export function isQueryable(target: Target | null): target is Target {
  return target !== null && queryable.includes(target.object.object_type);
}

function runInNewTab(target: Target, text: string): void {
  const tabs = useQueryTabStore.getState();
  const id = tabs.openTab({ server_id: target.server_id, database: target.object.database }, { text });
  void useQueryTabStore.getState().run(id, 'all');
}

export function selectTopRows(target: Target): void {
  runInNewTab(target, `SELECT *\nFROM ${target.name}\nLIMIT 100`);
}

export function countRows(target: Target): void {
  runInNewTab(target, `SELECT count(*)\nFROM ${target.name}`);
}

/** Puts the name at the cursor of the active query tab, or in a new tab on the object's database when none is open. */
export function insertName(target: Target): void {
  const tabs = useQueryTabStore.getState();
  if (tabs.active_id && tabs.tabs[tabs.active_id] && insertIntoEditor(tabs.active_id, target.name)) return;
  tabs.openTab({ server_id: target.server_id, database: target.object.database }, { text: target.name, selection: { from: target.name.length, to: target.name.length } });
}

/** Opens a tab with the statements that would create the object as it is now. Nothing runs. */
export async function scriptCreate(target: Target): Promise<void> {
  const { server_id, object } = target;
  try {
    const definition = await objects.objectDefinition(server_id, object);
    const plan = await objects.planObjectChange(server_id, object.database, null, null, definition, { cascade: false, with_data: true, force: false }, null);
    const text = `${planStatements(plan).map((statement) => `${statement};`).join('\n\n')}\n`;
    useQueryTabStore.getState().openTab({ server_id, database: object.database }, { text });
  } catch (error) {
    useTreeStore.setState({ announcement: `The CREATE statement couldn't be written: ${messageOf(error)}` });
  }
}
