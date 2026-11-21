//! Splits a pasted connection URL or key=value string into connection fields.

use std::str::FromStr;

use serde::Serialize;
use tokio_postgres::config::{Config, Host, SslMode};
use ts_rs::TS;

use crate::error::CommandError;
use crate::servers::model::TlsMode;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "connections.ts")]
pub struct ParsedConnection {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub tls: Option<TlsMode>,
}

fn tls_from_name(name: &str) -> Option<TlsMode> {
    match name {
        "disable" | "allow" => Some(TlsMode::Disable),
        "prefer" => Some(TlsMode::Prefer),
        "require" => Some(TlsMode::Require),
        "verify-ca" => Some(TlsMode::VerifyCa),
        "verify-full" => Some(TlsMode::VerifyFull),
        _ => None,
    }
}

/// tokio-postgres only parses disable, prefer and require, so the sslmode value is read here and dropped before parsing.
fn split_url_sslmode(input: &str) -> Result<(String, Option<TlsMode>), CommandError> {
    let mut url = url::Url::parse(input).map_err(|error| CommandError::Invalid(format!("Not a valid connection URL: {error}")))?;
    let mut tls = None;
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter_map(|(key, value)| {
            if key == "sslmode" {
                tls = tls_from_name(&value);
                None
            } else {
                Some((key.into_owned(), value.into_owned()))
            }
        })
        .collect();
    if kept.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(kept);
    }
    Ok((url.into(), tls))
}

/// Replaces a verify-ca or verify-full sslmode value with require so tokio-postgres accepts the string.
fn split_keyword_sslmode(input: &str) -> (String, Option<TlsMode>) {
    for (name, mode) in [("verify-full", TlsMode::VerifyFull), ("verify-ca", TlsMode::VerifyCa)] {
        for quoted in [format!("'{name}'"), name.to_string()] {
            for spacing in ["=", " = ", "= ", " ="] {
                let needle = format!("sslmode{spacing}{quoted}");
                if input.contains(&needle) {
                    return (input.replace(&needle, "sslmode=require"), Some(mode));
                }
            }
        }
    }
    (input.to_string(), None)
}

pub fn parse_connection_string(input: &str) -> Result<ParsedConnection, CommandError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(CommandError::Invalid("Paste a connection URL or key=value string".into()));
    }
    let is_url = trimmed.starts_with("postgres://") || trimmed.starts_with("postgresql://");
    let (parsable, requested_tls) = if is_url { split_url_sslmode(trimmed)? } else { split_keyword_sslmode(trimmed) };
    let config = Config::from_str(&parsable).map_err(|error| CommandError::Invalid(format!("Couldn't read the connection string: {error}")))?;

    let host = config.get_hosts().first().map(|host| match host {
        Host::Tcp(name) => name.clone(),
        #[cfg(unix)]
        Host::Unix(path) => path.display().to_string(),
    });
    let password = match config.get_password() {
        Some(bytes) => Some(String::from_utf8(bytes.to_vec()).map_err(|_| CommandError::Invalid("The password isn't valid UTF-8".into()))?),
        None => None,
    };
    let tls = requested_tls.or_else(|| {
        let mentions_sslmode = parsable.contains("sslmode");
        mentions_sslmode.then(|| match config.get_ssl_mode() {
            SslMode::Disable => TlsMode::Disable,
            SslMode::Require => TlsMode::Require,
            _ => TlsMode::Prefer,
        })
    });

    Ok(ParsedConnection {
        host,
        port: config.get_ports().first().copied(),
        database: config.get_dbname().map(str::to_string),
        user: config.get_user().map(str::to_string),
        password,
        tls,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_field_from_a_url_including_verify_full() {
        let parsed = parse_connection_string("postgres://app_user:s3cret@db.example.com:5433/orders?sslmode=verify-full&application_name=x").unwrap();
        assert_eq!(parsed.host.as_deref(), Some("db.example.com"));
        assert_eq!(parsed.port, Some(5433));
        assert_eq!(parsed.database.as_deref(), Some("orders"));
        assert_eq!(parsed.user.as_deref(), Some("app_user"));
        assert_eq!(parsed.password.as_deref(), Some("s3cret"));
        assert_eq!(parsed.tls, Some(TlsMode::VerifyFull));
    }

    #[test]
    fn accepts_the_postgresql_scheme_and_fills_the_default_port() {
        let parsed = parse_connection_string("postgresql://localhost/orders").unwrap();
        assert_eq!(parsed.host.as_deref(), Some("localhost"));
        assert_eq!(parsed.port, Some(5432));
        assert_eq!(parsed.user, None);
        assert_eq!(parsed.password, None);
        assert_eq!(parsed.tls, None);
    }

    #[test]
    fn decodes_percent_encoded_passwords() {
        let parsed = parse_connection_string("postgres://u:p%40ss%2Fword@h/db").unwrap();
        assert_eq!(parsed.password.as_deref(), Some("p@ss/word"));
    }

    #[test]
    fn reads_key_value_strings_with_a_quoted_verify_ca() {
        let parsed = parse_connection_string("host=db.example.com port=6432 dbname=orders user=app sslmode='verify-ca'").unwrap();
        assert_eq!(parsed.host.as_deref(), Some("db.example.com"));
        assert_eq!(parsed.port, Some(6432));
        assert_eq!(parsed.tls, Some(TlsMode::VerifyCa));
    }

    #[test]
    fn maps_require_and_disable_from_key_value_strings() {
        assert_eq!(parse_connection_string("host=h sslmode=require").unwrap().tls, Some(TlsMode::Require));
        assert_eq!(parse_connection_string("host=h sslmode=disable").unwrap().tls, Some(TlsMode::Disable));
    }

    #[test]
    fn rejects_empty_and_malformed_input() {
        assert!(matches!(parse_connection_string("   "), Err(CommandError::Invalid(_))));
        assert!(matches!(parse_connection_string("postgres://[bad"), Err(CommandError::Invalid(_))));
    }
}
