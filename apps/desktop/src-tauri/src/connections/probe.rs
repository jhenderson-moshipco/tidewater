//! The step-by-step connection test: DNS, TCP, TLS, authentication, then the database itself.

use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::net::{TcpStream, lookup_host};
use tokio::time::timeout;
use ts_rs::TS;

use super::{ConnectParams, OpenError, describe, open, session_info};
use crate::servers::model::TlsMode;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "connections.ts")]
pub enum ProbeStep {
    Dns,
    Tcp,
    Tls,
    Auth,
    Database,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "connections.ts")]
pub enum StepOutcome {
    Passed,
    Failed,
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "connections.ts")]
pub struct ProbeResult {
    pub step: ProbeStep,
    pub outcome: StepOutcome,
    pub detail: String,
    pub elapsed_ms: u32,
}

fn result(step: ProbeStep, outcome: StepOutcome, detail: impl Into<String>, elapsed: Duration) -> ProbeResult {
    ProbeResult { step, outcome, detail: detail.into(), elapsed_ms: elapsed.as_millis().min(u32::MAX as u128) as u32 }
}

fn skip_remaining(results: &mut Vec<ProbeResult>, after: ProbeStep) {
    let order = [ProbeStep::Dns, ProbeStep::Tcp, ProbeStep::Tls, ProbeStep::Auth, ProbeStep::Database];
    let start = order.iter().position(|step| *step == after).map_or(order.len(), |index| index + 1);
    for step in &order[start..] {
        results.push(result(*step, StepOutcome::Skipped, "Not reached", Duration::ZERO));
    }
}

fn requires_tls(mode: TlsMode) -> bool {
    matches!(mode, TlsMode::Require | TlsMode::VerifyCa | TlsMode::VerifyFull)
}

/// Which step a failed connection attempt failed at, from its SQLSTATE and whether TLS caused it.
pub fn classify_failure(sqlstate: Option<&str>, tls_failure: bool) -> ProbeStep {
    if tls_failure {
        return ProbeStep::Tls;
    }
    match sqlstate {
        Some(code) if code.starts_with("28") => ProbeStep::Auth,
        Some(_) => ProbeStep::Database,
        None => ProbeStep::Auth,
    }
}

/// The TLS step's result once a connection succeeded.
pub fn tls_outcome(mode: TlsMode, encryption: Option<&str>) -> (StepOutcome, String) {
    match (encryption, mode) {
        (Some(version), TlsMode::VerifyCa) => (StepOutcome::Passed, format!("{version}, certificate chain verified")),
        (Some(version), TlsMode::VerifyFull) => (StepOutcome::Passed, format!("{version}, certificate and hostname verified")),
        (Some(version), _) => (StepOutcome::Passed, format!("{version}, certificate not checked")),
        (None, TlsMode::Disable) => (StepOutcome::Skipped, "Off for this server".into()),
        (None, TlsMode::Prefer) => (StepOutcome::Skipped, "The server doesn't offer TLS, so the connection isn't encrypted".into()),
        (None, _) => (StepOutcome::Failed, "The connection isn't encrypted".into()),
    }
}

pub async fn probe(params: &ConnectParams) -> Vec<ProbeResult> {
    let mut results = Vec::new();

    if params.host.starts_with('/') {
        results.push(result(ProbeStep::Dns, StepOutcome::Skipped, "Unix socket", Duration::ZERO));
        results.push(result(ProbeStep::Tcp, StepOutcome::Skipped, "Unix socket", Duration::ZERO));
    } else {
        let started = Instant::now();
        let address = match timeout(NETWORK_TIMEOUT, lookup_host((params.host.as_str(), params.port))).await {
            Ok(Ok(mut addresses)) => addresses.next(),
            Ok(Err(error)) => {
                results.push(result(ProbeStep::Dns, StepOutcome::Failed, error.to_string(), started.elapsed()));
                skip_remaining(&mut results, ProbeStep::Dns);
                return results;
            }
            Err(_) => None,
        };
        let Some(address) = address else {
            results.push(result(ProbeStep::Dns, StepOutcome::Failed, format!("Couldn't resolve {}", params.host), started.elapsed()));
            skip_remaining(&mut results, ProbeStep::Dns);
            return results;
        };
        results.push(result(ProbeStep::Dns, StepOutcome::Passed, address.ip().to_string(), started.elapsed()));

        let started = Instant::now();
        let tcp_failure = match timeout(NETWORK_TIMEOUT, TcpStream::connect(address)).await {
            Ok(Ok(_)) => None,
            Ok(Err(error)) => Some(error.to_string()),
            Err(_) => Some(format!("No answer from {address} after {} seconds", NETWORK_TIMEOUT.as_secs())),
        };
        if let Some(detail) = tcp_failure {
            results.push(result(ProbeStep::Tcp, StepOutcome::Failed, detail, started.elapsed()));
            skip_remaining(&mut results, ProbeStep::Tcp);
            return results;
        }
        results.push(result(ProbeStep::Tcp, StepOutcome::Passed, format!("Port {} open", params.port), started.elapsed()));
    }

    let started = Instant::now();
    match open(params).await {
        Ok((client, driver)) => {
            let elapsed = started.elapsed();
            match session_info(&client).await {
                Ok((version, encryption)) => {
                    let (tls_result, tls_detail) = tls_outcome(params.tls, encryption.as_deref());
                    results.push(result(ProbeStep::Tls, tls_result, tls_detail, elapsed));
                    results.push(result(ProbeStep::Auth, StepOutcome::Passed, format!("Signed in as {}", params.user), elapsed));
                    results.push(result(ProbeStep::Database, StepOutcome::Passed, format!("PostgreSQL {version}"), started.elapsed()));
                }
                Err(error) => {
                    results.push(result(ProbeStep::Tls, StepOutcome::Skipped, "Not checked", elapsed));
                    results.push(result(ProbeStep::Auth, StepOutcome::Passed, format!("Signed in as {}", params.user), elapsed));
                    results.push(result(ProbeStep::Database, StepOutcome::Failed, describe(&error), started.elapsed()));
                }
            }
            drop(client);
            driver.abort();
        }
        Err(OpenError::Setup(error)) => {
            results.push(result(ProbeStep::Tls, StepOutcome::Failed, error.to_string(), started.elapsed()));
            skip_remaining(&mut results, ProbeStep::Tls);
        }
        Err(OpenError::Postgres(error)) => {
            let detail = describe(&error);
            let sqlstate = error.as_db_error().map(|database_error| database_error.code().code().to_string());
            let failed = classify_failure(sqlstate.as_deref(), detail.to_lowercase().contains("tls"));
            let elapsed = started.elapsed();
            for step in [ProbeStep::Tls, ProbeStep::Auth, ProbeStep::Database] {
                if step == failed {
                    results.push(result(step, StepOutcome::Failed, detail.clone(), elapsed));
                    skip_remaining(&mut results, step);
                    break;
                }
                let earlier = match step {
                    ProbeStep::Tls if requires_tls(params.tls) => result(step, StepOutcome::Passed, "Negotiated", elapsed),
                    ProbeStep::Tls => result(step, StepOutcome::Skipped, "Not checked", elapsed),
                    _ => result(step, StepOutcome::Passed, format!("Signed in as {}", params.user), elapsed),
                };
                results.push(earlier);
            }
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::url::parse_connection_string;
    use crate::servers::model::SessionDefaults;

    #[test]
    fn tls_problems_fail_the_tls_step_whatever_the_sqlstate() {
        assert_eq!(classify_failure(None, true), ProbeStep::Tls);
        assert_eq!(classify_failure(Some("28P01"), true), ProbeStep::Tls);
    }

    #[test]
    fn class_28_errors_fail_authentication() {
        assert_eq!(classify_failure(Some("28P01"), false), ProbeStep::Auth);
        assert_eq!(classify_failure(Some("28000"), false), ProbeStep::Auth);
    }

    #[test]
    fn a_missing_database_and_other_server_errors_fail_the_database_step() {
        assert_eq!(classify_failure(Some("3D000"), false), ProbeStep::Database);
        assert_eq!(classify_failure(Some("53300"), false), ProbeStep::Database);
    }

    #[test]
    fn errors_without_a_sqlstate_are_treated_as_authentication_failures() {
        assert_eq!(classify_failure(None, false), ProbeStep::Auth);
    }

    #[test]
    fn prefer_without_server_tls_is_skipped_not_failed() {
        assert_eq!(tls_outcome(TlsMode::Prefer, None).0, StepOutcome::Skipped);
        assert_eq!(tls_outcome(TlsMode::Disable, None).0, StepOutcome::Skipped);
        assert_eq!(tls_outcome(TlsMode::Require, None).0, StepOutcome::Failed);
        assert_eq!(tls_outcome(TlsMode::VerifyFull, Some("TLSv1.3")).0, StepOutcome::Passed);
    }

    fn live_params() -> Option<ConnectParams> {
        let url = std::env::var("TIDEWATER_TEST_DATABASE_URL").ok()?;
        let parsed = parse_connection_string(&url).expect("TIDEWATER_TEST_DATABASE_URL should parse");
        Some(ConnectParams {
            host: parsed.host.unwrap_or_else(|| "localhost".into()),
            port: parsed.port.unwrap_or(5432),
            database: parsed.database.unwrap_or_else(|| "postgres".into()),
            user: parsed.user.unwrap_or_else(|| "postgres".into()),
            password: parsed.password,
            tls: parsed.tls.unwrap_or_default(),
            session: SessionDefaults::default(),
        })
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_probe_passes_every_step_it_runs() {
        let params = live_params().expect("set TIDEWATER_TEST_DATABASE_URL");
        let results = probe(&params).await;
        assert_eq!(results.len(), 5);
        assert!(results.iter().all(|step| step.outcome != StepOutcome::Failed), "{results:#?}");
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_probe_names_a_missing_database() {
        let mut params = live_params().expect("set TIDEWATER_TEST_DATABASE_URL");
        params.database = "tidewater_missing_database".into();
        let results = probe(&params).await;
        let failed: Vec<_> = results.iter().filter(|step| step.outcome == StepOutcome::Failed).collect();
        assert_eq!(failed.len(), 1, "{results:#?}");
        assert_eq!(failed[0].step, ProbeStep::Database);
    }
}
