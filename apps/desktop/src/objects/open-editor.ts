import type { ObjectRef, ObjectType } from '../generated/objects';
import type { TreeRow } from '../servers/tree-rows';
import { useObjectEditorStore } from '../store/object-editors';
import type { EditorHost } from '../store/workspace';
import { creatableType } from './describe';

type Editable = { server_id: string; object: ObjectRef; label: string };
type Creatable = { server_id: string; database: string; object_type: ObjectType; schema: string | null };

/** The object a tree row stands for, when an editor covers its kind. */
export function editableObject(row: TreeRow): Editable | null {
  const item = row.item;
  if (item.type !== 'node' || !item.node.object) return null;
  return { server_id: item.server_id, object: item.node.object, label: item.node.label };
}

/** What a tree row's + creates: a schema on a database row, or an object of a folder's kind in its schema. */
export function creatableObject(row: TreeRow, rows: ReadonlyArray<TreeRow>): Creatable | null {
  const item = row.item;
  if (item.type !== 'node') return null;
  const path = item.node.children;
  if (path?.level === 'database') return { server_id: item.server_id, database: path.database, object_type: 'schema', schema: null };
  if (path?.level !== 'folder') return null;
  const object_type = creatableType(path.kind);
  if (!object_type) return null;
  const schema = (rows.find((candidate) => candidate.id === row.parent_id) as TreeRow).label;
  return { server_id: item.server_id, database: path.database, object_type, schema };
}

/** Opens the row's object in its editor; `false` when the row has none. */
export function editRow(row: TreeRow, host?: EditorHost): boolean {
  const target = editableObject(row);
  if (!target) return false;
  const { server_id, object, label } = target;
  useObjectEditorStore.getState().open({ mode: 'edit', host, server_id, database: object.database, object_type: object.object_type, object, schema: null, label });
  return true;
}

/** Opens an editor for a new object of the kind the row's + creates; `false` when it creates none. */
export function createFromRow(row: TreeRow, rows: ReadonlyArray<TreeRow>, host?: EditorHost): boolean {
  const target = creatableObject(row, rows);
  if (!target) return false;
  useObjectEditorStore.getState().open({ mode: 'create', host, ...target, object: null, label: '' });
  return true;
}

/** Asks to drop the row's object, listing what depends on it; `false` when the row has no object an editor covers. */
export function dropRow(row: TreeRow): boolean {
  const target = editableObject(row);
  if (!target) return false;
  const { server_id, object, label } = target;
  useObjectEditorStore.getState().open({ mode: 'drop', server_id, database: object.database, object_type: object.object_type, object, schema: null, label });
  return true;
}
