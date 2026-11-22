//! Saved servers and groups, and the edits the frontend can make to them.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::CommandError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "servers.ts")]
pub enum Environment {
    Dev,
    Staging,
    Prod,
    Local,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "servers.ts")]
pub enum TlsMode {
    Disable,
    #[default]
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "servers.ts")]
pub struct SessionDefaults {
    pub read_only: bool,
    pub statement_timeout_ms: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "servers.ts")]
pub struct ServerGroup {
    pub id: String,
    pub name: String,
}

/// A saved server as stored on disk, password included. Never sent to the frontend.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedServer {
    pub id: String,
    pub name: String,
    pub group_id: Option<String>,
    pub environment: Environment,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: Option<String>,
    pub tls: TlsMode,
    pub session: SessionDefaults,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerList {
    pub groups: Vec<ServerGroup>,
    pub servers: Vec<SavedServer>,
}

/// A saved server as the frontend sees it: everything except the password.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "servers.ts")]
pub struct ServerSummary {
    pub id: String,
    pub name: String,
    pub group_id: Option<String>,
    pub environment: Environment,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub has_password: bool,
    pub tls: TlsMode,
    pub session: SessionDefaults,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "servers.ts")]
pub struct ServerListView {
    pub groups: Vec<ServerGroup>,
    pub servers: Vec<ServerSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(tag = "action", content = "value", rename_all = "snake_case")]
#[ts(export, export_to = "servers.ts")]
pub enum PasswordChange {
    Keep,
    Clear,
    Set(String),
}

/// A new server when `id` is `None`, otherwise an edit to the server with that id.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, TS)]
#[ts(export, export_to = "servers.ts")]
pub struct ServerInput {
    pub id: Option<String>,
    pub name: String,
    pub group_id: Option<String>,
    pub environment: Environment,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: PasswordChange,
    pub tls: TlsMode,
    pub session: SessionDefaults,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, TS)]
#[ts(export, export_to = "servers.ts")]
pub struct GroupInput {
    pub id: Option<String>,
    pub name: String,
}

impl SavedServer {
    pub fn summary(&self) -> ServerSummary {
        ServerSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            group_id: self.group_id.clone(),
            environment: self.environment,
            host: self.host.clone(),
            port: self.port,
            database: self.database.clone(),
            user: self.user.clone(),
            has_password: self.password.is_some(),
            tls: self.tls,
            session: self.session.clone(),
        }
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn require_text(value: &str, field: &str) -> Result<String, CommandError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CommandError::Invalid(format!("{field} is required")));
    }
    Ok(trimmed.to_string())
}

impl ServerList {
    pub fn view(&self) -> ServerListView {
        ServerListView {
            groups: self.groups.clone(),
            servers: self.servers.iter().map(SavedServer::summary).collect(),
        }
    }

    pub fn find(&self, id: &str) -> Result<&SavedServer, CommandError> {
        self.servers
            .iter()
            .find(|server| server.id == id)
            .ok_or_else(|| CommandError::NotFound(format!("No saved server with id {id}")))
    }

    /// Resolves a password change against what is saved for `id`.
    pub fn resolve_password(&self, id: Option<&str>, change: &PasswordChange) -> Result<Option<String>, CommandError> {
        match change {
            PasswordChange::Set(password) => Ok(Some(password.clone())),
            PasswordChange::Clear => Ok(None),
            PasswordChange::Keep => match id {
                Some(id) => Ok(self.find(id)?.password.clone()),
                None => Ok(None),
            },
        }
    }

    pub fn upsert_server(&mut self, input: ServerInput) -> Result<ServerSummary, CommandError> {
        let name = require_text(&input.name, "Name")?;
        let host = require_text(&input.host, "Host")?;
        let database = require_text(&input.database, "Database")?;
        let user = require_text(&input.user, "User")?;
        if input.port == 0 {
            return Err(CommandError::Invalid("Port must be between 1 and 65535".into()));
        }
        if let Some(group_id) = &input.group_id {
            if !self.groups.iter().any(|group| &group.id == group_id) {
                return Err(CommandError::NotFound(format!("No group with id {group_id}")));
            }
        }
        let password = self.resolve_password(input.id.as_deref(), &input.password)?;
        let server = SavedServer {
            id: input.id.clone().unwrap_or_else(new_id),
            name,
            group_id: input.group_id,
            environment: input.environment,
            host,
            port: input.port,
            database,
            user,
            password,
            tls: input.tls,
            session: input.session,
        };
        let summary = server.summary();
        match input.id {
            Some(id) => {
                let slot = self
                    .servers
                    .iter_mut()
                    .find(|existing| existing.id == id)
                    .ok_or_else(|| CommandError::NotFound(format!("No saved server with id {id}")))?;
                *slot = server;
            }
            None => self.servers.push(server),
        }
        Ok(summary)
    }

    pub fn delete_server(&mut self, id: &str) -> Result<(), CommandError> {
        let before = self.servers.len();
        self.servers.retain(|server| server.id != id);
        if self.servers.len() == before {
            return Err(CommandError::NotFound(format!("No saved server with id {id}")));
        }
        Ok(())
    }

    pub fn upsert_group(&mut self, input: GroupInput) -> Result<ServerGroup, CommandError> {
        let name = require_text(&input.name, "Group name")?;
        match input.id {
            Some(id) => {
                let group = self
                    .groups
                    .iter_mut()
                    .find(|group| group.id == id)
                    .ok_or_else(|| CommandError::NotFound(format!("No group with id {id}")))?;
                group.name = name;
                Ok(group.clone())
            }
            None => {
                let group = ServerGroup { id: new_id(), name };
                self.groups.push(group.clone());
                Ok(group)
            }
        }
    }

    /// Deletes a group; its servers stay saved, without a group.
    pub fn delete_group(&mut self, id: &str) -> Result<(), CommandError> {
        let before = self.groups.len();
        self.groups.retain(|group| group.id != id);
        if self.groups.len() == before {
            return Err(CommandError::NotFound(format!("No group with id {id}")));
        }
        for server in self.servers.iter_mut().filter(|server| server.group_id.as_deref() == Some(id)) {
            server.group_id = None;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str) -> ServerInput {
        ServerInput {
            id: None,
            name: name.into(),
            group_id: None,
            environment: Environment::Dev,
            host: "localhost".into(),
            port: 5432,
            database: "orders".into(),
            user: "app".into(),
            password: PasswordChange::Set("first".into()),
            tls: TlsMode::default(),
            session: SessionDefaults::default(),
        }
    }

    fn invalid(message: &str) -> CommandError {
        CommandError::Invalid(message.into())
    }

    fn not_found(message: &str) -> CommandError {
        CommandError::NotFound(message.into())
    }

    #[test]
    fn new_servers_default_to_prefer_tls() {
        assert_eq!(TlsMode::default(), TlsMode::Prefer);
    }

    #[test]
    fn summaries_report_a_password_without_including_it() {
        let mut list = ServerList::default();
        let summary = list.upsert_server(input("orders-dev")).unwrap();
        assert!(summary.has_password);
        let json = serde_json::to_string(&list.view()).unwrap();
        assert!(!json.contains("first"));
    }

    #[test]
    fn required_text_is_trimmed() {
        let mut list = ServerList::default();
        let mut padded = input("  orders-dev  ");
        padded.host = " db.internal ".into();
        let summary = list.upsert_server(padded).unwrap();
        assert_eq!((summary.name.as_str(), summary.host.as_str()), ("orders-dev", "db.internal"));
    }

    #[test]
    fn keep_preserves_the_saved_password_and_clear_removes_it() {
        let mut list = ServerList::default();
        let id = list.upsert_server(input("orders-dev")).unwrap().id;

        let mut edit = input("orders-dev renamed");
        edit.id = Some(id.clone());
        edit.password = PasswordChange::Keep;
        list.upsert_server(edit.clone()).unwrap();
        assert_eq!(list.find(&id).unwrap().password.as_deref(), Some("first"));

        edit.password = PasswordChange::Clear;
        list.upsert_server(edit).unwrap();
        assert_eq!(list.find(&id).unwrap().password, None);
    }

    #[test]
    fn keep_on_a_new_server_means_no_password() {
        let mut list = ServerList::default();
        let mut new = input("orders-dev");
        new.password = PasswordChange::Keep;
        assert!(!list.upsert_server(new).unwrap().has_password);
    }

    #[test]
    fn rejects_each_blank_required_field_and_port_zero() {
        let mut list = ServerList::default();
        let blank = |change: fn(&mut ServerInput)| {
            let mut server = input("orders-dev");
            change(&mut server);
            server
        };
        assert_eq!(list.upsert_server(blank(|s| s.name = "  ".into())), Err(invalid("Name is required")));
        assert_eq!(list.upsert_server(blank(|s| s.host = "".into())), Err(invalid("Host is required")));
        assert_eq!(list.upsert_server(blank(|s| s.database = " ".into())), Err(invalid("Database is required")));
        assert_eq!(list.upsert_server(blank(|s| s.user = "".into())), Err(invalid("User is required")));
        assert_eq!(list.upsert_server(blank(|s| s.port = 0)), Err(invalid("Port must be between 1 and 65535")));
        assert!(list.servers.is_empty());
    }

    #[test]
    fn rejects_a_server_in_an_unknown_group() {
        let mut list = ServerList::default();
        list.upsert_group(GroupInput { id: None, name: "Orders platform".into() }).unwrap();
        let mut grouped = input("orders-prod");
        grouped.group_id = Some("missing".into());
        assert_eq!(list.upsert_server(grouped), Err(not_found("No group with id missing")));
    }

    #[test]
    fn editing_an_unknown_server_is_not_found() {
        let mut list = ServerList::default();
        let mut edit = input("ghost");
        edit.id = Some("missing".into());
        assert_eq!(list.upsert_server(edit.clone()), Err(not_found("No saved server with id missing")));
        edit.password = PasswordChange::Keep;
        assert_eq!(list.upsert_server(edit), Err(not_found("No saved server with id missing")));
        assert_eq!(list.find("missing"), Err(not_found("No saved server with id missing")));
    }

    #[test]
    fn deleting_a_server_removes_only_that_server() {
        let mut list = ServerList::default();
        let kept = list.upsert_server(input("orders-dev")).unwrap().id;
        let removed = list.upsert_server(input("orders-prod")).unwrap().id;

        list.delete_server(&removed).unwrap();

        assert_eq!(list.servers.iter().map(|server| server.id.clone()).collect::<Vec<_>>(), vec![kept]);
        assert_eq!(list.delete_server(&removed), Err(not_found(&format!("No saved server with id {removed}"))));
    }

    #[test]
    fn groups_are_created_renamed_and_validated() {
        let mut list = ServerList::default();
        let group = list.upsert_group(GroupInput { id: None, name: " Orders ".into() }).unwrap();
        assert_eq!(group.name, "Orders");

        let renamed = list.upsert_group(GroupInput { id: Some(group.id.clone()), name: "Orders platform".into() }).unwrap();

        assert_eq!(renamed, ServerGroup { id: group.id, name: "Orders platform".into() });
        assert_eq!(list.groups, vec![renamed]);
        assert_eq!(list.upsert_group(GroupInput { id: None, name: "".into() }), Err(invalid("Group name is required")));
        assert_eq!(
            list.upsert_group(GroupInput { id: Some("missing".into()), name: "Billing".into() }),
            Err(not_found("No group with id missing"))
        );
    }

    #[test]
    fn deleting_a_group_keeps_its_servers_without_a_group() {
        let mut list = ServerList::default();
        let group = list.upsert_group(GroupInput { id: None, name: "Orders platform".into() }).unwrap();
        let mut grouped = input("orders-prod");
        grouped.group_id = Some(group.id.clone());
        let server_id = list.upsert_server(grouped).unwrap().id;
        let ungrouped_id = list.upsert_server(input("orders-dev")).unwrap().id;

        list.delete_group(&group.id).unwrap();

        assert!(list.groups.is_empty());
        assert_eq!(list.find(&server_id).unwrap().group_id, None);
        assert_eq!(list.find(&ungrouped_id).unwrap().group_id, None);
        assert_eq!(list.delete_group(&group.id), Err(not_found(&format!("No group with id {}", group.id))));
    }
}
