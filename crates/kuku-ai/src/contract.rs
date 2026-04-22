//! Connect-protocol client for the kuku AI service.
//!
//! Mirrors the pattern in `apps/desktop/src-tauri/src/contract_client.rs` but
//! lives here because `RemoteBackend::new(base_url, ...)` takes the URL at
//! construction — the AI provider URL is user-configurable in the desktop
//! settings UI and may differ from the auth endpoint.
//!
//! Each `RemoteBackend` owns one `AIServiceClient<HttpClient>`; the underlying
//! hyper transport pools connections internally so repeated `Complete` calls
//! reuse the same TLS session.
//!
//! TLS is enabled via the connectrpc `client-tls` feature with Mozilla root
//! certs from `webpki-roots`. Plaintext is used for `http://` URLs (dev).

use std::{sync::Arc, time::Duration};

use connectrpc::client::{ClientConfig, HttpClient};
use connectrpc::rustls::{ClientConfig as RustlsClientConfig, RootCertStore, crypto::aws_lc_rs};
use http::Uri;
use kuku_contract::connect::kuku::ai::v1::AiServiceClient;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

pub fn build_ai_service_client(base_url: &str) -> Result<AiServiceClient<HttpClient>, String> {
    let uri: Uri = base_url
        .parse()
        .map_err(|error| format!("invalid AI base URL '{base_url}': {error}"))?;
    let transport = build_transport(&uri);
    // Connect protocol + JSON codec — matches the auth client and keeps
    // server-side debug logs human-readable. Per-call timeout overrides via
    // `CallOptions::with_timeout` if a future tool needs a tighter bound.
    let config = ClientConfig::new(uri)
        .json()
        .default_timeout(REQUEST_TIMEOUT);
    Ok(AiServiceClient::new(transport, config))
}

fn build_transport(uri: &Uri) -> HttpClient {
    if uri.scheme_str() == Some("https") {
        let mut roots = RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let tls =
            RustlsClientConfig::builder_with_provider(Arc::new(aws_lc_rs::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("aws-lc-rs provider should support rustls default protocol versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
        HttpClient::with_tls(Arc::new(tls))
    } else {
        HttpClient::plaintext()
    }
}
