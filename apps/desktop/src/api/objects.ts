import { invoke } from '@tauri-apps/api/core';
import type { ApplyOutcome, ChangeOptions, ChangePlan, ObjectDefinition, ObjectRef } from '../generated/objects';

export const listSchemas = (server_id: string, database: string) => invoke<Array<string>>('list_schemas', { server_id, database });
export const objectDefinition = (server_id: string, object: ObjectRef) => invoke<ObjectDefinition>('object_definition', { server_id, object });

/** The DDL for a change: a create when `original` is null, a drop when `changed` is null. */
export const planObjectChange = (
  server_id: string,
  database: string,
  object: ObjectRef | null,
  original: ObjectDefinition | null,
  changed: ObjectDefinition | null,
  options: ChangeOptions,
) => invoke<ChangePlan>('plan_object_change', { server_id, database, object, original, changed, options });

/** Runs `statements` in one transaction, then each of `after_commit` on its own once it commits. */
export const applyObjectChange = (server_id: string, database: string, statements: ReadonlyArray<string>, after_commit: ReadonlyArray<string>) =>
  invoke<ApplyOutcome>('apply_object_change', { server_id, database, statements, after_commit });
