use base64::Engine;
use serde::{Deserialize, Deserializer, Serialize, de};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter, command};
use tauri_plugin_opener::OpenerExt;

use crate::{auth, config};

const DEV_CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Serialize, Deserialize)]
pub struct User {
    pub email: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAuthURLResponse {
    auth_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeDesktopTokenResponse {
    #[serde(alias = "access_token")]
    access_token: String,
    #[serde(alias = "refresh_token")]
    refresh_token: String,
    #[serde(
        alias = "expires_in",
        default,
        deserialize_with = "deserialize_proto_i64"
    )]
    expires_in: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshDesktopTokenResponse {
    #[serde(alias = "access_token")]
    access_token: String,
    #[serde(alias = "refresh_token")]
    refresh_token: String,
    #[serde(
        alias = "expires_in",
        default,
        deserialize_with = "deserialize_proto_i64"
    )]
    expires_in: i64,
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
pub fn auth_get_user() -> Result<Option<User>, String> {
    let token = match auth::get_access_token() {
        Ok(token) => token,
        Err(auth::TokenError::NotFound) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };

    let payload = token
        .split('.')
        .nth(1)
        .ok_or_else(|| "invalid JWT format".to_string())?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|error| format!("failed to decode JWT payload: {error}"))?;
    let claims: serde_json::Value = serde_json::from_slice(&decoded)
        .map_err(|error| format!("failed to parse JWT claims: {error}"))?;
    let email = claims
        .get("email")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "email not found in JWT claims".to_string())?
        .to_string();

    Ok(Some(User { email }))
}

#[command]
pub fn auth_logout() -> Result<(), String> {
    auth::clear_tokens().map_err(|error| error.to_string())
}

#[command]
pub async fn auth_refresh() -> Result<(), String> {
    let tokens = auth::read_tokens().map_err(|error| error.to_string())?;
    let refreshed = refresh_desktop_token(&tokens.refresh_token).await?;
    auth::replace_tokens(refreshed).map_err(|error| error.to_string())
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

    if cfg!(debug_assertions) {
        if let Some(callback_url) = start_dev_callback_server(app.clone()) {
            auth_url = append_query_param(&auth_url, "desktop_callback", &callback_url);
        }
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

    let response = exchange_desktop_token(token, state).await?;
    auth::store_tokens(
        &response.access_token,
        &response.refresh_token,
        response.expires_in,
    )
    .map_err(|error| format!("failed to store authentication tokens: {error}"))
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
    let endpoint = format!(
        "{}/kuku.auth.v1.AuthService/DesktopAuthURL",
        config::api_url().trim_end_matches('/')
    );
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|error| format!("failed to request desktop auth URL: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("server returned {}", response.status()));
    }

    let body = response
        .json::<DesktopAuthURLResponse>()
        .await
        .map_err(|error| format!("failed to decode desktop auth URL: {error}"))?;
    Ok(body.auth_url)
}

async fn exchange_desktop_token(
    token: &str,
    state: &str,
) -> Result<ExchangeDesktopTokenResponse, String> {
    let endpoint = format!(
        "{}/kuku.auth.v1.AuthService/ExchangeDesktopToken",
        config::api_url().trim_end_matches('/')
    );
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "token": token, "state": state }))
        .send()
        .await
        .map_err(|error| format!("failed to exchange desktop token: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("server returned {}", response.status()));
    }

    response
        .json::<ExchangeDesktopTokenResponse>()
        .await
        .map_err(|error| format!("failed to decode desktop token response: {error}"))
}

async fn refresh_desktop_token(refresh_token: &str) -> Result<auth::StoredTokens, String> {
    let endpoint = format!(
        "{}/kuku.auth.v1.AuthService/RefreshDesktopToken",
        config::api_url().trim_end_matches('/')
    );
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "refreshToken": refresh_token }))
        .send()
        .await
        .map_err(|error| format!("failed to refresh desktop token: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("server returned {}", response.status()));
    }

    let body = response
        .json::<RefreshDesktopTokenResponse>()
        .await
        .map_err(|error| format!("failed to decode refreshed desktop token: {error}"))?;
    Ok(auth::StoredTokens {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: format_rfc3339(SystemTime::now() + Duration::from_secs(body.expires_in as u64)),
    })
}

pub async fn authorization_header_for_plugin(plugin_id: &str) -> Result<Option<String>, String> {
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() {
        return Err("plugin_id is required".to_string());
    }
    if !auth::is_plugin_authorized(plugin_id).map_err(|error| error.to_string())? {
        return Ok(None);
    }

    let mut tokens = match auth::read_tokens() {
        Ok(tokens) => tokens,
        Err(auth::TokenError::NotFound) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if auth::token_expires_soon(&tokens) {
        tokens = refresh_desktop_token(&tokens.refresh_token).await?;
        auth::replace_tokens(tokens.clone()).map_err(|error| error.to_string())?;
    }
    if tokens.access_token.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!("Bearer {}", tokens.access_token)))
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

fn format_rfc3339(time: SystemTime) -> String {
    let datetime = time
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = datetime.as_secs();
    let days = seconds / 86_400;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

fn deserialize_proto_i64<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum ProtoI64 {
        Number(i64),
        String(String),
    }

    let value = Option::<ProtoI64>::deserialize(deserializer)?;
    match value {
        Some(ProtoI64::Number(value)) => Ok(value),
        Some(ProtoI64::String(value)) if value.is_empty() => Ok(0),
        Some(ProtoI64::String(value)) => value.parse::<i64>().map_err(de::Error::custom),
        None => Ok(0),
    }
}
