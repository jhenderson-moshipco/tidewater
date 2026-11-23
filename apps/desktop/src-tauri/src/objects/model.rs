//! The schema objects the editors create, change and drop, as the frontend and the Rust core share them.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "objects.ts")]
pub enum ObjectType {
    Schema,
    Table,
    Sequence,
    View,
    MaterializedView,
    Function,
    Procedure,
}

/// An existing object, by its database and oid.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "objects.ts")]
pub struct ObjectRef {
    pub database: String,
    pub object_type: ObjectType,
    pub oid: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "objects.ts")]
pub enum Volatility {
    Volatile,
    Stable,
    Immutable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "objects.ts")]
pub enum Parallel {
    Unsafe,
    Restricted,
    Safe,
}

/// An object's editable definition. Numbers a sequence may hold beyond JavaScript's safe range travel as text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "objects.ts")]
pub enum ObjectDefinition {
    Schema {
        name: String,
        comment: Option<String>,
    },
    Sequence {
        schema: String,
        name: String,
        data_type: String,
        increment: String,
        /// Empty for the data type's own bound.
        min_value: String,
        max_value: String,
        start: String,
        cache: String,
        cycle: bool,
        comment: Option<String>,
    },
    View {
        schema: String,
        name: String,
        query: String,
        comment: Option<String>,
    },
    MaterializedView {
        schema: String,
        name: String,
        query: String,
        comment: Option<String>,
    },
    Routine {
        procedure: bool,
        schema: String,
        name: String,
        /// The argument list as Postgres prints it, defaults included.
        arguments: String,
        /// The argument types that identify the routine, as `DROP` and `ALTER` need them. Empty for a new routine.
        identity_arguments: String,
        /// Empty for a procedure.
        returns: String,
        language: String,
        volatility: Volatility,
        security_definer: bool,
        parallel: Parallel,
        body: String,
        comment: Option<String>,
    },
    Table(TableDefinition),
}

impl ObjectDefinition {
    pub fn object_type(&self) -> ObjectType {
        match self {
            ObjectDefinition::Schema { .. } => ObjectType::Schema,
            ObjectDefinition::Sequence { .. } => ObjectType::Sequence,
            ObjectDefinition::View { .. } => ObjectType::View,
            ObjectDefinition::MaterializedView { .. } => ObjectType::MaterializedView,
            ObjectDefinition::Routine { procedure: false, .. } => ObjectType::Function,
            ObjectDefinition::Routine { procedure: true, .. } => ObjectType::Procedure,
            ObjectDefinition::Table(_) => ObjectType::Table,
        }
    }
}

/// A table with its columns, constraints and indexes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "objects.ts")]
pub struct TableDefinition {
    pub schema: String,
    pub name: String,
    pub comment: Option<String>,
    /// How a partitioned table splits its rows, as Postgres prints it; null for a plain table. The designer can't change it.
    pub partition_key: Option<String>,
    pub columns: Vec<ColumnDefinition>,
    pub constraints: Vec<ConstraintDefinition>,
    /// The table's indexes, leaving out those that back a primary key or unique constraint.
    pub indexes: Vec<IndexDefinition>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "objects.ts")]
pub enum Identity {
    None,
    Always,
    ByDefault,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "objects.ts")]
pub struct ColumnDefinition {
    /// The column's number in its table, which follows it through a rename; null for a new column.
    pub number: Option<i16>,
    pub name: String,
    pub data_type: String,
    pub not_null: bool,
    /// The default expression; empty for none.
    pub default: String,
    pub identity: Identity,
    /// The expression a stored generated column is computed from; empty for an ordinary column. Fixed once added.
    pub generated: String,
    /// How existing values become the new type when the type changes; empty to let Postgres cast them.
    pub using: String,
    pub comment: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "objects.ts")]
pub enum ConstraintKind {
    PrimaryKey,
    Unique,
    ForeignKey,
    Check,
    /// A kind the designer shows but doesn't build, such as an exclusion constraint, kept as its whole definition.
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "objects.ts")]
pub enum ReferentialAction {
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "objects.ts")]
pub struct ConstraintDefinition {
    /// The constraint's name in the database; null for a new one.
    pub original_name: Option<String>,
    /// Empty to let Postgres name a new constraint.
    pub name: String,
    pub kind: ConstraintKind,
    /// The constrained columns of a primary key, unique constraint or foreign key.
    pub columns: Vec<String>,
    /// The table a foreign key references, as SQL names it.
    pub references: String,
    /// The referenced columns; empty for the referenced table's primary key.
    pub referenced_columns: Vec<String>,
    pub on_update: ReferentialAction,
    pub on_delete: ReferentialAction,
    /// A check's expression, or the whole definition of an `Other` constraint.
    pub expression: String,
    /// Whether existing rows go unchecked (NOT VALID). Clearing it on an existing constraint validates them.
    pub not_valid: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "objects.ts")]
pub struct IndexDefinition {
    /// The index's name in the database; null for a new one.
    pub original_name: Option<String>,
    /// Empty to let Postgres name a new index.
    pub name: String,
    pub unique: bool,
    pub method: String,
    /// The indexed columns and expressions, as written between the parentheses.
    pub keys: String,
    /// What follows the keys, such as `INCLUDE (…)` or `WHERE …`; empty for nothing.
    pub clauses: String,
    /// Build it with `CREATE INDEX CONCURRENTLY` once the rest of the change commits, so writes don't wait.
    pub concurrently: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "objects.ts")]
pub struct ChangeOptions {
    /// Also drop what depends on an object that is dropped or recreated.
    pub cascade: bool,
    /// Fill a materialized view as it is created; otherwise it waits for a refresh.
    pub with_data: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "objects.ts")]
pub struct ChangeWarning {
    pub title: String,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "objects.ts")]
pub struct ChangePlan {
    /// Each statement to run, in order, in one transaction.
    pub statements: Vec<String>,
    pub warnings: Vec<ChangeWarning>,
    /// What depends on an object the plan drops, as Postgres describes each one.
    pub dependents: Vec<String>,
    /// Statements that can't run in a transaction, each run on its own once the transaction commits.
    pub after_commit: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "objects.ts")]
pub struct ApplyFailure {
    /// The statement that failed, counted from 0 across the transaction's statements and then those after it.
    pub statement_index: u32,
    /// Whether the transaction had already committed, so only the statements after it from this one on didn't run.
    pub committed: bool,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
}
