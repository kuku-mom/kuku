//! Connect-protocol clients wired to the `kuku-contract` crate.
//!
//! Centralizes transport setup (plaintext for `http://`, rustls + Mozilla
//! root certs for `https://`) and exposes typed service clients that the
//! rest of the crate uses instead of hand-rolled reqwest calls. Keeps wire
//! types in lockstep with the proto contract so a server-side rename can't
//! silently desync.

use std::{sync::Arc, sync::OnceLock, time::Duration};

use connectrpc::client::{ClientConfig, HttpClient};
use connectrpc::rustls::{ClientConfig as RustlsClientConfig, RootCertStore, crypto::aws_lc_rs};
use http::Uri;
use kuku_contract::connect::kuku::auth::v1::AuthServiceClient;
use kuku_contract::connect::kuku::sync::v1::SyncServiceClient;

use crate::config;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

// The client is initialized lazily on first call. A malformed `KUKU_API_URL`
// used to panic the entire app here; surfacing the parse error through
// `Result` lets the caller turn it into a regular command failure that
// propagates to the UI instead of crashing the process.
static AUTH_CLIENT: OnceLock<Result<AuthServiceClient<HttpClient>, String>> = OnceLock::new();
#[allow(dead_code)]
static SYNC_CLIENT: OnceLock<Result<SyncServiceClient<HttpClient>, String>> = OnceLock::new();

pub fn auth_service_client() -> Result<&'static AuthServiceClient<HttpClient>, String> {
    let cached = AUTH_CLIENT.get_or_init(|| {
        let (transport, config) = build_client_config()?;
        Ok(AuthServiceClient::new(transport, config))
    });
    cached.as_ref().map_err(|error| error.clone())
}

#[allow(dead_code)]
pub fn sync_service_client() -> Result<&'static SyncServiceClient<HttpClient>, String> {
    let cached = SYNC_CLIENT.get_or_init(|| {
        let (transport, config) = build_client_config()?;
        Ok(SyncServiceClient::new(transport, config))
    });
    cached.as_ref().map_err(|error| error.clone())
}

fn build_client_config() -> Result<(HttpClient, ClientConfig), String> {
    let raw = config::api_url();
    let uri: Uri = raw
        .parse()
        .map_err(|error| format!("Invalid KUKU_API_URL '{raw}': {error}"))?;
    let transport = build_transport(&uri);
    // Connect protocol + JSON codec — server accepts both, JSON keeps
    // wire-level debugging trivial (curl, server logs read as text).
    let config = ClientConfig::new(uri)
        .json()
        .default_timeout(REQUEST_TIMEOUT);
    Ok((transport, config))
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
