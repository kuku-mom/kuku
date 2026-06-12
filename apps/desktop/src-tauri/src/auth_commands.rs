use serde::Serialize;
use std::{
    fmt,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{OnceLock, mpsc},
    thread,
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter, command};
use tauri_plugin_opener::OpenerExt;

use connectrpc::{ErrorCode, client::CallOptions};
use kuku_contract::proto::kuku::auth::v1::{
    DesktopAuthURLRequest, ExchangeDesktopTokenRequest, ProfileRequest, RefreshDesktopTokenRequest,
};

use crate::{auth, contract_client};

const DEV_CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);
static TOKEN_REFRESH_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RefreshMode {
    IfExpiresSoon,
    Force,
}

#[derive(Debug)]
struct RefreshDesktopTokenError {
    message: String,
    clears_auth: bool,
}

impl fmt::Display for RefreshDesktopTokenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for RefreshDesktopTokenError {}

#[derive(Debug, Serialize)]
pub struct User {
    pub email: String,
}

#[derive(Debug, Serialize)]
pub struct AuthorizationHeaders {
    #[serde(rename = "Authorization")]
    pub authorization: String,
}

#[command]
pub fn auth_check_status() -> Result<bool, String> {
    auth::has_tokens().map_err(|error| error.to_string())
}

#[command]
pub async fn auth_get_user() -> Result<Option<User>, String> {
    // Returns the cached profile written by `fetch_and_cache_profile` after
    // each successful login. Avoids decoding the JWT locally — that would
    // require trusting the (unverified) token contents for display, and
    // verifying the HS256 signature client-side is impossible without
    // shipping the server's signing secret.
    if let Some(cached) = auth::read_profile().map_err(|error| error.to_string())? {
        return Ok(Some(User {
            email: cached.email,
        }));
    }
    // Cache miss but tokens exist (e.g. user upgraded from a build that
    // stored tokens but had no profile cache yet) — fetch on demand so the
    // UI doesn't show an empty header for the rest of the session.
    if !auth::has_tokens().map_err(|error| error.to_string())? {
        return Ok(None);
    }
    if let Err(error) = fetch_and_cache_profile().await {
        eprintln!("desktop auth profile fetch on demand failed: {error}");
        return Ok(None);
    }
    Ok(auth::read_profile()
        .map_err(|error| error.to_string())?
        .map(|cached| User {
            email: cached.email,
        }))
}

#[command]
pub fn auth_logout() -> Result<(), String> {
    auth::clear_tokens().map_err(|error| error.to_string())
}

#[command]
pub fn auth_reset() -> Result<(), String> {
    auth::reset_auth_state().map_err(|error| error.to_string())
}

#[command]
pub async fn auth_refresh() -> Result<(), String> {
    refresh_stored_tokens(RefreshMode::Force)
        .await?
        .ok_or_else(|| auth::TokenError::NotFound.to_string())
        .map(|_| ())
}

#[command]
pub fn auth_list_plugin_authorizations() -> Result<Vec<auth::PluginAuthorization>, String> {
    auth::list_plugin_authorizations().map_err(|error| error.to_string())
}

#[command]
pub fn auth_set_plugin_authorized(plugin_id: String, authorized: bool) -> Result<(), String> {
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() {
        return Err("plugin_id is required".to_string());
    }
    auth::set_plugin_authorized(plugin_id, authorized).map_err(|error| error.to_string())
}

#[command]
pub async fn auth_authorization_headers(
    plugin_id: String,
) -> Result<Option<AuthorizationHeaders>, String> {
    Ok(authorization_header_for_plugin(&plugin_id)
        .await?
        .map(|authorization| AuthorizationHeaders { authorization }))
}

#[command]
pub async fn auth_open_login(app: AppHandle) -> Result<(), String> {
    let mut auth_url = request_desktop_auth_url().await?;
    let state = extract_query_param(&auth_url, "state")
        .ok_or_else(|| "desktop auth URL did not include state".to_string())?;
    auth::store_pending_state(&state);

    if cfg!(debug_assertions)
        && let Some(callback_url) = start_dev_callback_server(app.clone())
    {
        auth_url = append_query_param(&auth_url, "desktop_callback", &callback_url);
    }

    app.opener()
        .open_url(&auth_url, None::<String>)
        .map_err(|error| format!("failed to open login page: {error}"))
}

pub async fn handle_auth_deep_link(app: &AppHandle, token: &str, state: &str) {
    match complete_auth_deep_link(token, state).await {
        Ok(()) => emit_auth_success(app),
        Err(error) => emit_auth_error(app, &format!("Authentication failed: {error}")),
    }
}

async fn complete_auth_deep_link(token: &str, state: &str) -> Result<(), String> {
    if !auth::validate_auth_state(state) {
        return Err("invalid state".to_string());
    }

    let stored = exchange_desktop_token(token, state).await?;
    auth::replace_tokens(stored)
        .map_err(|error| format!("failed to store authentication tokens: {error}"))?;

    // Profile fetch must happen after token storage so the request can use
    // the freshly-issued access token. A failure here is non-fatal — the
    // user is still logged in; the UI will just show no email until the
    // next refresh succeeds.
    if let Err(error) = fetch_and_cache_profile().await {
        eprintln!("desktop auth profile fetch failed: {error}");
    }
    Ok(())
}

fn emit_auth_success(app: &AppHandle) {
    let _ = app.emit(
        "auth://success",
        serde_json::json!({ "message": "Authentication successful" }),
    );
}

fn emit_auth_error(app: &AppHandle, message: &str) {
    let _ = app.emit("auth://error", serde_json::json!({ "message": message }));
}

fn start_dev_callback_server(app: AppHandle) -> Option<String> {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("desktop auth dev callback bind failed: {error}");
            return None;
        }
    };
    let callback_url = match listener.local_addr() {
        Ok(address) => format!("http://{address}/auth"),
        Err(error) => {
            eprintln!("desktop auth dev callback address lookup failed: {error}");
            return None;
        }
    };
    thread::spawn(move || {
        if let Err(error) = run_dev_callback_server(app, listener) {
            eprintln!("desktop auth dev callback failed: {error}");
        }
    });
    Some(callback_url)
}

fn run_dev_callback_server(app: AppHandle, listener: TcpListener) -> Result<(), String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("failed to configure auth callback listener: {error}"))?;

    let deadline = Instant::now() + DEV_CALLBACK_TIMEOUT;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => return handle_dev_callback_request(&app, &mut stream),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("timed out waiting for desktop auth callback".to_string());
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(format!("failed to accept desktop auth callback: {error}")),
        }
    }
}

fn handle_dev_callback_request(app: &AppHandle, stream: &mut TcpStream) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| format!("failed to configure auth callback stream: {error}"))?;

    let mut buffer = [0_u8; 4096];
    let len = stream
        .read(&mut buffer)
        .map_err(|error| format!("failed to read desktop auth callback: {error}"))?;
    let request = String::from_utf8_lossy(&buffer[..len]);
    let request_line = request.lines().next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();

    if method != "GET" {
        return write_http_response(stream, "405 Method Not Allowed", "Unsupported method.");
    }

    let token = extract_query_param(target, "token");
    let state = extract_query_param(target, "state");
    let Some((token, state)) = token.zip(state) else {
        return write_http_response(stream, "400 Bad Request", "Missing authentication token.");
    };

    let (tx, rx) = mpsc::channel();
    tauri::async_runtime::spawn(async move {
        let result = complete_auth_deep_link(&token, &state).await;
        let _ = tx.send(result);
    });

    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(())) => {
            emit_auth_success(app);
            write_http_response(
                stream,
                "200 OK",
                "Authentication complete. You can return to Kuku.",
            )
        }
        Ok(Err(error)) => {
            emit_auth_error(app, &format!("Authentication failed: {error}"));
            write_http_response(
                stream,
                "500 Internal Server Error",
                &format!("Authentication failed: {error}"),
            )
        }
        Err(error) => {
            emit_auth_error(app, &format!("Authentication timed out: {error}"));
            write_http_response(stream, "504 Gateway Timeout", "Authentication timed out.")
        }
    }
}

fn write_http_response(stream: &mut TcpStream, status: &str, body: &str) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|error| format!("failed to write desktop auth callback response: {error}"))
}

async fn request_desktop_auth_url() -> Result<String, String> {
    let response = contract_client::auth_service_client()?
        .desktop_auth_url(DesktopAuthURLRequest::default())
        .await
        .map_err(|error| format!("failed to request desktop auth URL: {error}"))?
        .into_owned();
    response
        .auth_url
        .ok_or_else(|| "desktop auth URL response missing url".to_string())
}

async fn exchange_desktop_token(token: &str, state: &str) -> Result<auth::StoredTokens, String> {
    let request = ExchangeDesktopTokenRequest {
        token: Some(token.to_string()),
        state: Some(state.to_string()),
        ..Default::default()
    };
    let response = contract_client::auth_service_client()?
        .exchange_desktop_token(request)
        .await
        .map_err(|error| format!("failed to exchange desktop token: {error}"))?
        .into_owned();
    Ok(stored_tokens_from(
        response.access_token,
        response.refresh_token,
        response.expires_in,
    ))
}

async fn fetch_and_cache_profile() -> Result<(), String> {
    let tokens = auth::read_tokens().map_err(|error| error.to_string())?;
    if tokens.access_token.is_empty() {
        return Err("no access token available".to_string());
    }
    let options = CallOptions::default()
        .with_header("authorization", format!("Bearer {}", tokens.access_token));
    let response = contract_client::auth_service_client()?
        .profile_with_options(ProfileRequest::default(), options)
        .await
        .map_err(|error| format!("failed to request profile: {error}"))?
        .into_owned();
    // `MessageField` derefs to a default-instance `User` when unset, so an
    // unset email falls through the same `is_empty` check as a present-but-
    // blank one — both indicate a malformed server response.
    let email = response.user.email.clone().unwrap_or_default();
    if email.is_empty() {
        return Err("profile response missing email".to_string());
    }
    auth::write_profile(&auth::CachedProfile {
        email,
        fetched_at: auth::format_rfc3339(SystemTime::now()),
    })
    .map_err(|error| format!("failed to cache profile: {error}"))
}

fn token_refresh_lock() -> &'static tokio::sync::Mutex<()> {
    TOKEN_REFRESH_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn read_available_tokens() -> Result<Option<auth::StoredTokens>, String> {
    match auth::read_tokens() {
        Ok(tokens) if !tokens.access_token.is_empty() && !tokens.refresh_token.is_empty() => {
            Ok(Some(tokens))
        }
        Ok(_) | Err(auth::TokenError::NotFound) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

async fn refresh_stored_tokens(mode: RefreshMode) -> Result<Option<auth::StoredTokens>, String> {
    let Some(observed) = read_available_tokens()? else {
        return Ok(None);
    };
    if mode == RefreshMode::IfExpiresSoon && !auth::token_expires_soon(&observed) {
        return Ok(Some(observed));
    }

    let _guard = token_refresh_lock().lock().await;
    let Some(current) = read_available_tokens()? else {
        return Ok(None);
    };
    if current.refresh_token != observed.refresh_token {
        return Ok(Some(current));
    }
    if mode == RefreshMode::IfExpiresSoon && !auth::token_expires_soon(&current) {
        return Ok(Some(current));
    }

    match refresh_desktop_token(&current.refresh_token).await {
        Ok(refreshed) => {
            let replaced = auth::replace_tokens_if_refresh_token_matches(
                &current.refresh_token,
                refreshed.clone(),
            )
            .map_err(|error| error.to_string())?;
            if replaced {
                return Ok(Some(refreshed));
            }
            read_available_tokens()
        }
        Err(error) => {
            if error.clears_auth {
                auth::clear_tokens_if_refresh_token_matches(&current.refresh_token)
                    .map_err(|storage_error| storage_error.to_string())?;
            }
            Err(error.to_string())
        }
    }
}

async fn refresh_desktop_token(
    refresh_token: &str,
) -> Result<auth::StoredTokens, RefreshDesktopTokenError> {
    let request = RefreshDesktopTokenRequest {
        refresh_token: Some(refresh_token.to_string()),
        ..Default::default()
    };
    let response = contract_client::auth_service_client()
        .map_err(refresh_desktop_token_state_error)?
        .refresh_desktop_token(request)
        .await
        .map_err(refresh_desktop_token_error)?
        .into_owned();
    Ok(stored_tokens_from(
        response.access_token,
        response.refresh_token,
        response.expires_in,
    ))
}

fn refresh_desktop_token_state_error(error: String) -> RefreshDesktopTokenError {
    RefreshDesktopTokenError {
        message: error,
        clears_auth: false,
    }
}

fn refresh_desktop_token_error(error: connectrpc::ConnectError) -> RefreshDesktopTokenError {
    RefreshDesktopTokenError {
        clears_auth: matches!(error.code, ErrorCode::Unauthenticated),
        message: format!("failed to refresh desktop token: {error}"),
    }
}

fn stored_tokens_from(
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
) -> auth::StoredTokens {
    let expires_in_secs = expires_in.unwrap_or(0).max(0) as u64;
    auth::StoredTokens {
        access_token: access_token.unwrap_or_default(),
        refresh_token: refresh_token.unwrap_or_default(),
        expires_at: auth::format_rfc3339(SystemTime::now() + Duration::from_secs(expires_in_secs)),
    }
}

pub async fn authorization_header_for_plugin(plugin_id: &str) -> Result<Option<String>, String> {
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() {
        return Err("plugin_id is required".to_string());
    }
    if !auth::is_plugin_authorized(plugin_id).map_err(|error| error.to_string())? {
        return Ok(None);
    }

    let Some(tokens) = refresh_stored_tokens(RefreshMode::IfExpiresSoon).await? else {
        return Ok(None);
    };
    if tokens.access_token.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!("Bearer {}", tokens.access_token)))
}

/// Always-refresh variant invoked after a 401 from the server. Skips the
/// 60s expiry buffer because the server has already rejected the token.
pub async fn refresh_authorization_header_for_plugin(
    plugin_id: &str,
) -> Result<Option<String>, String> {
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() {
        return Err("plugin_id is required".to_string());
    }
    if !auth::is_plugin_authorized(plugin_id).map_err(|error| error.to_string())? {
        return Ok(None);
    }

    let Some(refreshed) = refresh_stored_tokens(RefreshMode::Force).await? else {
        return Ok(None);
    };
    if refreshed.access_token.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!("Bearer {}", refreshed.access_token)))
}

fn extract_query_param(input: &str, key: &str) -> Option<String> {
    let (_, raw_query) = input.split_once('?')?;
    let query = raw_query
        .split_once('#')
        .map_or(raw_query, |(query, _)| query);
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            return Some(percent_decode(value));
        }
    }
    None
}

fn append_query_param(input: &str, key: &str, value: &str) -> String {
    let (base, fragment) = input
        .split_once('#')
        .map_or((input, None), |(base, fragment)| (base, Some(fragment)));
    let separator = if base.contains('?') { "&" } else { "?" };
    let mut output = format!("{base}{separator}{key}={}", percent_encode(value));
    if let Some(fragment) = fragment {
        output.push('#');
        output.push_str(fragment);
    }
    output
}

fn percent_encode(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(char::from(byte));
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn percent_decode(input: &str) -> String {
    let input = input.replace('+', " ");
    let mut output = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &input[index + 1..index + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                output.push(value);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}
