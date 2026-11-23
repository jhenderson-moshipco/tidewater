//! Reads, plans and applies changes to schema objects. The DDL itself is written in `ddl`.

pub mod ddl;
pub mod model;

use serde::Serialize;
use tokio_postgres::Client;
use ts_rs::TS;

use crate::connections::{ConnectParams, describe, open};
use crate::error::CommandError;
use model::{ApplyFailure, ChangeOptions, ChangePlan, ObjectDefinition, ObjectRef, ObjectType, Parallel, Volatility};

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
/// What depends on an object, naming a dependent view rather than the internal rule that holds its query.
const DEPENDENTS: &str = "\
SELECT DISTINCT coalesce(
  (SELECT CASE c.relkind WHEN 'm' THEN 'materialized view ' ELSE 'view ' END || c.oid::regclass::text
   FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE d.classid = 'pg_rewrite'::regclass AND r.oid = d.objid),
  pg_describe_object(d.classid, d.objid, d.objsubid))
FROM pg_depend d
WHERE d.refclassid = $1::text::regclass AND d.refobjid = $2 AND d.deptype IN ('n', 'a')
ORDER BY 1";

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
        ObjectType::Sequence | ObjectType::View | ObjectType::MaterializedView => "pg_class",
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
    if let Some(object) = object.filter(|_| planned.drops_original) {
        let rows = client.query(DEPENDENTS, &[&catalog_of(object.object_type), &object.oid]).await?;
        dependents = rows.iter().map(|row| row.get(0)).collect();
    }
    Ok(ChangePlan { statements: planned.statements, warnings: planned.warnings, dependents })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export, export_to = "objects.ts")]
pub enum ApplyOutcome {
    Applied,
    /// Nothing was changed: the transaction rolled back at this statement.
    Failed { failure: ApplyFailure },
}

/// Runs the statements in one transaction on a connection of their own, rolling all of them back if one fails.
pub async fn apply(params: &ConnectParams, statements: &[String]) -> Result<ApplyOutcome, CommandError> {
    let (client, driver) = open(params).await?;
    let steps = std::iter::once("BEGIN").chain(statements.iter().map(String::as_str)).chain(std::iter::once("COMMIT"));
    let mut outcome = ApplyOutcome::Applied;
    for (index, step) in steps.enumerate() {
        if let Err(error) = client.batch_execute(step).await {
            let _ = client.batch_execute("ROLLBACK").await;
            let database_error = error.as_db_error();
            outcome = ApplyOutcome::Failed {
                failure: ApplyFailure {
                    statement_index: u32::try_from(index.saturating_sub(1)).unwrap_or(u32::MAX),
                    message: database_error.map_or_else(|| describe(&error), |database_error| database_error.message().to_string()),
                    detail: database_error.and_then(|database_error| database_error.detail()).map(str::to_string),
                    hint: database_error.and_then(|database_error| database_error.hint()).map(str::to_string),
                },
            };
            break;
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
        ChangeOptions { cascade: false, with_data: true }
    }

    #[test]
    fn volatility_and_parallel_codes_map_to_their_settings() {
        assert_eq!([volatility("i"), volatility("s"), volatility("v")], [Volatility::Immutable, Volatility::Stable, Volatility::Volatile]);
        assert_eq!([parallel("s"), parallel("r"), parallel("u")], [Parallel::Safe, Parallel::Restricted, Parallel::Unsafe]);
    }

    #[tokio::test]
    async fn a_change_that_cannot_connect_is_a_connection_error_and_a_hang_up_is_a_failed_statement() {
        let refused = apply(&closed_port().await, &["SELECT 1".into()]).await;
        assert_eq!(refused.map_err(|error| crate::testing::parts(error).0), Err("connection".to_string()));

        let hung_up = apply(&fake_server(FakeServer::HangUpOnQuery).await, &["SELECT 1".into()]).await.unwrap();
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

        let applied = apply(&live_params(), &[format!("CREATE SEQUENCE {schema}.a"), format!("CREATE SEQUENCE {schema}.b")]).await.unwrap();
        let failed = apply(&live_params(), &[format!("CREATE SEQUENCE {schema}.c"), format!("CREATE SEQUENCE {schema}.a")]).await.unwrap();

        assert_eq!(applied, ApplyOutcome::Applied);
        assert_eq!(failed, ApplyOutcome::Failed {
            failure: ApplyFailure { statement_index: 1, message: "relation \"a\" already exists".into(), detail: None, hint: None }
        });
        assert_eq!((exists("b").await, exists("c").await), (1, 0));
        scratch.finish().await;
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_failure_keeps_the_servers_detail_and_hint() {
        let scratch = Scratch::new("CREATE TABLE t (n integer); CREATE VIEW v AS SELECT n FROM t;").await;

        let failed = apply(&live_params(), &[format!("DROP TABLE {}.t", scratch.schema)]).await.unwrap();

        let failure = &serde_json::to_value(&failed).unwrap()["failure"];
        assert!(failure["detail"].as_str().unwrap().contains("depends on table"));
        assert_eq!(failure["hint"], "Use DROP ... CASCADE to drop the dependent objects too.");
        scratch.finish().await;
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
        for object_type in [ObjectType::Schema, ObjectType::Sequence, ObjectType::View, ObjectType::Function] {
            assert_eq!(fails(definition(&client, &object(object_type)).await.map(|_| ())), Err("connection".into()), "{object_type:?}");
        }
        let changed_view = ObjectDefinition::View { schema: "public".into(), name: "v".into(), query: "SELECT 2".into(), comment: None };
        let replanned = plan(&client, Some(&object(ObjectType::View)), Some(&view), Some(&changed_view), options()).await;
        assert_eq!(fails(replanned.map(|_| ())), Err("connection".into()));
        let dropped = plan(&client, Some(&object(ObjectType::Schema)), Some(&schema), None, options()).await;
        assert_eq!(fails(dropped.map(|_| ())), Err("connection".into()));
    }
}
