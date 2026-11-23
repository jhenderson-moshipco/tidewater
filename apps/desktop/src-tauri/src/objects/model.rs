//! The schema objects the editors create, change and drop, as the frontend and the Rust core share them.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "objects.ts")]
pub enum ObjectType {
    Schema,
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
        }
    }
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
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "objects.ts")]
pub struct ApplyFailure {
    /// The statement that failed, counted from 0.
    pub statement_index: u32,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
}
