//! Reads the schema tree from pg_catalog, one level at a time.

use serde::{Deserialize, Serialize};
use tokio_postgres::Client;
use ts_rs::TS;

use crate::objects::model::{ObjectRef, ObjectType};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "catalog.ts")]
pub enum ObjectKind {
    Table,
    View,
    MaterializedView,
    Function,
    Procedure,
    Sequence,
    Type,
}

/// Where a node's children come from. Nodes without one are leaves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "level", rename_all = "snake_case")]
#[ts(export, export_to = "catalog.ts")]
pub enum CatalogPath {
    Database { database: String },
    Extensions { database: String },
    Schema { database: String, schema_oid: u32 },
    Folder { database: String, schema_oid: u32, kind: ObjectKind },
    Relation { database: String, oid: u32, partitioned: bool },
    Partitions { database: String, oid: u32 },
}

impl CatalogPath {
    pub fn database(&self) -> &str {
        match self {
            CatalogPath::Database { database }
            | CatalogPath::Extensions { database }
            | CatalogPath::Schema { database, .. }
            | CatalogPath::Folder { database, .. }
            | CatalogPath::Relation { database, .. }
            | CatalogPath::Partitions { database, .. } => database,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "catalog.ts")]
pub enum NodeIcon {
    Database,
    Schema,
    Folder,
    Extension,
    Table,
    PartitionedTable,
    View,
    MaterializedView,
    Function,
    Procedure,
    Sequence,
    Type,
    Column,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "catalog.ts")]
pub struct CatalogNode {
    /// Unique among a server's nodes.
    pub key: String,
    pub label: String,
    pub detail: Option<String>,
    pub icon: NodeIcon,
    pub children: Option<CatalogPath>,
    /// The object an editor can open for this node, when it is a kind the editors cover.
    pub object: Option<ObjectRef>,
}

fn node(key: String, label: impl Into<String>, detail: Option<String>, icon: NodeIcon, children: Option<CatalogPath>) -> CatalogNode {
    CatalogNode { key, label: label.into(), detail, icon, children, object: None }
}

fn editable(mut node: CatalogNode, database: &str, object_type: Option<ObjectType>, oid: u32) -> CatalogNode {
    node.object = object_type.map(|object_type| ObjectRef { database: database.to_string(), object_type, oid });
    node
}

const FOLDERS: [(ObjectKind, &str); 7] = [
    (ObjectKind::Table, "Tables"),
    (ObjectKind::View, "Views"),
    (ObjectKind::MaterializedView, "Materialized views"),
    (ObjectKind::Function, "Functions"),
    (ObjectKind::Procedure, "Procedures"),
    (ObjectKind::Sequence, "Sequences"),
    (ObjectKind::Type, "Types"),
];

const DATABASES: &str = "SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname";

const SCHEMAS: &str = "\
SELECT oid, nspname FROM pg_namespace
WHERE $1 OR (nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema')
ORDER BY nspname";

const KIND_COUNTS: &str = "\
SELECT
  (SELECT count(*) FROM pg_class WHERE relnamespace = $1 AND relkind IN ('r', 'p') AND NOT relispartition),
  (SELECT count(*) FROM pg_class WHERE relnamespace = $1 AND relkind = 'v'),
  (SELECT count(*) FROM pg_class WHERE relnamespace = $1 AND relkind = 'm'),
  (SELECT count(*) FROM pg_proc WHERE pronamespace = $1 AND prokind IN ('f', 'a', 'w')),
  (SELECT count(*) FROM pg_proc WHERE pronamespace = $1 AND prokind = 'p'),
  (SELECT count(*) FROM pg_class WHERE relnamespace = $1 AND relkind = 'S'),
  (SELECT count(*) FROM pg_type t WHERE t.typnamespace = $1 AND (t.typtype IN ('e', 'r', 'm', 'd')
     OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))))";

const RELATIONS: &str = "\
SELECT oid, relname, relkind = 'p' FROM pg_class
WHERE relnamespace = $1 AND relkind = ANY($2) AND NOT relispartition
ORDER BY relname";

const ROUTINES: &str = "\
SELECT oid, proname, pg_get_function_identity_arguments(oid), prokind <> 'a' FROM pg_proc
WHERE pronamespace = $1 AND prokind = ANY($2)
ORDER BY proname, 3";

const TYPES: &str = "\
SELECT t.oid, t.typname,
  CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'r' THEN 'range' WHEN 'm' THEN 'multirange' WHEN 'd' THEN 'domain' ELSE 'composite' END
FROM pg_type t
WHERE t.typnamespace = $1 AND (t.typtype IN ('e', 'r', 'm', 'd')
  OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')))
ORDER BY t.typname";

const PARTITIONS: &str = "\
SELECT c.oid, c.relname, c.relkind = 'p', pg_get_expr(c.relpartbound, c.oid)
FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
WHERE i.inhparent = $1
ORDER BY c.relname";

const COLUMNS: &str = "\
SELECT attname, format_type(atttypid, atttypmod), attnotnull FROM pg_attribute
WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped
ORDER BY attnum";

const EXTENSIONS: &str = "SELECT extname, extversion FROM pg_extension ORDER BY extname";

/// Postgres's short name for a type as `format_type` spells it, keeping precision and array brackets:
/// `timestamp(3) with time zone` becomes `timestamptz(3)`, `character varying(255)[]` becomes `varchar(255)[]`.
pub fn short_type(full: &str) -> String {
    let base = full.trim_end_matches("[]");
    let brackets = &full[base.len()..];
    let after = |name: &str| base.strip_prefix(name).filter(|rest| rest.is_empty() || rest.starts_with(['(', ' ']));
    let zoned = |name: &str, rest: &str| -> Option<String> {
        if let Some(precision) = rest.strip_suffix(" with time zone") {
            return Some(format!("{name}tz{precision}"));
        }
        rest.strip_suffix(" without time zone").map(|precision| format!("{name}{precision}"))
    };
    let short = if let Some(rest) = after("timestamp") {
        zoned("timestamp", rest)
    } else if let Some(rest) = after("time") {
        zoned("time", rest)
    } else if let Some(rest) = after("character varying") {
        Some(format!("varchar{rest}"))
    } else if let Some(rest) = after("character") {
        Some(format!("char{rest}"))
    } else if let Some(rest) = after("bit varying") {
        Some(format!("varbit{rest}"))
    } else if base == "double precision" {
        Some("float8".to_string())
    } else if base == "boolean" {
        Some("bool".to_string())
    } else {
        None
    };
    format!("{}{brackets}", short.as_deref().unwrap_or(base))
}

/// The databases on the connected server.
pub async fn databases(client: &Client) -> Result<Vec<CatalogNode>, tokio_postgres::Error> {
    let rows = client.query(DATABASES, &[]).await?;
    Ok(rows
        .iter()
        .map(|row| {
            let database: String = row.get(0);
            node(format!("db:{database}"), database.clone(), None, NodeIcon::Database, Some(CatalogPath::Database { database }))
        })
        .collect())
}

fn char_codes(codes: &[u8]) -> Vec<i8> {
    codes.iter().map(|code| *code as i8).collect()
}

/// The schema's relations whose `relkind` is one of `codes`. Expandable ones list their columns.
async fn relations(
    client: &Client,
    database: &str,
    schema_oid: u32,
    codes: &[u8],
    icon: NodeIcon,
    expandable: bool,
    object_type: Option<ObjectType>,
) -> Result<Vec<CatalogNode>, tokio_postgres::Error> {
    let rows = client.query(RELATIONS, &[&schema_oid, &char_codes(codes)]).await?;
    Ok(rows
        .iter()
        .map(|row| {
            let oid: u32 = row.get(0);
            let name: String = row.get(1);
            let partitioned: bool = row.get(2);
            let children = expandable.then(|| CatalogPath::Relation { database: database.to_string(), oid, partitioned });
            let icon = if partitioned { NodeIcon::PartitionedTable } else { icon };
            let found = node(format!("db:{database}/rel:{oid}"), name, partitioned.then(|| "partitioned".to_string()), icon, children);
            editable(found, database, object_type, oid)
        })
        .collect())
}

/// The schema's routines whose `prokind` is one of `codes`, labelled with their arguments.
async fn routines(
    client: &Client,
    database: &str,
    schema_oid: u32,
    codes: &[u8],
    icon: NodeIcon,
    object_type: ObjectType,
) -> Result<Vec<CatalogNode>, tokio_postgres::Error> {
    let rows = client.query(ROUTINES, &[&schema_oid, &char_codes(codes)]).await?;
    Ok(rows
        .iter()
        .map(|row| {
            let oid: u32 = row.get(0);
            let name: String = row.get(1);
            let arguments: String = row.get(2);
            let editable_kind: bool = row.get(3);
            let found = node(format!("db:{database}/proc:{oid}"), format!("{name}({arguments})"), None, icon, None);
            editable(found, database, editable_kind.then_some(object_type), oid)
        })
        .collect())
}

/// The children of `path` inside `database`.
pub async fn children(client: &Client, path: &CatalogPath, show_system: bool) -> Result<Vec<CatalogNode>, tokio_postgres::Error> {
    let database = path.database().to_string();
    let prefix = format!("db:{database}");
    match path {
        CatalogPath::Database { .. } => {
            let rows = client.query(SCHEMAS, &[&show_system]).await?;
            let mut nodes: Vec<CatalogNode> = rows
                .iter()
                .map(|row| {
                    let schema_oid: u32 = row.get(0);
                    let name: String = row.get(1);
                    let found = node(
                        format!("{prefix}/schema:{schema_oid}"),
                        name,
                        None,
                        NodeIcon::Schema,
                        Some(CatalogPath::Schema { database: database.clone(), schema_oid }),
                    );
                    editable(found, &database, Some(ObjectType::Schema), schema_oid)
                })
                .collect();
            nodes.push(node(format!("{prefix}/extensions"), "Extensions", None, NodeIcon::Folder, Some(CatalogPath::Extensions { database })));
            Ok(nodes)
        }
        CatalogPath::Extensions { .. } => {
            let rows = client.query(EXTENSIONS, &[]).await?;
            Ok(rows
                .iter()
                .map(|row| {
                    let name: String = row.get(0);
                    let version: String = row.get(1);
                    node(format!("{prefix}/extension:{name}"), name, Some(version), NodeIcon::Extension, None)
                })
                .collect())
        }
        CatalogPath::Schema { schema_oid, .. } => {
            let row = client.query_one(KIND_COUNTS, &[schema_oid]).await?;
            Ok(FOLDERS
                .iter()
                .enumerate()
                .map(|(index, (kind, label))| {
                    let count: i64 = row.get(index);
                    node(
                        format!("{prefix}/schema:{schema_oid}/{kind:?}"),
                        *label,
                        Some(count.to_string()),
                        NodeIcon::Folder,
                        Some(CatalogPath::Folder { database: database.clone(), schema_oid: *schema_oid, kind: *kind }),
                    )
                })
                .collect())
        }
        CatalogPath::Folder { schema_oid, kind, .. } => match kind {
            ObjectKind::Table => relations(client, &database, *schema_oid, b"rp", NodeIcon::Table, true, Some(ObjectType::Table)).await,
            ObjectKind::View => relations(client, &database, *schema_oid, b"v", NodeIcon::View, true, Some(ObjectType::View)).await,
            ObjectKind::MaterializedView => {
                relations(client, &database, *schema_oid, b"m", NodeIcon::MaterializedView, true, Some(ObjectType::MaterializedView)).await
            }
            ObjectKind::Sequence => relations(client, &database, *schema_oid, b"S", NodeIcon::Sequence, false, Some(ObjectType::Sequence)).await,
            ObjectKind::Function => routines(client, &database, *schema_oid, b"faw", NodeIcon::Function, ObjectType::Function).await,
            ObjectKind::Procedure => routines(client, &database, *schema_oid, b"p", NodeIcon::Procedure, ObjectType::Procedure).await,
            ObjectKind::Type => {
                let rows = client.query(TYPES, &[schema_oid]).await?;
                Ok(rows
                    .iter()
                    .map(|row| {
                        let oid: u32 = row.get(0);
                        let name: String = row.get(1);
                        let variety: String = row.get(2);
                        node(format!("{prefix}/type:{oid}"), name, Some(variety), NodeIcon::Type, None)
                    })
                    .collect())
            }
        },
        CatalogPath::Relation { oid, partitioned, .. } => {
            let mut nodes = Vec::new();
            if *partitioned {
                nodes.push(node(
                    format!("{prefix}/rel:{oid}/partitions"),
                    "Partitions",
                    None,
                    NodeIcon::Folder,
                    Some(CatalogPath::Partitions { database: database.clone(), oid: *oid }),
                ));
            }
            let rows = client.query(COLUMNS, &[oid]).await?;
            nodes.extend(rows.iter().map(|row| {
                let name: String = row.get(0);
                let data_type: String = row.get(1);
                let not_null: bool = row.get(2);
                let short = short_type(&data_type);
                let detail = if not_null { format!("{short} · not null") } else { short };
                node(format!("{prefix}/rel:{oid}/col:{name}"), name, Some(detail), NodeIcon::Column, None)
            }));
            Ok(nodes)
        }
        CatalogPath::Partitions { oid, .. } => {
            let rows = client.query(PARTITIONS, &[oid]).await?;
            Ok(rows
                .iter()
                .map(|row| {
                    let oid: u32 = row.get(0);
                    let name: String = row.get(1);
                    let partitioned: bool = row.get(2);
                    let bound: Option<String> = row.get(3);
                    node(
                        format!("{prefix}/rel:{oid}"),
                        name,
                        bound,
                        if partitioned { NodeIcon::PartitionedTable } else { NodeIcon::Table },
                        Some(CatalogPath::Relation { database: database.clone(), oid, partitioned }),
                    )
                })
                .collect())
        }
    }
}

#[cfg(test)]
mod short_type_tests {
    use super::short_type;

    #[test]
    fn shortens_zoned_times_and_keeps_their_precision() {
        assert_eq!(short_type("timestamp with time zone"), "timestamptz");
        assert_eq!(short_type("timestamp(3) with time zone"), "timestamptz(3)");
        assert_eq!(short_type("timestamp without time zone"), "timestamp");
        assert_eq!(short_type("time with time zone"), "timetz");
        assert_eq!(short_type("time(0) without time zone"), "time(0)");
    }

    #[test]
    fn shortens_character_types_and_keeps_their_length() {
        assert_eq!(short_type("character varying(255)"), "varchar(255)");
        assert_eq!(short_type("character varying"), "varchar");
        assert_eq!(short_type("character(2)"), "char(2)");
        assert_eq!(short_type("bit varying(8)"), "varbit(8)");
    }

    #[test]
    fn keeps_array_brackets() {
        assert_eq!(short_type("character varying(64)[]"), "varchar(64)[]");
        assert_eq!(short_type("timestamp with time zone[][]"), "timestamptz[][]");
    }

    #[test]
    fn shortens_double_precision_and_boolean_and_leaves_other_types_alone() {
        assert_eq!(short_type("double precision"), "float8");
        assert_eq!(short_type("boolean"), "bool");
        assert_eq!(short_type("uuid"), "uuid");
        assert_eq!(short_type("numeric(12,2)"), "numeric(12,2)");
        assert_eq!(short_type("main.order_status"), "main.order_status");
    }

    #[test]
    fn leaves_user_types_that_only_start_like_built_ins_alone() {
        assert_eq!(short_type("characteristic"), "characteristic");
        assert_eq!(short_type("timeline"), "timeline");
        assert_eq!(short_type("timestamped_event"), "timestamped_event");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::ConnectionManager;

    const FIXTURE: &str = "
DROP SCHEMA IF EXISTS tw_catalog_test CASCADE;
CREATE SCHEMA tw_catalog_test;
SET search_path = tw_catalog_test;
CREATE TABLE customers (id bigint PRIMARY KEY, full_name text NOT NULL);
CREATE TABLE order_items (id bigint, created_at timestamptz NOT NULL) PARTITION BY RANGE (created_at);
CREATE TABLE order_items_2026_11 PARTITION OF order_items FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE order_items_2026_12 PARTITION OF order_items FOR VALUES FROM ('2026-12-01') TO ('2027-01-01') PARTITION BY HASH (id);
CREATE VIEW customer_names AS SELECT full_name FROM customers;
CREATE MATERIALIZED VIEW customer_count AS SELECT count(*) FROM customers;
CREATE FUNCTION add_one(value integer) RETURNS integer LANGUAGE sql AS 'SELECT value + 1';
CREATE AGGREGATE total_of(integer) (SFUNC = int4pl, STYPE = integer);
CREATE PROCEDURE touch() LANGUAGE sql AS 'SELECT 1';
CREATE SEQUENCE invoice_numbers;
CREATE TYPE order_status AS ENUM ('paid', 'shipped');
CREATE DOMAIN positive_amount AS numeric CHECK (VALUE > 0);
";

    /// A client for the live database, with the fixture schema created once for the whole run.
    async fn fixture_client() -> (std::sync::Arc<Client>, String) {
        static CREATED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
        let params = crate::testing::live_params();
        let database = params.database.clone();
        let client = ConnectionManager::default().client("fixture", &params).await.unwrap();
        CREATED.get_or_init(|| async { client.batch_execute(FIXTURE).await.unwrap() }).await;
        (client, database)
    }

    fn labels(nodes: &[CatalogNode]) -> Vec<&str> {
        nodes.iter().map(|node| node.label.as_str()).collect()
    }

    async fn schema_path(client: &Client, database: &str, show_system: bool, name: &str) -> Option<CatalogPath> {
        let schemas = children(client, &CatalogPath::Database { database: database.into() }, show_system).await.unwrap();
        schemas.into_iter().find(|node| node.label == name).and_then(|node| node.children)
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_lists_the_connected_database() {
        let (client, database) = fixture_client().await;
        assert!(labels(&databases(&client).await.unwrap()).contains(&database.as_str()));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_hides_system_schemas_until_asked() {
        let (client, database) = fixture_client().await;
        assert!(schema_path(&client, &database, false, "pg_catalog").await.is_none());
        assert!(schema_path(&client, &database, false, "information_schema").await.is_none());
        assert!(schema_path(&client, &database, true, "pg_catalog").await.is_some());
        assert!(schema_path(&client, &database, false, "tw_catalog_test").await.is_some());
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_counts_each_kind_and_lists_its_objects() {
        let (client, database) = fixture_client().await;
        let schema = schema_path(&client, &database, false, "tw_catalog_test").await.unwrap();
        let folders = children(&client, &schema, false).await.unwrap();
        let counts: Vec<(&str, &str)> = folders.iter().map(|node| (node.label.as_str(), node.detail.as_deref().unwrap())).collect();
        assert_eq!(
            counts,
            vec![
                ("Tables", "2"),
                ("Views", "1"),
                ("Materialized views", "1"),
                ("Functions", "2"),
                ("Procedures", "1"),
                ("Sequences", "1"),
                ("Types", "2"),
            ]
        );

        let tables = children(&client, folders[0].children.as_ref().unwrap(), false).await.unwrap();
        assert_eq!(labels(&tables), vec!["customers", "order_items"]);
        assert_eq!(tables[1].icon, NodeIcon::PartitionedTable);

        let functions = children(&client, folders[3].children.as_ref().unwrap(), false).await.unwrap();
        assert_eq!(labels(&functions), vec!["add_one(value integer)", "total_of(integer)"]);

        let types = children(&client, folders[6].children.as_ref().unwrap(), false).await.unwrap();
        let details: Vec<&str> = types.iter().map(|node| node.detail.as_deref().unwrap()).collect();
        assert_eq!(labels(&types), vec!["order_status", "positive_amount"]);
        assert_eq!(details, vec!["enum", "domain"]);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_nests_partitions_and_columns_under_tables() {
        let (client, database) = fixture_client().await;
        let schema = schema_path(&client, &database, false, "tw_catalog_test").await.unwrap();
        let folders = children(&client, &schema, false).await.unwrap();
        let tables = children(&client, folders[0].children.as_ref().unwrap(), false).await.unwrap();

        let customer_columns = children(&client, tables[0].children.as_ref().unwrap(), false).await.unwrap();
        assert_eq!(labels(&customer_columns), vec!["id", "full_name"]);
        assert_eq!(customer_columns[1].detail.as_deref(), Some("text · not null"));

        let order_items = children(&client, tables[1].children.as_ref().unwrap(), false).await.unwrap();
        assert_eq!(labels(&order_items), vec!["Partitions", "id", "created_at"]);
        let partitions = children(&client, order_items[0].children.as_ref().unwrap(), false).await.unwrap();
        assert_eq!(labels(&partitions), vec!["order_items_2026_11", "order_items_2026_12"]);
        assert!(partitions[0].detail.as_deref().unwrap().starts_with("FOR VALUES FROM"));
        assert_eq!((partitions[0].icon, partitions[1].icon), (NodeIcon::Table, NodeIcon::PartitionedTable));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_lists_views_sequences_procedures_and_extensions() {
        let (client, database) = fixture_client().await;
        let schema = schema_path(&client, &database, false, "tw_catalog_test").await.unwrap();
        let folders = children(&client, &schema, false).await.unwrap();
        let listed = |index: usize| children(&client, folders[index].children.as_ref().unwrap(), false);

        let view = &listed(1).await.unwrap()[0];
        assert_eq!((view.label.as_str(), view.icon), ("customer_names", NodeIcon::View));
        assert!(view.children.is_some());
        let materialized = &listed(2).await.unwrap()[0];
        assert_eq!((materialized.label.as_str(), materialized.icon), ("customer_count", NodeIcon::MaterializedView));
        let procedure = &listed(4).await.unwrap()[0];
        assert_eq!((procedure.label.as_str(), procedure.icon), ("touch()", NodeIcon::Procedure));
        let sequence = &listed(5).await.unwrap()[0];
        assert_eq!((sequence.label.as_str(), sequence.icon, sequence.children.is_none()), ("invoice_numbers", NodeIcon::Sequence, true));

        let database_children = children(&client, &CatalogPath::Database { database: database.clone() }, false).await.unwrap();
        let extensions = database_children.last().unwrap();
        assert_eq!(extensions.label, "Extensions");
        let installed = children(&client, extensions.children.as_ref().unwrap(), false).await.unwrap();
        assert!(labels(&installed).contains(&"plpgsql"), "{installed:?}");
        assert_eq!(extensions.children.as_ref().unwrap().database(), database);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_marks_the_objects_an_editor_covers_and_leaves_types_aggregates_and_columns_unmarked() {
        let (client, database) = fixture_client().await;
        let schemas = children(&client, &CatalogPath::Database { database: database.clone() }, false).await.unwrap();
        let schema = schemas.iter().find(|node| node.label == "tw_catalog_test").unwrap();
        let folders = children(&client, schema.children.as_ref().unwrap(), false).await.unwrap();
        let kinds = |nodes: &[CatalogNode]| nodes.iter().map(|node| node.object.as_ref().map(|object| object.object_type)).collect::<Vec<_>>();
        let mut found = Vec::new();
        for folder in &folders {
            found.push(kinds(&children(&client, folder.children.as_ref().unwrap(), false).await.unwrap()));
        }

        assert_eq!(schema.object.as_ref().map(|object| (object.object_type, object.database.as_str())), Some((ObjectType::Schema, database.as_str())));
        assert_eq!(found, vec![
            vec![Some(ObjectType::Table), Some(ObjectType::Table)],
            vec![Some(ObjectType::View)],
            vec![Some(ObjectType::MaterializedView)],
            vec![Some(ObjectType::Function), None],
            vec![Some(ObjectType::Procedure)],
            vec![Some(ObjectType::Sequence)],
            vec![None, None],
        ]);
        assert!(schemas.last().unwrap().object.is_none());
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_reports_errors_from_a_closed_connection_at_every_level() {
        let manager = ConnectionManager::default();
        let params = crate::testing::live_params();
        let client = manager.client("closed", &params).await.unwrap();
        manager.disconnect("closed").await;
        let database = params.database;
        let schema = |schema_oid| CatalogPath::Schema { database: database.clone(), schema_oid };
        let folder = |kind| CatalogPath::Folder { database: database.clone(), schema_oid: 2200, kind };
        let paths = [
            CatalogPath::Database { database: database.clone() },
            CatalogPath::Extensions { database: database.clone() },
            schema(2200),
            folder(ObjectKind::Table),
            folder(ObjectKind::Function),
            folder(ObjectKind::Type),
            CatalogPath::Relation { database: database.clone(), oid: 1259, partitioned: false },
            CatalogPath::Partitions { database: database.clone(), oid: 1259 },
        ];

        assert!(databases(&client).await.is_err());
        for path in &paths {
            assert!(children(&client, path, false).await.is_err(), "{path:?}");
        }
    }
}
