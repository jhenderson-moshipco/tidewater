//! Reads, plans and applies changes to schema objects. The DDL itself is written in `ddl`.

pub mod databases;
pub mod ddl;
pub mod model;
pub mod table;
pub mod types;

use serde::Serialize;
use tokio_postgres::Client;
use ts_rs::TS;

use crate::connections::{ConnectParams, describe, open};
use crate::error::CommandError;
use model::{
    ApplyFailure, AvailableExtension, ChangeOptions, ChangePlan, ColumnDefinition, ConstraintDefinition, ConstraintKind, DatabaseDefinition, DomainCheck, EnumValue,
    ExtensionDefinition, Identity, IndexDefinition, ObjectDefinition, ObjectRef, ObjectType, Parallel, ReferentialAction, TableDefinition, TypeAttribute,
    TypeDefinition, TypeKind, Volatility,
};

const SCHEMA_NAMES: &str = "\
SELECT nspname FROM pg_namespace
WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
ORDER BY nspname";
const SCHEMA: &str = "SELECT nspname, obj_description(oid, 'pg_namespace') FROM pg_namespace WHERE oid = $1";
const SEQUENCE: &str = "\
SELECT n.nspname, c.relname, format_type(s.seqtypid, NULL), s.seqincrement::text, s.seqmin::text, s.seqmax::text,
  s.seqstart::text, s.seqcache::text, s.seqcycle, obj_description(c.oid, 'pg_class')
FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE s.seqrelid = $1";
const VIEW: &str = "\
SELECT n.nspname, c.relname, pg_get_viewdef(c.oid, true), obj_description(c.oid, 'pg_class')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid = $1 AND c.relkind = ANY($2)";
const ROUTINE: &str = "\
SELECT p.prokind = 'p', n.nspname, p.proname, pg_get_function_arguments(p.oid), pg_get_function_identity_arguments(p.oid),
  coalesce(pg_get_function_result(p.oid), ''), l.lanname, p.provolatile::text, p.prosecdef, p.proparallel::text, p.prosrc,
  obj_description(p.oid, 'pg_proc')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
WHERE p.oid = $1 AND p.prokind = ANY($2)";
const VIEW_COLUMNS: &str = "SELECT attname, atttypid FROM pg_attribute WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum";
/// What depends on what a plan drops: the object itself when `$3`, the table columns numbered in `$4`, and the table
/// constraints named in `$5`, such as another table's foreign key on a unique index. A dependent view is named, rather
/// than the internal rule that holds its query, and a table's own indexes and constraints, which go with it, are left out.
const DEPENDENTS: &str = "\
SELECT DISTINCT coalesce(
  (SELECT CASE c.relkind WHEN 'm' THEN 'materialized view ' ELSE 'view ' END || c.oid::regclass::text
   FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE d.classid = 'pg_rewrite'::regclass AND r.oid = d.objid),
  pg_describe_object(d.classid, d.objid, d.objsubid))
FROM pg_depend d
WHERE ($3 AND d.refclassid = $1::text::regclass AND d.refobjid = $2 AND d.deptype IN ('n', 'a'))
  OR (d.deptype = 'n' AND d.refclassid = 'pg_class'::regclass AND d.refobjid = $2 AND d.refobjsubid = ANY($4::smallint[]))
  OR (d.deptype = 'n' AND d.refclassid = 'pg_constraint'::regclass
      AND d.refobjid IN (SELECT oid FROM pg_constraint WHERE conrelid = $2 AND conname = ANY($5::text[])))
  OR (d.deptype = 'n' AND d.refclassid = 'pg_class'::regclass
      AND d.refobjid IN (SELECT conindid FROM pg_constraint WHERE conrelid = $2 AND conname = ANY($5::text[])))
ORDER BY 1";
/// A table with its columns, constraints and indexes, each list as a JSON array of rows. Not-null constraints are left
/// out since columns carry them, and so are indexes a primary key, unique or exclusion constraint owns.
const TABLE: &str = "\
SELECT n.nspname, c.relname, obj_description(c.oid, 'pg_class'), CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
  (SELECT coalesce(json_agg(json_build_array(
      a.attnum, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
      CASE WHEN a.attgenerated = '' THEN coalesce(pg_get_expr(d.adbin, d.adrelid), '') ELSE '' END,
      a.attidentity::text,
      CASE WHEN a.attgenerated = '' THEN '' ELSE coalesce(pg_get_expr(d.adbin, d.adrelid), '') END,
      col_description(a.attrelid, a.attnum)) ORDER BY a.attnum), '[]')::text
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
  (SELECT coalesce(json_agg(json_build_array(
      k.conname, k.contype::text,
      ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, i)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.i),
      CASE WHEN k.contype = 'f' THEN k.confrelid::regclass::text ELSE '' END,
      ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n, i)
            JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.i),
      k.confupdtype::text, k.confdeltype::text,
      CASE WHEN k.contype = 'c' THEN pg_get_expr(k.conbin, k.conrelid) ELSE '' END,
      pg_get_constraintdef(k.oid), NOT k.convalidated)
    ORDER BY CASE k.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 WHEN 'c' THEN 3 ELSE 4 END, k.conname), '[]')::text
   FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype <> 'n' AND k.conislocal),
  (SELECT coalesce(json_agg(json_build_array(ic.relname, i.indisunique, am.amname, pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname), '[]')::text
   FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
   WHERE i.indrelid = c.oid AND NOT EXISTS (SELECT 1 FROM pg_constraint k
     WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid AND k.contype IN ('p', 'u', 'x')))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid = $1 AND c.relkind IN ('r', 'p')";

/// An enum, composite, domain or range, with its values, attributes and checks as JSON arrays.
const TYPE: &str = "\
SELECT n.nspname, t.typname, obj_description(t.oid, 'pg_type'), t.typtype::text,
  (SELECT coalesce(json_agg(e.enumlabel ORDER BY e.enumsortorder), '[]') FROM pg_enum e WHERE e.enumtypid = t.oid)::text,
  (SELECT coalesce(json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum), '[]')
   FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped)::text,
  CASE t.typtype
    WHEN 'd' THEN format_type(t.typbasetype, t.typtypmod)
    WHEN 'r' THEN (SELECT format_type(r.rngsubtype, NULL) FROM pg_range r WHERE r.rngtypid = t.oid)
    ELSE '' END,
  coalesce(t.typdefault, ''), t.typnotnull,
  (SELECT coalesce(json_agg(json_build_array(c.conname, pg_get_expr(c.conbin, 0)) ORDER BY c.conname), '[]')
   FROM pg_constraint c WHERE c.contypid = t.oid AND c.contype = 'c')::text
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.oid = $1 AND t.typtype IN ('e', 'c', 'd', 'r')";
const EXTENSION: &str = "\
SELECT e.extname, n.nspname, e.extversion, obj_description(e.oid, 'pg_extension')
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.oid = $1";
const DATABASE: &str = "\
SELECT datname, pg_get_userbyid(datdba), pg_encoding_to_char(encoding), datcollate, datctype, datconnlimit, shobj_description(oid, 'pg_database')
FROM pg_database WHERE oid = $1";
const AVAILABLE_EXTENSIONS: &str = "\
SELECT a.name, coalesce(a.default_version, ''),
  ARRAY(SELECT v.version FROM pg_available_extension_versions v WHERE v.name = a.name ORDER BY v.version),
  a.installed_version IS NOT NULL, a.comment
FROM pg_available_extensions a ORDER BY a.name";
const ROLES: &str = "SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname";
/// Sessions on a database besides Tidewater's own, which Tidewater closes itself.
const OTHER_SESSIONS: &str = "SELECT count(*) FROM pg_stat_activity WHERE datname = $1 AND application_name <> 'Tidewater'";

/// The extensions this server can install, for picking one to create or a version to move to.
pub async fn available_extensions(client: &Client) -> Result<Vec<AvailableExtension>, CommandError> {
    let rows = client.query(AVAILABLE_EXTENSIONS, &[]).await?;
    Ok(rows
        .iter()
        .map(|row| AvailableExtension { name: row.get(0), default_version: row.get(1), versions: row.get(2), installed: row.get(3), comment: row.get(4) })
        .collect())
}

/// The server's roles, leaving out its built-in `pg_` ones, for choosing an owner.
pub async fn role_names(client: &Client) -> Result<Vec<String>, CommandError> {
    let rows = client.query(ROLES, &[]).await?;
    Ok(rows.iter().map(|row| row.get(0)).collect())
}

/// The user's schemas in this database, for choosing where an object goes.
pub async fn schema_names(client: &Client) -> Result<Vec<String>, CommandError> {
    let rows = client.query(SCHEMA_NAMES, &[]).await?;
    Ok(rows.iter().map(|row| row.get(0)).collect())
}

fn volatility(code: &str) -> Volatility {
    match code {
        "i" => Volatility::Immutable,
        "s" => Volatility::Stable,
        _ => Volatility::Volatile,
    }
}

fn parallel(code: &str) -> Parallel {
    match code {
        "s" => Parallel::Safe,
        "r" => Parallel::Restricted,
        _ => Parallel::Unsafe,
    }
}

fn identity(code: &str) -> Identity {
    match code {
        "a" => Identity::Always,
        "d" => Identity::ByDefault,
        _ => Identity::None,
    }
}

fn referential(code: &str) -> ReferentialAction {
    match code {
        "r" => ReferentialAction::Restrict,
        "c" => ReferentialAction::Cascade,
        "n" => ReferentialAction::SetNull,
        "d" => ReferentialAction::SetDefault,
        _ => ReferentialAction::NoAction,
    }
}

/// A constraint's kind, or `Other` for a kind the designer doesn't build or one with options its fields can't hold.
fn constraint_kind(code: &str, definition: &str) -> ConstraintKind {
    const UNBUILT: [&str; 5] = [" DEFERRABLE", " INCLUDE ", "NULLS NOT DISTINCT", " MATCH ", "NO INHERIT"];
    if UNBUILT.iter().any(|option| definition.contains(option)) {
        return ConstraintKind::Other;
    }
    match code {
        "p" => ConstraintKind::PrimaryKey,
        "u" => ConstraintKind::Unique,
        "f" => ConstraintKind::ForeignKey,
        "c" => ConstraintKind::Check,
        _ => ConstraintKind::Other,
    }
}

/// Splits an index definition from `pg_get_indexdef` into the keys between the parentheses after `USING method` and
/// the clauses after them.
fn index_parts(definition: &str, method: &str) -> (String, String) {
    let marker = format!(" USING {method} (");
    let Some(start) = definition.find(&marker).map(|found| found + marker.len()) else { return (String::new(), String::new()) };
    let (mut depth, mut quoted) = (1, false);
    for (offset, character) in definition[start..].char_indices() {
        match character {
            '\'' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => depth -= 1,
            _ => {}
        }
        if depth == 0 {
            let end = start + offset;
            return (definition[start..end].to_string(), definition[end + 1..].trim().to_string());
        }
    }
    (definition[start..].to_string(), String::new())
}

type ColumnRow = (i16, String, String, bool, String, String, String, Option<String>);
type ConstraintRow = (String, String, Vec<String>, String, Vec<String>, String, String, String, String, bool);
type IndexRow = (String, bool, String, String);

/// Rows that `TABLE` builds as JSON, which always parse.
fn json_rows<T: serde::de::DeserializeOwned>(text: &str) -> Vec<T> {
    serde_json::from_str(text).expect("the catalog query builds this JSON")
}

fn column(row: ColumnRow) -> ColumnDefinition {
    let (number, name, data_type, not_null, default, identity_code, generated, comment) = row;
    ColumnDefinition { number: Some(number), name, data_type, not_null, default, identity: identity(&identity_code), generated, using: String::new(), comment }
}

fn constraint(row: ConstraintRow) -> ConstraintDefinition {
    let (name, code, columns, references, referenced_columns, on_update, on_delete, check, definition, not_valid) = row;
    let kind = constraint_kind(&code, &definition);
    let expression = if kind == ConstraintKind::Other { definition } else { check };
    ConstraintDefinition {
        original_name: Some(name.clone()),
        name,
        kind,
        columns,
        references,
        referenced_columns,
        on_update: referential(&on_update),
        on_delete: referential(&on_delete),
        expression,
        not_valid,
    }
}

fn index(row: IndexRow) -> IndexDefinition {
    let (name, unique, method, definition) = row;
    let (keys, clauses) = index_parts(&definition, &method);
    IndexDefinition { original_name: Some(name.clone()), name, unique, method, keys, clauses, concurrently: false }
}

fn type_kind(code: &str) -> TypeKind {
    match code {
        "e" => TypeKind::Enum,
        "c" => TypeKind::Composite,
        "d" => TypeKind::Domain,
        _ => TypeKind::Range,
    }
}

async fn type_definition(client: &Client, oid: u32) -> Result<ObjectDefinition, CommandError> {
    let row = client.query_opt(TYPE, &[&oid]).await?.ok_or_else(gone)?;
    let labels: Vec<String> = json_rows(row.get(4));
    let attributes: Vec<(String, String)> = json_rows(row.get(5));
    let checks: Vec<(String, String)> = json_rows(row.get(9));
    Ok(ObjectDefinition::Type(TypeDefinition {
        schema: row.get(0),
        name: row.get(1),
        comment: row.get(2),
        kind: type_kind(row.get(3)),
        values: labels.into_iter().map(|label| EnumValue { original: Some(label.clone()), label }).collect(),
        attributes: attributes.into_iter().map(|(name, data_type)| TypeAttribute { original_name: Some(name.clone()), name, data_type }).collect(),
        base_type: row.get(6),
        default: row.get(7),
        not_null: row.get(8),
        checks: checks.into_iter().map(|(name, expression)| DomainCheck { original_name: Some(name.clone()), name, expression }).collect(),
    }))
}

async fn table_definition(client: &Client, oid: u32) -> Result<ObjectDefinition, CommandError> {
    let row = client.query_opt(TABLE, &[&oid]).await?.ok_or_else(gone)?;
    Ok(ObjectDefinition::Table(TableDefinition {
        schema: row.get(0),
        name: row.get(1),
        comment: row.get(2),
        partition_key: row.get(3),
        columns: json_rows(row.get(4)).into_iter().map(column).collect(),
        constraints: json_rows(row.get(5)).into_iter().map(constraint).collect(),
        indexes: json_rows(row.get(6)).into_iter().map(index).collect(),
    }))
}

fn char_codes(codes: &[u8]) -> Vec<i8> {
    codes.iter().map(|code| *code as i8).collect()
}

fn gone() -> CommandError {
    CommandError::NotFound("This object no longer exists. Refresh the tree to see what's there now.".into())
}

/// The object's current definition, read from the catalog.
pub async fn definition(client: &Client, object: &ObjectRef) -> Result<ObjectDefinition, CommandError> {
    let oid = object.oid;
    match object.object_type {
        ObjectType::Table => table_definition(client, oid).await,
        ObjectType::Type => type_definition(client, oid).await,
        ObjectType::Extension => {
            let row = client.query_opt(EXTENSION, &[&oid]).await?.ok_or_else(gone)?;
            Ok(ObjectDefinition::Extension(ExtensionDefinition { name: row.get(0), schema: row.get(1), version: row.get(2), comment: row.get(3) }))
        }
        ObjectType::Database => {
            let row = client.query_opt(DATABASE, &[&oid]).await?.ok_or_else(gone)?;
            Ok(ObjectDefinition::Database(DatabaseDefinition {
                name: row.get(0),
                owner: row.get(1),
                encoding: row.get(2),
                template: String::new(),
                collation: row.get(3),
                ctype: row.get(4),
                connection_limit: row.get(5),
                comment: row.get(6),
            }))
        }
        ObjectType::Schema => {
            let row = client.query_opt(SCHEMA, &[&oid]).await?.ok_or_else(gone)?;
            Ok(ObjectDefinition::Schema { name: row.get(0), comment: row.get(1) })
        }
        ObjectType::Sequence => {
            let row = client.query_opt(SEQUENCE, &[&oid]).await?.ok_or_else(gone)?;
            Ok(ObjectDefinition::Sequence {
                schema: row.get(0),
                name: row.get(1),
                data_type: row.get(2),
                increment: row.get(3),
                min_value: row.get(4),
                max_value: row.get(5),
                start: row.get(6),
                cache: row.get(7),
                cycle: row.get(8),
                comment: row.get(9),
            })
        }
        ObjectType::View | ObjectType::MaterializedView => {
            let materialized = object.object_type == ObjectType::MaterializedView;
            let kinds = char_codes(if materialized { b"m" } else { b"v" });
            let row = client.query_opt(VIEW, &[&oid, &kinds]).await?.ok_or_else(gone)?;
            let query = row.get::<_, String>(2).trim().trim_end_matches(';').to_string();
            let (schema, name, comment) = (row.get(0), row.get(1), row.get(3));
            Ok(if materialized {
                ObjectDefinition::MaterializedView { schema, name, query, comment }
            } else {
                ObjectDefinition::View { schema, name, query, comment }
            })
        }
        ObjectType::Function | ObjectType::Procedure => {
            let kinds = char_codes(if object.object_type == ObjectType::Procedure { b"p" } else { b"fw" });
            let row = client.query_opt(ROUTINE, &[&oid, &kinds]).await?.ok_or_else(gone)?;
            Ok(ObjectDefinition::Routine {
                procedure: row.get(0),
                schema: row.get(1),
                name: row.get(2),
                arguments: row.get(3),
                identity_arguments: row.get(4),
                returns: row.get(5),
                language: row.get(6),
                volatility: volatility(row.get(7)),
                security_definer: row.get(8),
                parallel: parallel(row.get(9)),
                body: row.get(10),
                comment: row.get(11),
            })
        }
    }
}

/// Checks a view or materialized view query parses against this database, and says whether a view's new query keeps
/// the columns of the view at `oid`, so `CREATE OR REPLACE` can apply it.
async fn check_query(client: &Client, query: &str, view_oid: Option<u32>) -> Result<bool, CommandError> {
    let current = match view_oid {
        Some(oid) => Some(client.query(VIEW_COLUMNS, &[&oid]).await?),
        None => None,
    };
    let prepared = client.prepare(query).await.map_err(|error| CommandError::Invalid(describe(&error)))?;
    let Some(current) = current else { return Ok(true) };
    let columns = prepared.columns();
    Ok(columns.len() >= current.len()
        && current.iter().zip(columns).all(|(row, column)| row.get::<_, String>(0) == column.name() && row.get::<_, u32>(1) == column.type_().oid()))
}

fn catalog_of(object_type: ObjectType) -> &'static str {
    match object_type {
        ObjectType::Schema => "pg_namespace",
        ObjectType::Database => "pg_database",
        ObjectType::Extension => "pg_extension",
        ObjectType::Type => "pg_type",
        ObjectType::Table | ObjectType::Sequence | ObjectType::View | ObjectType::MaterializedView => "pg_class",
        ObjectType::Function | ObjectType::Procedure => "pg_proc",
    }
}

fn query_of(definition: Option<&ObjectDefinition>) -> Option<&str> {
    match definition {
        Some(ObjectDefinition::View { query, .. } | ObjectDefinition::MaterializedView { query, .. }) => Some(query),
        _ => None,
    }
}

/// The DDL that turns `original` into `changed`, checked against the database, with what depends on anything it drops.
pub async fn plan(
    client: &Client,
    object: Option<&ObjectRef>,
    original: Option<&ObjectDefinition>,
    changed: Option<&ObjectDefinition>,
    options: ChangeOptions,
) -> Result<ChangePlan, CommandError> {
    let mut view_replaceable = true;
    if let Some(query) = query_of(changed).filter(|query| !query.trim().is_empty() && query_of(original) != Some(query)) {
        let view_oid = object.filter(|object| object.object_type == ObjectType::View).map(|object| object.oid);
        view_replaceable = check_query(client, query, view_oid).await?;
    }
    let planned = ddl::plan(original, changed, options, view_replaceable)?;
    let mut dependents = Vec::new();
    let drops_something = planned.drops_original || !planned.dropped_columns.is_empty() || !planned.dropped_constraints.is_empty();
    if let Some(object) = object.filter(|_| drops_something) {
        let params: [&(dyn tokio_postgres::types::ToSql + Sync); 5] =
            [&catalog_of(object.object_type), &object.oid, &planned.drops_original, &planned.dropped_columns, &planned.dropped_constraints];
        dependents = client.query(DEPENDENTS, &params).await?.iter().map(|row| row.get(0)).collect();
    }
    let mut warnings = planned.warnings;
    if let Some(database) = &planned.closes_database {
        warnings.extend(session_warnings(client, database, changed.is_none()).await?);
    }
    Ok(ChangePlan { statements: planned.statements, warnings, dependents, after_commit: planned.after_commit, closes_database: planned.closes_database })
}

/// What dropping or renaming `database` does to the sessions on it: Tidewater's are closed, and any others make it fail.
async fn session_warnings(client: &Client, database: &str, dropping: bool) -> Result<Vec<model::ChangeWarning>, CommandError> {
    let others: i64 = client.query_one(OTHER_SESSIONS, &[&database]).await?.get(0);
    let mut warnings = vec![ddl::warning("Closes Tidewater's sessions on it", format!("Query tabs and the tree on {database} are disconnected first."))];
    if others > 0 {
        let sessions = if others == 1 { "1 other session is".to_string() } else { format!("{others} other sessions are") };
        let detail = if dropping {
            format!("{sessions} connected to {database}. Dropping it fails while they are, unless FORCE disconnects them.")
        } else {
            format!("{sessions} connected to {database}. Renaming it fails while they are.")
        };
        warnings.push(ddl::warning("Other sessions are connected", detail));
    }
    Ok(warnings)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export, export_to = "objects.ts")]
pub enum ApplyOutcome {
    Applied,
    /// Nothing was changed: the transaction rolled back at this statement.
    Failed { failure: ApplyFailure },
}

fn failure(error: &tokio_postgres::Error, statement_index: usize, committed: bool) -> ApplyOutcome {
    let database_error = error.as_db_error();
    ApplyOutcome::Failed {
        failure: ApplyFailure {
            statement_index: u32::try_from(statement_index).unwrap_or(u32::MAX),
            committed,
            message: database_error.map_or_else(|| describe(error), |database_error| database_error.message().to_string()),
            detail: database_error.and_then(|database_error| database_error.detail()).map(str::to_string),
            hint: database_error.and_then(|database_error| database_error.hint()).map(str::to_string),
        },
    }
}

/// Runs the statements in one transaction on a connection of their own, rolling all of them back if one fails. Once
/// it commits, each of `after_commit` runs on its own, stopping at the first that fails.
pub async fn apply(params: &ConnectParams, statements: &[String], after_commit: &[String]) -> Result<ApplyOutcome, CommandError> {
    let (client, driver) = open(params).await?;
    let steps = std::iter::once("BEGIN").chain(statements.iter().map(String::as_str)).chain(std::iter::once("COMMIT"));
    let mut outcome = ApplyOutcome::Applied;
    for (index, step) in steps.enumerate() {
        if let Err(error) = client.batch_execute(step).await {
            let _ = client.batch_execute("ROLLBACK").await;
            outcome = failure(&error, index.saturating_sub(1), false);
            break;
        }
    }
    if outcome == ApplyOutcome::Applied {
        for (index, statement) in after_commit.iter().enumerate() {
            if let Err(error) = client.batch_execute(statement).await {
                outcome = failure(&error, statements.len() + index, true);
                break;
            }
        }
    }
    driver.abort();
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{FakeServer, closed_port, fake_server, live_params};

    /// A client on the live server with a schema of its own, dropped when the test ends.
    struct Scratch {
        client: Client,
        driver: tauri::async_runtime::JoinHandle<()>,
        schema: String,
    }

    impl Scratch {
        async fn new(setup: &str) -> Scratch {
            let (client, driver) = open(&live_params()).await.unwrap();
            let schema = format!("tw_{}", uuid::Uuid::new_v4().simple());
            client.batch_execute(&format!("CREATE SCHEMA {schema}; SET search_path TO {schema}; {setup}")).await.unwrap();
            Scratch { client, driver, schema }
        }

        async fn oid(&self, sql: &str) -> u32 {
            self.client.query_one(&sql.replace("{schema}", &self.schema), &[]).await.unwrap().get(0)
        }

        fn object(&self, object_type: ObjectType, oid: u32) -> ObjectRef {
            ObjectRef { database: live_params().database, object_type, oid }
        }

        async fn read(&self, object_type: ObjectType, oid: u32) -> Result<ObjectDefinition, CommandError> {
            definition(&self.client, &self.object(object_type, oid)).await
        }

        async fn finish(self) {
            self.client.batch_execute(&format!("DROP SCHEMA {} CASCADE", self.schema)).await.unwrap();
            self.driver.abort();
        }
    }

    fn options() -> ChangeOptions {
        ChangeOptions { cascade: false, with_data: true, force: false }
    }

    #[test]
    fn identity_referential_and_constraint_codes_map_to_their_settings() {
        assert_eq!([identity("a"), identity("d"), identity("")], [Identity::Always, Identity::ByDefault, Identity::None]);
        assert_eq!(
            ["r", "c", "n", "d", "a"].map(referential),
            [ReferentialAction::Restrict, ReferentialAction::Cascade, ReferentialAction::SetNull, ReferentialAction::SetDefault, ReferentialAction::NoAction]
        );
        assert_eq!(
            [("p", "PRIMARY KEY (id)"), ("u", "UNIQUE (a)"), ("f", "FOREIGN KEY (a) REFERENCES t(id)"), ("c", "CHECK ((a > 0))"), ("x", "EXCLUDE")]
                .map(|(code, definition)| constraint_kind(code, definition)),
            [ConstraintKind::PrimaryKey, ConstraintKind::Unique, ConstraintKind::ForeignKey, ConstraintKind::Check, ConstraintKind::Other]
        );
        assert_eq!(constraint_kind("u", "UNIQUE (a) DEFERRABLE INITIALLY DEFERRED"), ConstraintKind::Other);
    }

    #[test]
    fn an_index_definition_splits_into_keys_and_the_clauses_after_them() {
        let parts = |definition: &str| index_parts(definition, "btree");
        assert_eq!(parts("CREATE INDEX i ON public.t USING btree (a, lower(b) DESC) INCLUDE (c) WHERE (a > 0)"), (
            "a, lower(b) DESC".to_string(),
            "INCLUDE (c) WHERE (a > 0)".to_string()
        ));
        assert_eq!(parts("CREATE INDEX i ON t USING btree (((note || ')'::text)))"), ("((note || ')'::text))".to_string(), String::new()));
        assert_eq!(parts("CREATE INDEX i ON t USING hash (a)"), (String::new(), String::new()));
        assert_eq!(parts("CREATE INDEX i ON t USING btree (a"), ("a".to_string(), String::new()));
    }

    #[test]
    fn volatility_and_parallel_codes_map_to_their_settings() {
        assert_eq!([volatility("i"), volatility("s"), volatility("v")], [Volatility::Immutable, Volatility::Stable, Volatility::Volatile]);
        assert_eq!([parallel("s"), parallel("r"), parallel("u")], [Parallel::Safe, Parallel::Restricted, Parallel::Unsafe]);
    }

    #[tokio::test]
    async fn a_change_that_cannot_connect_is_a_connection_error_and_a_hang_up_is_a_failed_statement() {
        let refused = apply(&closed_port().await, &["SELECT 1".into()], &[]).await;
        assert_eq!(refused.map_err(|error| crate::testing::parts(error).0), Err("connection".to_string()));

        let hung_up = apply(&fake_server(FakeServer::HangUpOnQuery).await, &["SELECT 1".into()], &[]).await.unwrap();
        let failure = &serde_json::to_value(&hung_up).unwrap()["failure"];
        assert_eq!((&failure["statement_index"], &failure["detail"], &failure["hint"]), (&serde_json::json!(0), &serde_json::Value::Null, &serde_json::Value::Null));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_each_kind_reads_back_its_definition_and_a_missing_one_is_not_found() {
        let scratch = Scratch::new(
            "CREATE SEQUENCE seq AS integer INCREMENT 5 MINVALUE 1 MAXVALUE 99 START 3 CACHE 2 CYCLE; COMMENT ON SEQUENCE seq IS 'numbers';
             CREATE VIEW v AS SELECT 1 AS n; CREATE MATERIALIZED VIEW m AS SELECT 2 AS n;
             CREATE FUNCTION f(a integer DEFAULT 1) RETURNS integer LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER AS 'SELECT a';
             CREATE PROCEDURE p() LANGUAGE sql AS 'SELECT 1';",
        )
        .await;
        let schema_oid = scratch.oid("SELECT oid FROM pg_namespace WHERE nspname = '{schema}'").await;
        let relation = |name: &'static str| format!("SELECT '{{schema}}.{name}'::regclass::oid");
        let routine = |name: &'static str| format!("SELECT oid FROM pg_proc WHERE proname = '{name}' AND pronamespace = '{{schema}}'::regnamespace");

        assert_eq!(scratch.read(ObjectType::Schema, schema_oid).await.unwrap(), ObjectDefinition::Schema { name: scratch.schema.clone(), comment: None });
        let sequence = scratch.read(ObjectType::Sequence, scratch.oid(&relation("seq")).await).await.unwrap();
        assert_eq!(sequence, ObjectDefinition::Sequence {
            schema: scratch.schema.clone(),
            name: "seq".into(),
            data_type: "integer".into(),
            increment: "5".into(),
            min_value: "1".into(),
            max_value: "99".into(),
            start: "3".into(),
            cache: "2".into(),
            cycle: true,
            comment: Some("numbers".into()),
        });
        assert_eq!(
            scratch.read(ObjectType::View, scratch.oid(&relation("v")).await).await.unwrap(),
            ObjectDefinition::View { schema: scratch.schema.clone(), name: "v".into(), query: "SELECT 1 AS n".into(), comment: None }
        );
        assert_eq!(
            scratch.read(ObjectType::MaterializedView, scratch.oid(&relation("m")).await).await.unwrap(),
            ObjectDefinition::MaterializedView { schema: scratch.schema.clone(), name: "m".into(), query: "SELECT 2 AS n".into(), comment: None }
        );
        let function = scratch.read(ObjectType::Function, scratch.oid(&routine("f")).await).await.unwrap();
        assert_eq!(function, ObjectDefinition::Routine {
            procedure: false,
            schema: scratch.schema.clone(),
            name: "f".into(),
            arguments: "a integer DEFAULT 1".into(),
            identity_arguments: "a integer".into(),
            returns: "integer".into(),
            language: "sql".into(),
            volatility: Volatility::Stable,
            security_definer: true,
            parallel: Parallel::Restricted,
            body: "SELECT a".into(),
            comment: None,
        });
        let procedure = scratch.read(ObjectType::Procedure, scratch.oid(&routine("p")).await).await.unwrap();
        assert_eq!(procedure.object_type(), ObjectType::Procedure);
        let function_ref = scratch.object(ObjectType::Function, scratch.oid(&routine("f")).await);
        let dropped = plan(&scratch.client, Some(&function_ref), Some(&function), None, options()).await.unwrap();
        assert_eq!((dropped.statements.len(), dropped.dependents.len()), (1, 0));

        for object_type in [ObjectType::Schema, ObjectType::Sequence, ObjectType::View, ObjectType::MaterializedView, ObjectType::Function, ObjectType::Procedure] {
            assert_eq!(scratch.read(object_type, 1).await.map_err(|error| crate::testing::parts(error).0), Err("not_found".to_string()), "{object_type:?}");
        }
        assert!(schema_names(&scratch.client).await.unwrap().contains(&scratch.schema));
        scratch.finish().await;
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_view_keeps_replace_when_its_columns_stay_and_is_recreated_with_its_dependents_listed_when_they_change() {
        let scratch = Scratch::new("CREATE VIEW v AS SELECT 1 AS n; CREATE VIEW uses_v AS SELECT n FROM v;").await;
        let object = scratch.object(ObjectType::View, scratch.oid("SELECT '{schema}.v'::regclass::oid").await);
        let original = definition(&scratch.client, &object).await.unwrap();
        let with_query = |query: &str| ObjectDefinition::View { schema: scratch.schema.clone(), name: "v".into(), query: query.into(), comment: None };

        let added = plan(&scratch.client, Some(&object), Some(&original), Some(&with_query("SELECT 1 AS n, 2 AS m")), options()).await.unwrap();
        let renamed = plan(&scratch.client, Some(&object), Some(&original), Some(&with_query("SELECT 1 AS renamed")), options()).await.unwrap();
        let retyped = plan(&scratch.client, Some(&object), Some(&original), Some(&with_query("SELECT 'one'::text AS n")), options()).await.unwrap();
        let broken = plan(&scratch.client, Some(&object), Some(&original), Some(&with_query("SELEC 1")), options()).await;

        assert!(added.statements[0].starts_with("CREATE OR REPLACE VIEW"));
        assert!(renamed.statements[0].starts_with("DROP VIEW"));
        assert!(retyped.statements[0].starts_with("DROP VIEW"));
        assert_eq!(renamed.dependents, ["view uses_v"]);
        assert!(crate::testing::parts(broken.unwrap_err()).1.contains("syntax error"));
        scratch.finish().await;
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_new_materialized_view_query_is_checked_and_a_plan_without_a_drop_lists_no_dependents() {
        let scratch = Scratch::new("").await;
        let new_view = ObjectDefinition::MaterializedView { schema: scratch.schema.clone(), name: "m".into(), query: "SELECT 1 AS n".into(), comment: None };

        let created = plan(&scratch.client, None, None, Some(&new_view), options()).await.unwrap();

        assert_eq!((created.statements.len(), created.dependents.len()), (1, 0));
        let unnamed = ObjectDefinition::Schema { name: String::new(), comment: None };
        assert_eq!(plan(&scratch.client, None, None, Some(&unnamed), options()).await, Err(CommandError::Invalid("Name is required.".into())));
        scratch.finish().await;
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_applying_runs_every_statement_in_one_transaction_and_a_failure_rolls_all_of_them_back() {
        let scratch = Scratch::new("").await;
        let schema = scratch.schema.clone();
        let exists = |name: &'static str| {
            let sql = format!("SELECT count(*) FROM pg_class WHERE relname = '{name}' AND relnamespace = '{schema}'::regnamespace");
            let client = &scratch.client;
            async move { client.query_one(&sql, &[]).await.unwrap().get::<_, i64>(0) }
        };

        let applied = apply(&live_params(), &[format!("CREATE SEQUENCE {schema}.a"), format!("CREATE SEQUENCE {schema}.b")], &[]).await.unwrap();
        let failed = apply(&live_params(), &[format!("CREATE SEQUENCE {schema}.c"), format!("CREATE SEQUENCE {schema}.a")], &[]).await.unwrap();

        assert_eq!(applied, ApplyOutcome::Applied);
        assert_eq!(failed, ApplyOutcome::Failed {
            failure: ApplyFailure { statement_index: 1, committed: false, message: "relation \"a\" already exists".into(), detail: None, hint: None }
        });
        assert_eq!((exists("b").await, exists("c").await), (1, 0));
        scratch.finish().await;
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_failure_keeps_the_servers_detail_and_hint() {
        let scratch = Scratch::new("CREATE TABLE t (n integer); CREATE VIEW v AS SELECT n FROM t;").await;

        let failed = apply(&live_params(), &[format!("DROP TABLE {}.t", scratch.schema)], &[]).await.unwrap();

        let failure = &serde_json::to_value(&failed).unwrap()["failure"];
        assert!(failure["detail"].as_str().unwrap().contains("depends on table"));
        assert_eq!(failure["hint"], "Use DROP ... CASCADE to drop the dependent objects too.");
        scratch.finish().await;
    }

    const SHOP: &str = "
        CREATE TABLE customers (id bigint PRIMARY KEY, email text);
        CREATE TABLE orders (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          customer_id bigint NOT NULL REFERENCES customers ON DELETE CASCADE,
          quantity integer NOT NULL DEFAULT 1,
          total numeric GENERATED ALWAYS AS (quantity * 2) STORED,
          note text,
          CONSTRAINT one_note UNIQUE (note) DEFERRABLE);
        ALTER TABLE orders ADD CONSTRAINT positive CHECK (quantity > 0) NOT VALID;
        COMMENT ON TABLE orders IS 'placed orders';
        COMMENT ON COLUMN orders.note IS 'free text';
        CREATE INDEX orders_by_note ON orders (lower(note)) WHERE note IS NOT NULL;
        CREATE VIEW notes AS SELECT note FROM orders;
        CREATE TABLE events (at timestamptz) PARTITION BY RANGE (at);";

    async fn table(scratch: &Scratch, name: &str) -> (ObjectRef, TableDefinition) {
        let object = scratch.object(ObjectType::Table, scratch.oid(&format!("SELECT '{{schema}}.{name}'::regclass::oid")).await);
        let read = scratch.read(ObjectType::Table, object.oid).await.unwrap();
        (object, serde_json::from_value(serde_json::to_value(read).unwrap()).unwrap())
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_table_reads_back_its_columns_constraints_and_indexes() {
        let scratch = Scratch::new(SHOP).await;
        let (_, orders) = table(&scratch, "orders").await;
        let (_, events) = table(&scratch, "events").await;

        let columns = orders
            .columns
            .iter()
            .map(|column| (column.number, column.name.as_str(), column.data_type.as_str(), column.not_null, column.default.as_str(), column.identity, column.generated.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(columns, [
            (Some(1), "id", "bigint", true, "", Identity::Always, ""),
            (Some(2), "customer_id", "bigint", true, "", Identity::None, ""),
            (Some(3), "quantity", "integer", true, "1", Identity::None, ""),
            (Some(4), "total", "numeric", false, "", Identity::None, "(quantity * 2)"),
            (Some(5), "note", "text", false, "", Identity::None, ""),
        ]);
        assert_eq!((orders.comment.as_deref(), orders.columns[4].comment.as_deref(), orders.partition_key), (Some("placed orders"), Some("free text"), None));
        let constraints = orders
            .constraints
            .iter()
            .map(|constraint| (constraint.name.as_str(), constraint.kind, constraint.columns.clone(), constraint.references.as_str(), constraint.expression.as_str(), constraint.not_valid))
            .collect::<Vec<_>>();
        assert_eq!(constraints, [
            ("orders_pkey", ConstraintKind::PrimaryKey, vec!["id".to_string()], "", "", false),
            ("one_note", ConstraintKind::Other, vec!["note".to_string()], "", "UNIQUE (note) DEFERRABLE", false),
            ("orders_customer_id_fkey", ConstraintKind::ForeignKey, vec!["customer_id".to_string()], "customers", "", false),
            ("positive", ConstraintKind::Check, vec!["quantity".to_string()], "", "(quantity > 0)", true),
        ]);
        assert_eq!(orders.constraints[2].on_delete, ReferentialAction::Cascade);
        assert_eq!(orders.indexes, [IndexDefinition {
            original_name: Some("orders_by_note".into()),
            name: "orders_by_note".into(),
            unique: false,
            method: "btree".into(),
            keys: "lower(note)".into(),
            clauses: "WHERE (note IS NOT NULL)".into(),
            concurrently: false,
        }]);
        assert_eq!(events.partition_key.as_deref(), Some("RANGE (at)"));
        assert_eq!(scratch.read(ObjectType::Table, 1).await.map_err(|error| crate::testing::parts(error).0), Err("not_found".to_string()));
        scratch.finish().await;
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_table_change_lists_what_depends_on_dropped_columns_and_constraints_and_builds_indexes_after_the_commit() {
        let scratch = Scratch::new(SHOP).await;
        let (orders_ref, orders) = table(&scratch, "orders").await;
        let (customers_ref, customers) = table(&scratch, "customers").await;
        let original = ObjectDefinition::Table(orders.clone());

        let mut without_note = orders.clone();
        without_note.columns.remove(4);
        let dropped_column = plan(&scratch.client, Some(&orders_ref), Some(&original), Some(&ObjectDefinition::Table(without_note)), options()).await.unwrap();
        let mut without_key = customers.clone();
        without_key.constraints.clear();
        let customers_original = ObjectDefinition::Table(customers);
        let dropped_key = plan(&scratch.client, Some(&customers_ref), Some(&customers_original), Some(&ObjectDefinition::Table(without_key)), options()).await.unwrap();

        assert_eq!(dropped_column.dependents, ["view notes"]);
        assert_eq!(dropped_key.dependents, ["constraint orders_customer_id_fkey on table orders"]);

        let mut indexed = orders.clone();
        indexed.indexes.push(IndexDefinition {
            original_name: None,
            name: "orders_by_quantity".into(),
            unique: false,
            method: "btree".into(),
            keys: "quantity".into(),
            clauses: String::new(),
            concurrently: true,
        });
        indexed.comment = Some("orders placed".into());
        let built = plan(&scratch.client, Some(&orders_ref), Some(&original), Some(&ObjectDefinition::Table(indexed)), options()).await.unwrap();
        let applied = apply(&live_params(), &built.statements, &built.after_commit).await.unwrap();
        let (_, after) = table(&scratch, "orders").await;
        assert_eq!((applied, after.indexes.len(), after.comment.as_deref()), (ApplyOutcome::Applied, 2, Some("orders placed")));

        let failed = apply(&live_params(), &built.statements, &[format!("CREATE INDEX CONCURRENTLY ON {}.orders (missing)", scratch.schema)]).await.unwrap();
        let failure = &serde_json::to_value(&failed).unwrap()["failure"];
        assert_eq!((&failure["statement_index"], &failure["committed"]), (&serde_json::json!(1), &serde_json::json!(true)));
        scratch.finish().await;
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_types_and_extensions_read_back_and_the_server_lists_its_extensions_and_roles() {
        let scratch = Scratch::new(
            "CREATE TYPE mood AS ENUM ('sad', 'ok'); COMMENT ON TYPE mood IS 'how it went';
             CREATE TYPE address AS (street text, zip varchar(10));
             CREATE DOMAIN quantity AS integer DEFAULT 1 NOT NULL CONSTRAINT positive CHECK (VALUE > 0);
             CREATE TYPE span AS RANGE (SUBTYPE = numeric);
             CREATE EXTENSION citext;",
        )
        .await;
        let read = |name: &'static str| {
            let scratch = &scratch;
            async move {
                let oid = scratch.oid(&format!("SELECT '{{schema}}.{name}'::regtype::oid")).await;
                serde_json::from_value::<TypeDefinition>(serde_json::to_value(scratch.read(ObjectType::Type, oid).await.unwrap()).unwrap()).unwrap()
            }
        };

        let mood = read("mood").await;
        let address = read("address").await;
        let quantity = read("quantity").await;
        let span = read("span").await;
        let extension_oid = scratch.oid("SELECT oid FROM pg_extension WHERE extname = 'citext'").await;
        let extension = scratch.read(ObjectType::Extension, extension_oid).await.unwrap();

        assert_eq!((mood.kind, mood.comment.as_deref()), (TypeKind::Enum, Some("how it went")));
        assert_eq!(mood.values, [EnumValue { original: Some("sad".into()), label: "sad".into() }, EnumValue { original: Some("ok".into()), label: "ok".into() }]);
        assert_eq!(address.attributes.iter().map(|attribute| (attribute.name.as_str(), attribute.data_type.as_str())).collect::<Vec<_>>(), [
            ("street", "text"),
            ("zip", "character varying(10)")
        ]);
        assert_eq!((quantity.kind, quantity.base_type.as_str(), quantity.default.as_str(), quantity.not_null), (TypeKind::Domain, "integer", "1", true));
        assert_eq!(quantity.checks, [DomainCheck { original_name: Some("positive".into()), name: "positive".into(), expression: "(VALUE > 0)".into() }]);
        assert_eq!((span.kind, span.base_type.as_str()), (TypeKind::Range, "numeric"));
        assert_eq!(serde_json::to_value(&extension).unwrap()["schema"], serde_json::json!(scratch.schema));
        let type_ref = scratch.object(ObjectType::Type, scratch.oid("SELECT '{schema}.mood'::regtype::oid").await);
        let mood_definition = ObjectDefinition::Type(mood.clone());
        let dropped_type = plan(&scratch.client, Some(&type_ref), Some(&mood_definition), None, options()).await.unwrap();
        let extension_ref = scratch.object(ObjectType::Extension, extension_oid);
        let dropped_extension = plan(&scratch.client, Some(&extension_ref), Some(&extension), None, options()).await.unwrap();
        assert_eq!((dropped_type.dependents.len(), dropped_extension.dependents.len()), (0, 0));
        let available = available_extensions(&scratch.client).await.unwrap();
        let citext = available.iter().find(|candidate| candidate.name == "citext").unwrap();
        assert!(citext.installed && citext.versions.contains(&citext.default_version));
        assert!(role_names(&scratch.client).await.unwrap().contains(&live_params().user));
        for object_type in [ObjectType::Type, ObjectType::Extension, ObjectType::Database] {
            assert_eq!(scratch.read(object_type, 0).await.map_err(|error| crate::testing::parts(error).0), Err("not_found".to_string()), "{object_type:?}");
        }
        scratch.finish().await;
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_database_is_created_warned_about_its_other_sessions_and_dropped_with_force() {
        let (client, driver) = open(&live_params()).await.unwrap();
        let name = format!("tw_db_{}", uuid::Uuid::new_v4().simple());
        let new_database = ObjectDefinition::Database(DatabaseDefinition {
            name: name.clone(),
            owner: String::new(),
            encoding: "UTF8".into(),
            template: "template0".into(),
            collation: String::new(),
            ctype: String::new(),
            connection_limit: 10,
            comment: Some("scratch".into()),
        });
        let created = plan(&client, None, None, Some(&new_database), options()).await.unwrap();
        assert_eq!(apply(&live_params(), &created.statements, &created.after_commit).await.unwrap(), ApplyOutcome::Applied);

        let oid: u32 = client.query_one("SELECT oid FROM pg_database WHERE datname = $1", &[&name]).await.unwrap().get(0);
        let object = ObjectRef { database: live_params().database, object_type: ObjectType::Database, oid };
        let read = definition(&client, &object).await.unwrap();
        let read_back: DatabaseDefinition = serde_json::from_value(serde_json::to_value(&read).unwrap()).unwrap();
        assert_eq!((read_back.encoding.as_str(), read_back.connection_limit, read_back.comment.as_deref()), ("UTF8", 10, Some("scratch")));

        let (other, other_driver) = open(&ConnectParams { database: name.clone(), ..live_params() }).await.unwrap();
        other.batch_execute("SET application_name = 'someone else'").await.unwrap();
        let (another, another_driver) = open(&ConnectParams { database: name.clone(), ..live_params() }).await.unwrap();
        another.batch_execute("SET application_name = 'someone else'").await.unwrap();
        let renamed = ObjectDefinition::Database(DatabaseDefinition { name: format!("{name}_2"), ..read_back.clone() });
        let rename = plan(&client, Some(&object), Some(&read), Some(&renamed), options()).await.unwrap();
        let drop = plan(&client, Some(&object), Some(&read), None, ChangeOptions { force: true, ..options() }).await.unwrap();

        let titles = |plan: &ChangePlan| plan.warnings.iter().map(|warning| warning.title.clone()).collect::<Vec<_>>();
        assert_eq!(titles(&rename), ["Closes Tidewater's sessions on it", "Other sessions are connected"]);
        assert_eq!(rename.warnings[1].detail, format!("2 other sessions are connected to {name}. Renaming it fails while they are."));
        another_driver.abort();
        let _ = another_driver.await;
        let alone = plan(&client, Some(&object), Some(&read), Some(&renamed), options()).await.unwrap();
        assert_eq!(alone.warnings[1].detail, format!("1 other session is connected to {name}. Renaming it fails while they are."));
        assert!(drop.warnings[1].detail.ends_with("Dropping it fails while they are, unless FORCE disconnects them."));
        assert_eq!(drop.closes_database.as_deref(), Some(name.as_str()));
        assert_eq!(apply(&live_params(), &drop.statements, &drop.after_commit).await.unwrap(), ApplyOutcome::Applied);
        assert_eq!(client.query_one("SELECT count(*) FROM pg_database WHERE datname = $1", &[&name]).await.unwrap().get::<_, i64>(0), 0);
        let quiet = plan(&client, Some(&object), Some(&read), None, options()).await.unwrap();
        assert_eq!(titles(&quiet), ["Closes Tidewater's sessions on it"]);
        other_driver.abort();
        driver.abort();
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_dropped_connection_fails_reading_and_planning() {
        let (client, driver) = open(&live_params()).await.unwrap();
        driver.abort();
        let _ = driver.await;
        let object = |object_type| ObjectRef { database: live_params().database, object_type, oid: 1 };
        let schema = ObjectDefinition::Schema { name: "gone".into(), comment: None };
        let view = ObjectDefinition::View { schema: "public".into(), name: "v".into(), query: "SELECT 1".into(), comment: None };
        let fails = |result: Result<(), CommandError>| result.map_err(|error| crate::testing::parts(error).0);

        assert_eq!(fails(schema_names(&client).await.map(|_| ())), Err("connection".into()));
        for object_type in [ObjectType::Schema, ObjectType::Table, ObjectType::Type, ObjectType::Extension, ObjectType::Database, ObjectType::Sequence, ObjectType::View, ObjectType::Function] {
            assert_eq!(fails(definition(&client, &object(object_type)).await.map(|_| ())), Err("connection".into()), "{object_type:?}");
        }
        let changed_view = ObjectDefinition::View { schema: "public".into(), name: "v".into(), query: "SELECT 2".into(), comment: None };
        let replanned = plan(&client, Some(&object(ObjectType::View)), Some(&view), Some(&changed_view), options()).await;
        assert_eq!(fails(replanned.map(|_| ())), Err("connection".into()));
        let dropped = plan(&client, Some(&object(ObjectType::Schema)), Some(&schema), None, options()).await;
        assert_eq!(fails(dropped.map(|_| ())), Err("connection".into()));
        let database = |name: &str| {
            ObjectDefinition::Database(DatabaseDefinition {
                name: name.into(),
                owner: String::new(),
                encoding: String::new(),
                template: String::new(),
                collation: String::new(),
                ctype: String::new(),
                connection_limit: -1,
                comment: None,
            })
        };
        let renamed = plan(&client, None, Some(&database("a")), Some(&database("b")), options()).await;
        assert_eq!(fails(renamed.map(|_| ())), Err("connection".into()));
        assert_eq!(fails(available_extensions(&client).await.map(|_| ())), Err("connection".into()));
        assert_eq!(fails(role_names(&client).await.map(|_| ())), Err("connection".into()));
    }
}
