import { invoke } from '@tauri-apps/api/core';
import type {
  ApplyOutcome,
  AvailableExtension,
  ChangeOptions,
  ChangePlan,
  ExtrasChange,
  ExtrasRead,
  ObjectDefinition,
  ObjectRef,
  ObjectType,
} from '../generated/objects';

export const listSchemas = (server_id: string, database: string) => invoke<Array<string>>('list_schemas', { server_id, database });
export const availableExtensions = (server_id: string, database: string) =>
  invoke<Array<AvailableExtension>>('available_extensions', { server_id, database });
export const listRoles = (server_id: string, database: string) => invoke<Array<string>>('list_roles', { server_id, database });
export const listTriggerFunctions = (server_id: string, database: string) => invoke<Array<string>>('list_trigger_functions', { server_id, database });
/** An object's grants, owner and triggers; with no object, what a new one of `object_type` starts with. */
export const objectExtras = (server_id: string, database: string, object: ObjectRef | null, object_type: ObjectType) =>
  invoke<ExtrasRead>('object_extras', { server_id, database, object, object_type });
export const objectDefinition = (server_id: string, object: ObjectRef) => invoke<ObjectDefinition>('object_definition', { server_id, object });

/** The DDL for a change: a create when `original` is null, a drop when `changed` is null. */
export const planObjectChange = (
  server_id: string,
  database: string,
  object: ObjectRef | null,
  original: ObjectDefinition | null,
  changed: ObjectDefinition | null,
  options: ChangeOptions,
  extras: ExtrasChange | null,
) => invoke<ChangePlan>('plan_object_change', { server_id, database, object, original, changed, options, extras });

/**
 * Runs `statements` in one transaction, then each of `after_commit` on its own once it commits. Tidewater's own
 * sessions on `closes_database` close first, as a database can't be dropped or renamed while they are open.
 */
export const applyObjectChange = (
  server_id: string,
  database: string,
  plan: Pick<ChangePlan, 'statements' | 'after_commit' | 'closes_database'>,
) =>
  invoke<ApplyOutcome>('apply_object_change', {
    server_id,
    database,
    statements: plan.statements,
    after_commit: plan.after_commit,
    closes_database: plan.closes_database,
  });
