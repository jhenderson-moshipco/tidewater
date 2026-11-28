import type { ObjectKind } from '../generated/catalog';
import type { ColumnDefinition, ObjectDefinition, ObjectType } from '../generated/objects';

export const type_labels: Readonly<Record<ObjectType, string>> = {
  database: 'database',
  extension: 'extension',
  schema: 'schema',
  table: 'table',
  type: 'type',
  sequence: 'sequence',
  view: 'view',
  materialized_view: 'materialized view',
  function: 'function',
  procedure: 'procedure',
};

/** The type each tree folder's + creates. */
const creatable: Readonly<Record<ObjectKind, ObjectType>> = {
  table: 'table',
  type: 'type',
  view: 'view',
  materialized_view: 'materialized_view',
  function: 'function',
  procedure: 'procedure',
  sequence: 'sequence',
};

export function creatableType(kind: ObjectKind): ObjectType {
  return creatable[kind];
}

export function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function objectTypeOf(definition: ObjectDefinition): ObjectType {
  if (definition.type === 'routine') return definition.procedure ? 'procedure' : 'function';
  return definition.type;
}

/** The object's name as SQL names it, schema first, with a routine's argument types. */
export function qualifiedName(definition: ObjectDefinition): string {
  if (definition.type === 'schema' || definition.type === 'database' || definition.type === 'extension') return definition.name;
  const name = `${definition.schema}.${definition.name}`;
  return definition.type === 'routine' ? `${name}(${definition.identity_arguments})` : name;
}

export function blankColumn(): ColumnDefinition {
  return { number: null, name: '', data_type: '', not_null: false, default: '', identity: 'none', generated: '', using: '', comment: null };
}

/** Every statement a plan runs: those in its transaction, then those after the commit. */
export function planStatements(plan: { statements: ReadonlyArray<string>; after_commit: ReadonlyArray<string> }): Array<string> {
  return [...plan.statements, ...plan.after_commit];
}

/** What a new object's editor starts with. */
export function blankDefinition(type: ObjectType, schema: string): ObjectDefinition {
  switch (type) {
    case 'schema':
      return { type: 'schema', name: '', comment: null };
    case 'database':
      return { type: 'database', name: '', owner: '', encoding: '', template: '', collation: '', ctype: '', connection_limit: -1, comment: null };
    case 'extension':
      return { type: 'extension', name: '', schema: '', version: '', comment: null };
    case 'type':
      return {
        type: 'type',
        schema,
        name: '',
        comment: null,
        kind: 'enum',
        values: [],
        attributes: [],
        base_type: '',
        default: '',
        not_null: false,
        checks: [],
      };
    case 'table':
      return {
        type: 'table',
        schema,
        name: '',
        comment: null,
        partition_key: null,
        columns: [blankColumn()],
        constraints: [],
        indexes: [],
        row_security: false,
        force_row_security: false,
        policies: [],
      };
    case 'sequence':
      return {
        type: 'sequence',
        schema,
        name: '',
        data_type: 'bigint',
        increment: '1',
        min_value: '',
        max_value: '',
        start: '1',
        cache: '1',
        cycle: false,
        comment: null,
      };
    case 'view':
    case 'materialized_view':
      return { type, schema, name: '', query: '', comment: null };
    case 'function':
    case 'procedure': {
      const procedure = type === 'procedure';
      return {
        type: 'routine',
        procedure,
        schema,
        name: '',
        arguments: '',
        identity_arguments: '',
        returns: procedure ? '' : 'void',
        language: 'plpgsql',
        volatility: 'volatile',
        security_definer: false,
        parallel: 'unsafe',
        body: 'BEGIN\n\nEND',
        comment: null,
      };
    }
  }
}

/** A name as SQL spells it, quoted unless it is plain lowercase. */
export function sqlName(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}
