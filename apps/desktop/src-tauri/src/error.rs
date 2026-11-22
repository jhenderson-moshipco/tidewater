//! The error every command returns to the frontend.

use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, Serialize, TS)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
#[ts(export, export_to = "errors.ts")]
pub enum CommandError {
    #[error("{0}")]
    StoreLocked(String),
    #[error("{0}")]
    WrongPassphrase(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Storage(String),
    #[error("{0}")]
    Connection(String),
}
