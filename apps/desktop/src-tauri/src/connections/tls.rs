//! TLS for each sslmode. prefer and require encrypt without checking the certificate, as libpq does;
//! verify-ca checks the chain against the OS roots; verify-full also checks the hostname.

use std::sync::{Arc, OnceLock};

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use tokio_postgres::config::SslMode;
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::servers::model::TlsMode;

fn provider() -> Arc<CryptoProvider> {
    static PROVIDER: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    PROVIDER.get_or_init(|| Arc::new(rustls::crypto::ring::default_provider())).clone()
}

fn os_roots() -> Arc<RootCertStore> {
    static ROOTS: OnceLock<Arc<RootCertStore>> = OnceLock::new();
    ROOTS
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
            Arc::new(roots)
        })
        .clone()
}

#[derive(Debug)]
struct Verifier {
    /// `None` when the certificate isn't checked; an error when the trusted roots couldn't be loaded.
    chain: Option<Result<Arc<WebPkiServerVerifier>, String>>,
    check_hostname: bool,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let Some(chain) = &self.chain else {
            return Ok(ServerCertVerified::assertion());
        };
        let webpki = chain.as_ref().map_err(|reason| rustls::Error::General(reason.clone()))?;
        let verified = webpki.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now);
        let only_the_name_differs = matches!(
            &verified,
            Err(rustls::Error::InvalidCertificate(CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. }))
        );
        if only_the_name_differs && !self.check_hostname { Ok(ServerCertVerified::assertion()) } else { verified }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

fn verifier(mode: TlsMode, roots: impl FnOnce() -> Arc<RootCertStore>) -> Verifier {
    let provider = provider();
    let chain = matches!(mode, TlsMode::VerifyCa | TlsMode::VerifyFull).then(|| {
        WebPkiServerVerifier::builder_with_provider(roots(), provider.clone())
            .build()
            .map_err(|error| format!("Couldn't load the system's trusted certificates: {error}"))
    });
    Verifier { chain, check_hostname: mode == TlsMode::VerifyFull, algorithms: provider.signature_verification_algorithms }
}

/// The tokio-postgres sslmode to request for a Tidewater TLS mode.
pub fn ssl_mode(mode: TlsMode) -> SslMode {
    match mode {
        TlsMode::Disable => SslMode::Disable,
        TlsMode::Prefer => SslMode::Prefer,
        TlsMode::Require | TlsMode::VerifyCa | TlsMode::VerifyFull => SslMode::Require,
    }
}

pub fn connector(mode: TlsMode) -> MakeRustlsConnect {
    let config = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .expect("the ring provider supports TLS 1.2 and 1.3")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier(mode, os_roots)))
        .with_no_client_auth();
    MakeRustlsConnect::new(config)
}

#[cfg(test)]
mod tests {
    use std::net::{TcpListener, TcpStream};

    use rcgen::{BasicConstraints, Certificate, CertificateParams, IsCa, Issuer, KeyPair};
    use rustls::pki_types::PrivatePkcs8KeyDer;
    use rustls::{ClientConnection, ServerConfig, ServerConnection, SupportedProtocolVersion};

    use super::*;

    struct Identity {
        cert: Certificate,
        key: KeyPair,
    }

    fn leaf(hostname: &str, issuer: Option<&Issuer<'_, KeyPair>>) -> Identity {
        let key = KeyPair::generate().unwrap();
        let params = CertificateParams::new(vec![hostname.to_string()]).unwrap();
        let cert = match issuer {
            Some(issuer) => params.signed_by(&key, issuer).unwrap(),
            None => params.self_signed(&key).unwrap(),
        };
        Identity { cert, key }
    }

    fn authority() -> (Issuer<'static, KeyPair>, Arc<RootCertStore>) {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let cert = params.self_signed(&key).unwrap();
        let mut roots = RootCertStore::empty();
        roots.add(cert.der().clone()).unwrap();
        (Issuer::new(params, key), Arc::new(roots))
    }

    fn no_roots() -> Arc<RootCertStore> {
        Arc::new(RootCertStore::empty())
    }

    /// Runs a real handshake against a local server presenting `identity`, connecting as db.internal.
    fn handshake(verifier: Verifier, version: &'static SupportedProtocolVersion, identity: &Identity) -> Result<(), String> {
        let server_config = ServerConfig::builder_with_provider(provider())
            .with_protocol_versions(&[version])
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![identity.cert.der().clone()], PrivatePkcs8KeyDer::from(identity.key.serialize_der()).into())
            .unwrap();
        let client_config = ClientConfig::builder_with_provider(provider())
            .with_protocol_versions(&[version])
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut connection = ServerConnection::new(Arc::new(server_config)).unwrap();
            let _ = connection.complete_io(&mut socket);
        });
        let mut socket = TcpStream::connect(address).unwrap();
        let mut connection = ClientConnection::new(Arc::new(client_config), ServerName::try_from("db.internal").unwrap()).unwrap();
        let result = connection.complete_io(&mut socket).map(|_| ()).map_err(|error| error.to_string());
        drop(socket);
        server.join().unwrap();
        result
    }

    #[test]
    fn every_mode_but_disable_asks_the_server_for_tls() {
        assert_eq!(ssl_mode(TlsMode::Disable), SslMode::Disable);
        assert_eq!(ssl_mode(TlsMode::Prefer), SslMode::Prefer);
        assert_eq!(ssl_mode(TlsMode::Require), SslMode::Require);
        assert_eq!(ssl_mode(TlsMode::VerifyCa), SslMode::Require);
        assert_eq!(ssl_mode(TlsMode::VerifyFull), SslMode::Require);
    }

    #[test]
    fn require_encrypts_with_any_certificate_over_tls_12_and_13() {
        let untrusted = leaf("elsewhere.internal", None);
        assert_eq!(handshake(verifier(TlsMode::Require, no_roots), &rustls::version::TLS12, &untrusted), Ok(()));
        assert_eq!(handshake(verifier(TlsMode::Prefer, no_roots), &rustls::version::TLS13, &untrusted), Ok(()));
    }

    #[test]
    fn verify_ca_accepts_a_trusted_chain_for_another_hostname() {
        let (issuer, roots) = authority();
        let other_host = leaf("elsewhere.internal", Some(&issuer));
        assert_eq!(handshake(verifier(TlsMode::VerifyCa, || roots), &rustls::version::TLS13, &other_host), Ok(()));
    }

    #[test]
    fn verify_full_needs_a_trusted_chain_for_the_hostname() {
        let (issuer, roots) = authority();
        let matching = leaf("db.internal", Some(&issuer));
        let other_host = leaf("elsewhere.internal", Some(&issuer));
        assert_eq!(handshake(verifier(TlsMode::VerifyFull, || roots.clone()), &rustls::version::TLS12, &matching), Ok(()));
        let refused = handshake(verifier(TlsMode::VerifyFull, || roots), &rustls::version::TLS13, &other_host).unwrap_err();
        assert!(refused.contains("not valid for name"), "{refused}");
    }

    #[test]
    fn verify_ca_refuses_a_certificate_from_an_untrusted_issuer() {
        let (_issuer, roots) = authority();
        let refused = handshake(verifier(TlsMode::VerifyCa, || roots), &rustls::version::TLS13, &leaf("db.internal", None)).unwrap_err();
        assert!(refused.starts_with("invalid peer certificate: "), "{refused}");
    }

    #[test]
    fn without_trusted_roots_verify_modes_fail_with_the_reason() {
        let refused = handshake(verifier(TlsMode::VerifyFull, no_roots), &rustls::version::TLS13, &leaf("db.internal", None)).unwrap_err();
        assert!(refused.contains("Couldn't load the system's trusted certificates: "), "{refused}");
    }

    #[test]
    fn a_connector_builds_for_every_mode() {
        for mode in [TlsMode::Disable, TlsMode::Prefer, TlsMode::Require, TlsMode::VerifyCa, TlsMode::VerifyFull] {
            connector(mode);
        }
    }
}
