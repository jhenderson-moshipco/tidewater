//! The step-by-step connection test: DNS, TCP, TLS, authentication, then the database itself.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::net::{TcpStream, lookup_host};
use tokio::time::error::Elapsed;
use tokio::time::timeout;
use ts_rs::TS;

use super::{ConnectParams, describe, open, session_info};
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

/// The address to connect to, or the DNS step's failure, for a lookup of `host`.
fn resolved<I: Iterator<Item = SocketAddr>>(lookup: Result<std::io::Result<I>, Elapsed>, host: &str) -> Result<SocketAddr, String> {
    match lookup {
        Ok(Ok(mut addresses)) => addresses.next().ok_or(format!("Couldn't resolve {host}")),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err(format!("Couldn't resolve {host}")),
    }
}

/// The TCP step's failure, if any, for a connect attempt that had `limit` to finish.
fn tcp_failure(attempt: Result<std::io::Result<TcpStream>, Elapsed>, address: SocketAddr, limit: Duration) -> Option<String> {
    match attempt {
        Ok(Ok(_)) => None,
        Ok(Err(error)) => Some(error.to_string()),
        Err(_) => Some(format!("No answer from {address} after {} seconds", limit.as_secs())),
    }
}

pub async fn probe(params: &ConnectParams) -> Vec<ProbeResult> {
    let mut results = Vec::new();

    if params.host.starts_with('/') {
        results.push(result(ProbeStep::Dns, StepOutcome::Skipped, "Unix socket", Duration::ZERO));
        results.push(result(ProbeStep::Tcp, StepOutcome::Skipped, "Unix socket", Duration::ZERO));
    } else {
        let started = Instant::now();
        let lookup = timeout(NETWORK_TIMEOUT, lookup_host((params.host.as_str(), params.port))).await;
        let address = match resolved(lookup, &params.host) {
            Ok(address) => address,
            Err(detail) => {
                results.push(result(ProbeStep::Dns, StepOutcome::Failed, detail, started.elapsed()));
                skip_remaining(&mut results, ProbeStep::Dns);
                return results;
            }
        };
        results.push(result(ProbeStep::Dns, StepOutcome::Passed, address.ip().to_string(), started.elapsed()));

        let started = Instant::now();
        if let Some(detail) = tcp_failure(timeout(NETWORK_TIMEOUT, TcpStream::connect(address)).await, address, NETWORK_TIMEOUT) {
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
        Err(error) => {
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
    use crate::testing::{FakeServer, closed_port, fake_server, live_params};

    type Outline = Vec<(ProbeStep, StepOutcome, String)>;

    fn outline(results: Vec<ProbeResult>) -> Outline {
        results.into_iter().map(|step| (step.step, step.outcome, step.detail)).collect()
    }

    fn step(step: ProbeStep, outcome: StepOutcome, detail: &str) -> (ProbeStep, StepOutcome, String) {
        (step, outcome, detail.to_string())
    }

    fn not_reached(steps: &[ProbeStep]) -> Outline {
        steps.iter().map(|skipped| step(*skipped, StepOutcome::Skipped, "Not reached")).collect()
    }

    fn reached_the_server() -> Outline {
        vec![step(ProbeStep::Dns, StepOutcome::Passed, "127.0.0.1"), (ProbeStep::Tcp, StepOutcome::Passed, String::new())]
    }

    /// The outline with the TCP step's port-specific detail blanked.
    fn without_port(results: Vec<ProbeResult>) -> Outline {
        outline(results)
            .into_iter()
            .map(|(probe_step, outcome, detail)| (probe_step, outcome, if probe_step == ProbeStep::Tcp { String::new() } else { detail }))
            .collect()
    }

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
    fn the_tls_step_says_how_much_was_verified() {
        let passed = |detail: &str| (StepOutcome::Passed, detail.to_string());
        assert_eq!(tls_outcome(TlsMode::VerifyCa, Some("TLSv1.3")), passed("TLSv1.3, certificate chain verified"));
        assert_eq!(tls_outcome(TlsMode::VerifyFull, Some("TLSv1.3")), passed("TLSv1.3, certificate and hostname verified"));
        assert_eq!(tls_outcome(TlsMode::Require, Some("TLSv1.2")), passed("TLSv1.2, certificate not checked"));
    }

    #[test]
    fn an_unencrypted_session_is_skipped_unless_tls_was_required() {
        assert_eq!(tls_outcome(TlsMode::Disable, None), (StepOutcome::Skipped, "Off for this server".to_string()));
        assert_eq!(
            tls_outcome(TlsMode::Prefer, None),
            (StepOutcome::Skipped, "The server doesn't offer TLS, so the connection isn't encrypted".to_string())
        );
        assert_eq!(tls_outcome(TlsMode::Require, None), (StepOutcome::Failed, "The connection isn't encrypted".to_string()));
    }

    #[tokio::test]
    async fn an_unresolvable_host_fails_at_dns() {
        let mut params = closed_port().await;
        params.host = "tidewater.invalid".into();

        let results = outline(probe(&params).await);

        assert_eq!(results[0].1, StepOutcome::Failed);
        assert_eq!(results[1..], not_reached(&[ProbeStep::Tcp, ProbeStep::Tls, ProbeStep::Auth, ProbeStep::Database]));
    }

    #[tokio::test]
    async fn a_dns_lookup_that_fails_runs_out_of_time_or_finds_nothing_fails_at_dns() {
        type Lookup = Result<std::io::Result<std::vec::IntoIter<SocketAddr>>, Elapsed>;
        let failed: Lookup = Ok(Err(std::io::Error::other("no such host")));
        let timed_out: Lookup = timeout(Duration::ZERO, std::future::pending()).await;
        let nothing: Lookup = Ok(Ok(Vec::new().into_iter()));

        assert_eq!(resolved(failed, "db.internal"), Err("no such host".into()));
        assert_eq!(resolved(timed_out, "db.internal"), Err("Couldn't resolve db.internal".into()));
        assert_eq!(resolved(nothing, "db.internal"), Err("Couldn't resolve db.internal".into()));
    }

    #[tokio::test]
    async fn a_closed_port_fails_at_tcp() {
        let results = outline(probe(&closed_port().await).await);

        assert_eq!(results[0], step(ProbeStep::Dns, StepOutcome::Passed, "127.0.0.1"));
        assert_eq!(results[1].1, StepOutcome::Failed);
        assert_eq!(results[2..], not_reached(&[ProbeStep::Tls, ProbeStep::Auth, ProbeStep::Database]));
    }

    #[tokio::test]
    async fn a_tcp_connect_that_runs_out_of_time_fails_at_tcp() {
        let attempt = timeout(Duration::ZERO, std::future::pending::<std::io::Result<TcpStream>>()).await;
        let address = SocketAddr::from(([192, 0, 2, 1], 5432));

        let detail = tcp_failure(attempt, address, Duration::from_secs(5));

        assert_eq!(detail.as_deref(), Some("No answer from 192.0.2.1:5432 after 5 seconds"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_unix_socket_skips_dns_and_tcp() {
        let mut params = closed_port().await;
        params.host = "/tidewater-missing-socket-directory".into();

        let results = outline(probe(&params).await);

        assert_eq!(results[..3], [
            step(ProbeStep::Dns, StepOutcome::Skipped, "Unix socket"),
            step(ProbeStep::Tcp, StepOutcome::Skipped, "Unix socket"),
            step(ProbeStep::Tls, StepOutcome::Skipped, "Not checked"),
        ]);
        assert_eq!(results[3].1, StepOutcome::Failed);
    }

    #[tokio::test]
    async fn a_rejected_sign_in_fails_at_auth() {
        let results = without_port(probe(&fake_server(FakeServer::RejectStartup("28P01")).await).await);

        let mut expected = reached_the_server();
        expected.push(step(ProbeStep::Tls, StepOutcome::Skipped, "Not checked"));
        expected.push(step(ProbeStep::Auth, StepOutcome::Failed, "rejected"));
        expected.extend(not_reached(&[ProbeStep::Database]));
        assert_eq!(results, expected);
    }

    #[tokio::test]
    async fn a_missing_database_fails_after_sign_in() {
        let results = without_port(probe(&fake_server(FakeServer::RejectStartup("3D000")).await).await);

        let mut expected = reached_the_server();
        expected.push(step(ProbeStep::Tls, StepOutcome::Skipped, "Not checked"));
        expected.push(step(ProbeStep::Auth, StepOutcome::Passed, "Signed in as tidewater"));
        expected.push(step(ProbeStep::Database, StepOutcome::Failed, "rejected"));
        assert_eq!(results, expected);
    }

    #[tokio::test]
    async fn a_failing_first_query_fails_at_the_database() {
        let results = without_port(probe(&fake_server(FakeServer::FailFirstQuery).await).await);

        let mut expected = reached_the_server();
        expected.push(step(ProbeStep::Tls, StepOutcome::Skipped, "Not checked"));
        expected.push(step(ProbeStep::Auth, StepOutcome::Passed, "Signed in as tidewater"));
        expected.push(step(ProbeStep::Database, StepOutcome::Failed, "query failed (from the fake server)"));
        assert_eq!(results, expected);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_probe_passes_every_step_it_runs() {
        let results = probe(&live_params()).await;
        assert_eq!(results.len(), 5);
        assert!(results.iter().all(|step| step.outcome != StepOutcome::Failed), "{results:#?}");
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_probe_names_a_missing_database() {
        let mut params = live_params();
        params.database = "tidewater_missing_database".into();

        let results = outline(probe(&params).await);

        assert_eq!(results[4].0, ProbeStep::Database);
        assert_eq!(results[4].1, StepOutcome::Failed);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_probe_with_a_wrong_password_negotiates_tls_then_fails_auth() {
        let mut params = live_params();
        params.tls = TlsMode::Require;
        params.password = Some("not the password".into());

        let results = outline(probe(&params).await);

        assert_eq!(results[2], step(ProbeStep::Tls, StepOutcome::Passed, "Negotiated"));
        assert_eq!(results[3].1, StepOutcome::Failed);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_probe_with_verify_full_fails_tls_for_an_untrusted_certificate() {
        let mut params = live_params();
        params.tls = TlsMode::VerifyFull;

        let results = outline(probe(&params).await);

        assert_eq!((results[2].0, results[2].1), (ProbeStep::Tls, StepOutcome::Failed));
    }
}
