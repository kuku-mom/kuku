//! Desktop Google Calendar adapter. OAuth credentials never cross IPC.
use std::{
    collections::HashSet,
    future::Future,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, NaiveDate, Utc};
use rand_core::{OsRng, RngCore};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

use super::types::{ConnectionStatus, EventRef, ExternalCalendar, ExternalItem, ItemDraft};
use crate::plugin_secrets::{self, PluginSecretError};

const PLUGIN_ID: &str = "planner";
const TOKEN_FIELD: &str = "google-oauth";
const CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const EVENT_SCOPE: &str = "https://www.googleapis.com/auth/calendar.events";
const READ_EVENT_SCOPE: &str = "https://www.googleapis.com/auth/calendar.events.readonly";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);
static TOKEN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CONNECT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CONNECTION_EPOCH: AtomicU64 = AtomicU64::new(0);

// Do not derive Debug: credential values must not appear in diagnostic output.
#[derive(Serialize, Deserialize)]
struct Credentials {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    client_id: String,
    // Credentials from the first, read-only release have no scope field.
    #[serde(default)]
    scopes: Vec<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: i64,
    scope: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    #[serde(default = "Vec::new")]
    items: Vec<T>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleCalendar {
    id: String,
    summary: Option<String>,
    summary_override: Option<String>,
    background_color: Option<String>,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    deleted: bool,
    access_role: Option<String>,
    time_zone: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventTime {
    date: Option<String>,
    date_time: Option<String>,
    time_zone: Option<String>,
}

impl EventTime {
    fn value(&self) -> Option<String> {
        self.date.clone().or_else(|| self.date_time.clone())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEvent {
    id: String,
    summary: Option<String>,
    status: Option<String>,
    #[serde(default)]
    start: EventTime,
    #[serde(default)]
    end: EventTime,
    html_link: Option<String>,
    #[serde(rename = "iCalUID")]
    ical_uid: Option<String>,
    original_start_time: Option<EventTime>,
    etag: Option<String>,
    location: Option<String>,
    description: Option<String>,
    event_type: Option<String>,
    visibility: Option<String>,
    #[serde(default)]
    locked: bool,
    #[serde(default)]
    attendees: Vec<Value>,
    #[serde(default)]
    recurrence: Vec<String>,
    #[serde(default)]
    extended_properties: Value,
}

fn config_value(runtime: &str, compiled: Option<&str>) -> Option<String> {
    std::env::var(runtime)
        .ok()
        .or_else(|| compiled.map(str::to_owned))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn client_id() -> Option<String> {
    config_value(
        "KUKU_GOOGLE_CLIENT_ID",
        option_env!("KUKU_GOOGLE_CLIENT_ID"),
    )
}

fn client_secret() -> Option<String> {
    config_value(
        "KUKU_GOOGLE_CLIENT_SECRET",
        option_env!("KUKU_GOOGLE_CLIENT_SECRET"),
    )
}

fn credentials() -> Result<Option<Credentials>, String> {
    plugin_secrets::read_plugin_secret(PLUGIN_ID, TOKEN_FIELD)
        .map_err(|_| "Could not read Google credentials from the system keychain.".to_owned())?
        .map(|value| {
            serde_json::from_str(&value).map_err(|_| {
                "Stored Google connection is invalid. Disconnect and reconnect Google.".to_owned()
            })
        })
        .transpose()
}

fn store_credentials(value: &Credentials) -> Result<(), String> {
    let value = serde_json::to_string(value)
        .map_err(|_| "Could not encode Google credentials.".to_owned())?;
    plugin_secrets::write_plugin_secret(PLUGIN_ID, TOKEN_FIELD, &value)
        .map_err(|_| "Could not save Google credentials to the system keychain.".to_owned())
}

fn clear_credentials() -> Result<(), String> {
    match plugin_secrets::delete_plugin_secret(PLUGIN_ID, TOKEN_FIELD) {
        Ok(()) | Err(PluginSecretError::NotFound) => Ok(()),
        Err(_) => Err("Could not remove Google credentials from the system keychain.".to_owned()),
    }
}

pub async fn status() -> ConnectionStatus {
    let _guard = TOKEN_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let configured = client_id();
    let (connected, writable, error) = match credentials() {
        Ok(Some(value)) if configured.as_deref() == Some(value.client_id.as_str()) => (
            !value.refresh_token.is_empty(),
            has_write_scope(&value.scopes),
            None,
        ),
        Ok(Some(_)) => (
            false,
            false,
            Some("Google OAuth configuration changed. Reconnect Google.".to_owned()),
        ),
        Ok(None) => (false, false, None),
        Err(error) => (false, false, Some(error)),
    };
    ConnectionStatus {
        provider: "google".into(),
        connected,
        configured: configured.is_some(),
        error,
        writable: Some(connected && writable),
    }
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize the Google connection.".to_owned())
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorization_url(client_id: &str, redirect: &str, state: &str, verifier: &str) -> Url {
    let mut url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id", client_id),
        ("redirect_uri", redirect),
        ("response_type", "code"),
        ("scope", &format!("{CALENDAR_SCOPE} {EVENT_SCOPE}")),
        ("state", state),
        ("code_challenge", &challenge(verifier)),
        ("code_challenge_method", "S256"),
        ("access_type", "offline"),
        ("prompt", "consent select_account"),
    ]);
    url
}

pub async fn connect(app: &AppHandle) -> Result<ConnectionStatus, String> {
    let _connect_guard = CONNECT_LOCK
        .get_or_init(|| Mutex::new(()))
        .try_lock()
        .map_err(|_| "Google sign-in is already open in your browser.".to_owned())?;
    let client_id = client_id()
        .ok_or_else(|| "This build has no Google OAuth client ID configured.".to_owned())?;
    let epoch = CONNECTION_EPOCH.load(Ordering::SeqCst);
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Could not open the local Google sign-in callback.".to_owned())?;
    let address = listener
        .local_addr()
        .map_err(|_| "Could not determine the Google callback address.".to_owned())?;
    let redirect = format!("http://{address}/oauth/google");
    let state = random_token();
    let verifier = random_token();
    let url = authorization_url(&client_id, &redirect, &state, &verifier);
    app.opener()
        .open_url(url.as_str(), None::<String>)
        .map_err(|_| "Could not open your browser for Google sign-in.".to_owned())?;
    let expected_host = address.to_string();
    let code = tauri::async_runtime::spawn_blocking(move || {
        wait_for_callback(listener, &state, &expected_host, epoch)
    })
    .await
    .map_err(|_| "Google sign-in callback stopped unexpectedly.".to_owned())??;
    let mut form = vec![
        ("client_id", client_id.clone()),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code".into()),
        ("redirect_uri", redirect),
    ];
    if let Some(secret) = client_secret() {
        form.push(("client_secret", secret));
    }
    let response = exchange_token(&form).await?;
    let scopes = connection_scopes(response.scope.as_deref())?;
    let refresh_token = response
        .refresh_token
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Google did not grant offline access. Reconnect and approve Calendar access.".to_owned()
        })?;
    let _guard = TOKEN_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    if CONNECTION_EPOCH.load(Ordering::SeqCst) != epoch {
        return Err("Google sign-in was cancelled.".into());
    }
    store_credentials(&Credentials {
        access_token: response.access_token,
        refresh_token,
        expires_at: Utc::now().timestamp() + response.expires_in,
        client_id,
        scopes,
    })?;
    // Any snapshot started under a previous account must fail as a whole.
    CONNECTION_EPOCH.fetch_add(1, Ordering::SeqCst);
    Ok(ConnectionStatus {
        provider: "google".into(),
        connected: true,
        configured: true,
        error: None,
        writable: Some(true),
    })
}

pub async fn disconnect() -> Result<ConnectionStatus, String> {
    CONNECTION_EPOCH.fetch_add(1, Ordering::SeqCst);
    let _guard = TOKEN_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    clear_credentials()?;
    Ok(ConnectionStatus {
        provider: "google".into(),
        connected: false,
        configured: client_id().is_some(),
        error: None,
        writable: Some(false),
    })
}

pub fn suspend() {
    // Stop pending OAuth and snapshots when the plugin deactivates, without
    // removing the user's saved connection or requiring another consent flow.
    CONNECTION_EPOCH.fetch_add(1, Ordering::SeqCst);
}

fn has_write_scope(scopes: &[String]) -> bool {
    scopes
        .iter()
        .any(|scope| scope == EVENT_SCOPE || scope == "https://www.googleapis.com/auth/calendar")
}

fn connection_scopes(scope: Option<&str>) -> Result<Vec<String>, String> {
    let scopes: Vec<String> = scope
        .unwrap_or(&format!("{CALENDAR_SCOPE} {EVENT_SCOPE}"))
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    if !has_write_scope(&scopes)
        || !scopes.iter().any(|value| {
            value == CALENDAR_SCOPE || value == "https://www.googleapis.com/auth/calendar"
        })
    {
        return Err("READ_ONLY: Google Calendar editing was not approved. Your previous connection is unchanged; reconnect to enable editing.".into());
    }
    Ok(scopes)
}

fn validate_scopes(scope: Option<&str>) -> Result<(), String> {
    if let Some(scope) = scope {
        let granted: HashSet<_> = scope.split_whitespace().collect();
        let full = granted.contains("https://www.googleapis.com/auth/calendar");
        if !full
            && (!granted.contains(CALENDAR_SCOPE)
                || (!granted.contains(EVENT_SCOPE) && !granted.contains(READ_EVENT_SCOPE)))
        {
            return Err("Google Calendar access was only partly approved. Reconnect and approve Calendar access.".into());
        }
    }
    Ok(())
}

fn form_body(form: &[(&str, String)]) -> String {
    let mut url = Url::parse("https://localhost/").unwrap();
    url.query_pairs_mut()
        .extend_pairs(form.iter().map(|(key, value)| (*key, value)));
    url.query().unwrap_or_default().to_owned()
}

async fn exchange_token(form: &[(&str, String)]) -> Result<TokenResponse, String> {
    let response = http_client()?
        .post("https://oauth2.googleapis.com/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body(form))
        .send()
        .await
        .map_err(|_| "Could not reach Google. Check your connection and try again.".to_owned())?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Could not read the Google sign-in response.".to_owned())?;
    if !status.is_success() {
        let error = serde_json::from_slice::<serde_json::Value>(&bytes).ok();
        return Err(match error
            .as_ref()
            .and_then(|value| value.get("error"))
            .and_then(|value| value.as_str())
        {
            Some("invalid_grant") => {
                "Google authorization expired or was revoked. Reconnect Google."
            }
            Some("invalid_client") => "Google OAuth client configuration is invalid.",
            Some("access_denied") => "Google Calendar access was denied.",
            _ => "Google sign-in failed. Try connecting again.",
        }
        .into());
    }
    let response: TokenResponse = serde_json::from_slice(&bytes)
        .map_err(|_| "Google returned an invalid sign-in response.".to_owned())?;
    if response.access_token.is_empty()
        || response.expires_in <= 0
        || response.expires_in > 31_536_000
    {
        return Err("Google returned an invalid access token.".into());
    }
    Ok(response)
}

async fn access_token(rejected: Option<&str>) -> Result<String, String> {
    let _guard = TOKEN_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let mut current = credentials()?.ok_or_else(|| "Connect Google Calendar first.".to_owned())?;
    if client_id().as_deref() != Some(current.client_id.as_str()) {
        return Err("Google OAuth configuration changed. Reconnect Google.".into());
    }
    if current.expires_at > Utc::now().timestamp() + 60
        && rejected != Some(current.access_token.as_str())
    {
        return Ok(current.access_token);
    }
    let mut form = vec![
        ("client_id", current.client_id.clone()),
        ("grant_type", "refresh_token".into()),
        ("refresh_token", current.refresh_token.clone()),
    ];
    if let Some(secret) = client_secret() {
        form.push(("client_secret", secret));
    }
    let response = match exchange_token(&form).await {
        Ok(response) => response,
        Err(error) => {
            if error == "Google authorization expired or was revoked. Reconnect Google." {
                clear_credentials()?;
                CONNECTION_EPOCH.fetch_add(1, Ordering::SeqCst);
            }
            return Err(error);
        }
    };
    validate_scopes(response.scope.as_deref())?;
    if let Some(scope) = response.scope {
        current.scopes = scope.split_whitespace().map(str::to_owned).collect();
    }
    current.access_token = response.access_token;
    if let Some(refresh_token) = response.refresh_token.filter(|value| !value.is_empty()) {
        current.refresh_token = refresh_token;
    }
    current.expires_at = Utc::now().timestamp() + response.expires_in;
    store_credentials(&current)?;
    Ok(current.access_token)
}

async fn api_request(
    method: Method,
    url: Url,
    body: Option<&Value>,
    version: Option<&str>,
    epoch: u64,
) -> Result<Option<Value>, String> {
    let client = http_client()?;
    check_epoch(epoch)?;
    let mut token = access_token(None).await?;
    for attempt in 0..2 {
        check_epoch(epoch)?;
        let mut request = client
            .request(method.clone(), url.clone())
            .bearer_auth(&token);
        if let Some(body) = body {
            request = request.json(body);
        }
        if let Some(version) = version {
            request = request.header(reqwest::header::IF_MATCH, version);
        }
        let response = request.send().await.map_err(|_| {
            "NETWORK: Could not reach Google Calendar. Refresh before retrying the same operation.".to_owned()
        })?;
        if response.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
            check_epoch(epoch)?;
            token = access_token(Some(&token)).await?;
            continue;
        }
        check_epoch(epoch)?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND || status == StatusCode::GONE {
            return Ok(None);
        }
        if !status.is_success() {
            let error = response.json::<Value>().await.ok();
            return Err(api_error(status, error.as_ref()).into());
        }
        if status == StatusCode::NO_CONTENT {
            return Ok(Some(Value::Null));
        }
        return response.json::<Value>().await.map(Some)
            .map_err(|_| "NETWORK: Could not read Google's response. Refresh before retrying the same operation.".into());
    }
    Err("AUTH: Google Calendar access expired. Reconnect Google.".into())
}

fn api_error(status: StatusCode, body: Option<&Value>) -> &'static str {
    let quota_limited = body
        .and_then(|value| value.pointer("/error/errors"))
        .and_then(Value::as_array)
        .is_some_and(|errors| {
            errors.iter().any(|error| {
                matches!(
                    error.get("reason").and_then(Value::as_str),
                    Some("rateLimitExceeded" | "userRateLimitExceeded" | "quotaExceeded")
                )
            })
        });
    match status {
        StatusCode::UNAUTHORIZED => "AUTH: Google Calendar access expired. Reconnect Google.",
        StatusCode::FORBIDDEN if quota_limited => {
            "RATE_LIMIT: Google Calendar quota is temporarily exhausted. Try again later."
        }
        StatusCode::FORBIDDEN => {
            "READ_ONLY: Google denied access. Refresh the calendar permissions or reconnect Google."
        }
        StatusCode::PRECONDITION_FAILED => {
            "CONFLICT: This event changed in Google Calendar. Refresh it before trying again."
        }
        StatusCode::CONFLICT => "DUPLICATE: An event with this identifier already exists.",
        StatusCode::TOO_MANY_REQUESTS => {
            "RATE_LIMIT: Google Calendar is temporarily rate limited. Try later."
        }
        StatusCode::BAD_REQUEST => "INVALID: Google rejected this calendar change.",
        _ => "NETWORK: Google Calendar could not complete the request. Refresh before retrying.",
    }
}

async fn api_get<T: DeserializeOwned>(url: Url) -> Result<T, String> {
    let epoch = CONNECTION_EPOCH.load(Ordering::SeqCst);
    let value = api_request(Method::GET, url, None, None, epoch)
        .await?
        .ok_or("NOT_FOUND: A selected Google calendar no longer exists or is inaccessible.")?;
    serde_json::from_value(value).map_err(|_| "Google returned invalid calendar data.".into())
}

// Never return a partial collection: callers replace their cached snapshot only on success.
async fn collect_pages<T, F, Fut>(mut fetch: F) -> Result<Vec<T>, String>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: Future<Output = Result<Page<T>, String>>,
{
    let mut items = Vec::new();
    let mut page_token = None;
    let mut seen = HashSet::new();
    loop {
        let page = fetch(page_token).await?;
        items.extend(page.items);
        page_token = page.next_page_token.filter(|value| !value.is_empty());
        match &page_token {
            None => return Ok(items),
            Some(token) if seen.len() >= 1_000 || !seen.insert(token.clone()) => {
                return Err("Google returned invalid pagination. Refresh again later.".into());
            }
            Some(_) => {}
        }
    }
}

fn check_epoch(epoch: u64) -> Result<(), String> {
    if CONNECTION_EPOCH.load(Ordering::SeqCst) != epoch {
        return Err("Google connection changed. Refresh the selected calendars.".into());
    }
    Ok(())
}

async fn collection<T: DeserializeOwned>(url: Url, epoch: u64) -> Result<Vec<T>, String> {
    collect_pages(|page_token| {
        let mut page_url = url.clone();
        if let Some(token) = page_token {
            page_url.query_pairs_mut().append_pair("pageToken", &token);
        }
        async move {
            check_epoch(epoch)?;
            let page = api_get(page_url).await?;
            check_epoch(epoch)?;
            Ok(page)
        }
    })
    .await
}

async fn raw_calendars(epoch: u64) -> Result<Vec<GoogleCalendar>, String> {
    let mut url =
        Url::parse("https://www.googleapis.com/calendar/v3/users/me/calendarList").unwrap();
    url.query_pairs_mut()
        .extend_pairs([("maxResults", "250"), ("minAccessRole", "reader")]);
    collection(url, epoch).await
}

pub async fn calendars() -> Result<Vec<ExternalCalendar>, String> {
    let epoch = CONNECTION_EPOCH.load(Ordering::SeqCst);
    let values = raw_calendars(epoch).await?;
    let account_id = values
        .iter()
        .find(|value| value.primary)
        .map(|value| value.id.clone());
    let write_access = status().await.writable.unwrap_or(false);
    Ok(values
        .into_iter()
        .filter(|value| !value.deleted)
        .map(|value| ExternalCalendar {
            title: value
                .summary_override
                .or(value.summary)
                .unwrap_or_else(|| value.id.clone()),
            id: value.id,
            provider: "google".into(),
            color: value.background_color,
            account_id: account_id.clone(),
            writable: Some(write_access && calendar_can_write(value.access_role.as_deref())),
            time_zone: value.time_zone,
            source_title: Some("Google Calendar".into()),
            is_default: Some(value.primary),
        })
        .collect())
}

fn validate_range(start: &str, end: &str, time_zone: &str) -> Result<(), String> {
    let start = DateTime::parse_from_rfc3339(start)
        .map_err(|_| "Invalid calendar start time.".to_owned())?;
    let end =
        DateTime::parse_from_rfc3339(end).map_err(|_| "Invalid calendar end time.".to_owned())?;
    if end <= start || end - start > chrono::Duration::days(366) {
        return Err("Calendar range must be positive and no longer than one year.".into());
    }
    if time_zone.is_empty() || time_zone.len() > 128 || time_zone.chars().any(char::is_control) {
        return Err("Invalid calendar time zone.".into());
    }
    Ok(())
}

fn event_item(calendar_id: &str, event: GoogleEvent) -> Option<ExternalItem> {
    if event.status.as_deref() == Some("cancelled")
        || event.start.value().is_none()
        || event.end.value().is_none()
    {
        return None;
    }
    let occurrence = event
        .original_start_time
        .as_ref()
        .and_then(EventTime::value);
    let safe_to_edit = event_can_write(&event);
    let write_ref = EventRef {
        provider: "google".into(),
        calendar_id: calendar_id.into(),
        item_id: event.id.clone(),
        version: event.etag.clone(),
        occurrence: occurrence.clone(),
        external_id: event.ical_uid.clone(),
        start: event.start.value(),
        end: event.end.value(),
    };
    let operation_id = event
        .extended_properties
        .get("private")
        .and_then(|props| props.get("kukuOperationId"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some(ExternalItem {
        id: format!(
            "{}:{}",
            URL_SAFE_NO_PAD.encode(calendar_id),
            URL_SAFE_NO_PAD.encode(&event.id)
        ),
        calendar_id: calendar_id.into(),
        provider: "google".into(),
        title: event
            .summary
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Busy".into()),
        kind: "event".into(),
        start: event.start.value(),
        end: event.end.value(),
        all_day: event.start.date.is_some(),
        due_date: None,
        completed: None,
        time_zone: event.start.time_zone,
        url: event.html_link,
        external_id: event.ical_uid,
        occurrence,
        writable: Some(safe_to_edit),
        location: event.location,
        description: event.description,
        write_ref: Some(write_ref),
        operation_id,
    })
}

pub async fn events(
    calendar_ids: Vec<String>,
    start: String,
    end: String,
    time_zone: String,
) -> Result<Vec<ExternalItem>, String> {
    let epoch = CONNECTION_EPOCH.load(Ordering::SeqCst);
    validate_range(&start, &end, &time_zone)?;
    if calendar_ids.len() > 100 {
        return Err("Select no more than 100 Google calendars.".into());
    }
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    let calendars = raw_calendars(epoch).await?;
    let write_access = status().await.writable.unwrap_or(false);
    for calendar_id in calendar_ids {
        if calendar_id.is_empty() || calendar_id.len() > 1024 {
            return Err("Invalid Google calendar identifier.".into());
        }
        if !seen.insert(calendar_id.clone()) {
            continue;
        }
        let mut url = Url::parse("https://www.googleapis.com/calendar/v3/calendars/").unwrap();
        url.path_segments_mut()
            .unwrap()
            .pop_if_empty()
            .push(&calendar_id)
            .push("events");
        url.query_pairs_mut().extend_pairs([
            ("singleEvents", "true"),
            ("showDeleted", "false"),
            ("maxResults", "2500"),
            ("timeMin", &start),
            ("timeMax", &end),
            ("timeZone", &time_zone),
        ]);
        let values: Vec<GoogleEvent> = collection(url, epoch).await?;
        let role = calendars
            .iter()
            .find(|calendar| calendar.id == calendar_id && !calendar.deleted)
            .and_then(|calendar| calendar.access_role.as_deref());
        let writable = write_access && calendar_can_write(role);
        items.extend(values.into_iter().filter_map(|event| {
            let redacted = role == Some("writerWithoutPrivateAccess")
                && event.visibility.as_deref() == Some("private");
            event_item(&calendar_id, event).map(|mut item| {
                item.writable = Some(writable && !redacted && item.writable.unwrap_or(false));
                item
            })
        }));
    }
    Ok(items)
}

fn calendar_can_write(role: Option<&str>) -> bool {
    matches!(
        role,
        Some("owner" | "writer" | "writerWithoutPrivateAccess")
    )
}

fn event_can_write(event: &GoogleEvent) -> bool {
    !event.locked
        && event.attendees.is_empty()
        && event.recurrence.is_empty()
        && event.event_type.as_deref().unwrap_or("default") == "default"
        && event.status.as_deref() != Some("cancelled")
        && event.summary.is_some()
}

fn validate_identifier(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
        return Err("INVALID: Invalid Google Calendar identifier.".into());
    }
    Ok(())
}

fn event_url(calendar_id: &str, event_id: Option<&str>) -> Result<Url, String> {
    validate_identifier(calendar_id)?;
    let mut url = Url::parse("https://www.googleapis.com/calendar/v3/calendars/").unwrap();
    {
        let mut path = url.path_segments_mut().unwrap();
        path.pop_if_empty().push(calendar_id).push("events");
        if let Some(event_id) = event_id {
            validate_identifier(event_id)?;
            path.push(event_id);
        }
    }
    Ok(url)
}

fn validate_ref(event_ref: &EventRef) -> Result<(), String> {
    if event_ref.provider != "google" {
        return Err("INVALID: This event belongs to a different provider.".into());
    }
    validate_identifier(&event_ref.calendar_id)?;
    validate_identifier(&event_ref.item_id)
}

async fn calendar_details(calendar_id: &str, epoch: u64) -> Result<GoogleCalendar, String> {
    validate_identifier(calendar_id)?;
    let mut url =
        Url::parse("https://www.googleapis.com/calendar/v3/users/me/calendarList/").unwrap();
    url.path_segments_mut()
        .unwrap()
        .pop_if_empty()
        .push(calendar_id);
    let value = api_request(Method::GET, url, None, None, epoch)
        .await?
        .ok_or("NOT_FOUND: This Google calendar is no longer available.")?;
    serde_json::from_value(value).map_err(|_| "Google returned invalid calendar data.".into())
}

async fn require_write(calendar_id: &str, epoch: u64) -> Result<GoogleCalendar, String> {
    // Refresh credentials first: a refresh may return a reduced grant.
    access_token(None).await?;
    check_epoch(epoch)?;
    if !status().await.writable.unwrap_or(false) {
        return Err(
            "READ_ONLY: Reconnect Google to allow creating and editing calendar events.".into(),
        );
    }
    let calendar = calendar_details(calendar_id, epoch).await?;
    if calendar.deleted || !calendar_can_write(calendar.access_role.as_deref()) {
        return Err("READ_ONLY: This Google calendar cannot be changed.".into());
    }
    Ok(calendar)
}

async fn read_event(event_ref: &EventRef, epoch: u64) -> Result<Option<GoogleEvent>, String> {
    validate_ref(event_ref)?;
    api_request(
        Method::GET,
        event_url(&event_ref.calendar_id, Some(&event_ref.item_id))?,
        None,
        None,
        epoch,
    )
    .await?
    .map(|value| {
        serde_json::from_value(value).map_err(|_| "Google returned invalid event data.".into())
    })
    .transpose()
}

pub async fn get(event_ref: EventRef) -> Result<Option<ExternalItem>, String> {
    let epoch = CONNECTION_EPOCH.load(Ordering::SeqCst);
    let event = read_event(&event_ref, epoch).await?;
    // Google also returns 404 for inaccessible calendars. Confirm calendar
    // access after the item read, including missing/cancelled items, before a
    // caller interprets the result as deletion of a linked task block.
    let calendar = calendar_details(&event_ref.calendar_id, epoch).await;
    let writable = status().await.writable.unwrap_or(false);
    check_epoch(epoch)?;
    resolved_event_item(&event_ref.calendar_id, event, calendar, writable)
}

fn resolved_event_item(
    calendar_id: &str,
    event: Option<GoogleEvent>,
    calendar: Result<GoogleCalendar, String>,
    writable: bool,
) -> Result<Option<ExternalItem>, String> {
    let calendar = calendar.map_err(|error| {
        if error.starts_with("NOT_FOUND:") {
            "CONFLICT: This Google calendar is unavailable. Reconnect or select an accessible calendar before resolving its linked events.".into()
        } else {
            error
        }
    })?;
    if calendar.deleted
        || !matches!(
            calendar.access_role.as_deref(),
            Some("reader" | "writer" | "writerWithoutPrivateAccess" | "owner")
        )
    {
        return Err("CONFLICT: This Google calendar can no longer be read. Restore calendar access before resolving its linked events.".into());
    }
    let Some(event) = event else {
        return Ok(None);
    };
    let writable = writable
        && calendar_can_write(calendar.access_role.as_deref())
        && !(calendar.access_role.as_deref() == Some("writerWithoutPrivateAccess")
            && event.visibility.as_deref() == Some("private"));
    Ok(event_item(calendar_id, event).map(|mut item| {
        item.writable = Some(writable && item.writable.unwrap_or(false));
        item
    }))
}

fn draft_body(draft: &ItemDraft) -> Result<Value, String> {
    let title = draft.title.trim();
    if title.is_empty()
        || title.len() > 4096
        || draft
            .description
            .as_ref()
            .is_some_and(|text| text.len() > 65536)
        || draft
            .location
            .as_ref()
            .is_some_and(|text| text.len() > 8192)
    {
        return Err(
            "INVALID: Enter an event title and keep event details within the supported length."
                .into(),
        );
    }
    if draft.due_date.is_some() || draft.completed.is_some() {
        return Err("INVALID: Calendar events do not have task completion or due dates.".into());
    }
    let start = draft
        .start
        .as_deref()
        .ok_or("INVALID: Choose an event start.")?;
    let end = draft
        .end
        .as_deref()
        .ok_or("INVALID: Choose an event end.")?;
    let (start_value, end_value) = if draft.all_day {
        let first = NaiveDate::parse_from_str(start, "%Y-%m-%d")
            .map_err(|_| "INVALID: Invalid all-day start date.")?;
        let last = NaiveDate::parse_from_str(end, "%Y-%m-%d")
            .map_err(|_| "INVALID: Invalid all-day end date.")?;
        if last <= first
            || first.format("%Y-%m-%d").to_string() != start
            || last.format("%Y-%m-%d").to_string() != end
        {
            return Err("INVALID: The exclusive all-day end must follow its start.".into());
        }
        (
            json!({"date": start, "dateTime": null, "timeZone": null}),
            json!({"date": end, "dateTime": null, "timeZone": null}),
        )
    } else {
        let zone = draft.time_zone.as_deref().unwrap_or("UTC");
        validate_range(start, end, zone)?;
        (
            json!({"dateTime": start, "date": null, "timeZone": draft.time_zone}),
            json!({"dateTime": end, "date": null, "timeZone": draft.time_zone}),
        )
    };
    Ok(
        json!({"summary": title, "start": start_value, "end": end_value,
        "location": draft.location.as_deref().unwrap_or(""), "description": draft.description.as_deref().unwrap_or("")}),
    )
}

fn operation_event_id(operation_id: &str) -> Result<String, String> {
    // Hash the caller's durable operation ID into Google's base32hex alphabet.
    // A repeat of the same operation always addresses the same provider object.
    if operation_id.is_empty()
        || operation_id.len() > 256
        || operation_id.chars().any(char::is_control)
    {
        return Err("INVALID: Invalid calendar operation identifier.".into());
    }
    Ok(format!("kuku{:x}", Sha256::digest(operation_id.as_bytes())))
}

pub async fn create(
    calendar_id: String,
    draft: ItemDraft,
    operation_id: String,
) -> Result<ExternalItem, String> {
    let epoch = CONNECTION_EPOCH.load(Ordering::SeqCst);
    require_write(&calendar_id, epoch).await?;
    let mut body = draft_body(&draft)?;
    let event_id = operation_event_id(&operation_id)?;
    body["id"] = json!(event_id);
    body["extendedProperties"] = json!({"private": {"kukuOperationId": operation_id}});
    let result = api_request(
        Method::POST,
        event_url(&calendar_id, None)?,
        Some(&body),
        None,
        epoch,
    )
    .await;
    let value = match result {
        Ok(Some(value)) => value,
        Ok(None) => return Err("NOT_FOUND: This Google calendar is no longer available.".into()),
        Err(error) if error.starts_with("DUPLICATE:") || error.starts_with("NETWORK:") => {
            // The response may be lost after a successful insert. Only recover
            // our exact operation, never overwrite an unrelated existing event.
            let recovered = api_request(
                Method::GET,
                event_url(&calendar_id, Some(&event_id))?,
                None,
                None,
                epoch,
            )
            .await;
            match recovered {
                Ok(Some(value))
                    if value
                        .pointer("/extendedProperties/private/kukuOperationId")
                        .and_then(Value::as_str)
                        == Some(&operation_id) =>
                {
                    value
                }
                _ => return Err(error),
            }
        }
        Err(error) => return Err(error),
    };
    let event: GoogleEvent = serde_json::from_value(value)
        .map_err(|_| "Google returned invalid event data.".to_owned())?;
    event_item(&calendar_id, event).ok_or_else(|| {
        "CONFLICT: The created event is no longer available. Refresh Google Calendar.".into()
    })
}

fn require_event_version(
    event_ref: &EventRef,
    event: &GoogleEvent,
    calendar: &GoogleCalendar,
) -> Result<String, String> {
    if !event_can_write(event)
        || (calendar.access_role.as_deref() == Some("writerWithoutPrivateAccess")
            && event.visibility.as_deref() == Some("private"))
    {
        return Err("READ_ONLY: Meetings with attendees, protected events, and recurring series must be edited in Google Calendar. Individual personal occurrences can be edited here.".into());
    }
    let version = event_ref
        .version
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or("CONFLICT: Refresh this event before changing it.")?;
    if event.etag.as_deref() != Some(version)
        || event_ref.occurrence.as_deref()
            != event
                .original_start_time
                .as_ref()
                .and_then(EventTime::value)
                .as_deref()
    {
        return Err(
            "CONFLICT: This event changed in Google Calendar. Refresh it before trying again."
                .into(),
        );
    }
    Ok(version.into())
}

fn patch_body(event: &GoogleEvent, patch: Value) -> Result<Value, String> {
    let object = patch.as_object().ok_or("INVALID: Invalid event changes.")?;
    if object.is_empty()
        || object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "title" | "start" | "end" | "allDay" | "timeZone" | "location" | "description"
            )
        })
    {
        return Err("INVALID: Unsupported calendar event changes.".into());
    }
    let draft = ItemDraft {
        title: event.summary.clone().unwrap_or_default(),
        start: event.start.value(),
        end: event.end.value(),
        all_day: event.start.date.is_some(),
        time_zone: event.start.time_zone.clone(),
        location: event.location.clone(),
        description: event.description.clone(),
        ..Default::default()
    };
    let mut value =
        serde_json::to_value(draft).map_err(|_| "INVALID: Could not prepare event changes.")?;
    for (key, field) in object {
        value[key] = field.clone();
    }
    let draft: ItemDraft =
        serde_json::from_value(value).map_err(|_| "INVALID: Invalid event changes.")?;
    let mut body = draft_body(&draft)?;
    // Send only edited fields. Time fields are a single validated unit, and null
    // clears the other Google representation when toggling all-day mode.
    if let Some(body) = body.as_object_mut() {
        body.retain(|key, _| match key.as_str() {
            "summary" => object.contains_key("title"),
            "start" | "end" => ["start", "end", "allDay", "timeZone"]
                .iter()
                .any(|key| object.contains_key(*key)),
            other => object.contains_key(other),
        });
    }
    Ok(body)
}

pub async fn update(event_ref: EventRef, patch: Value) -> Result<ExternalItem, String> {
    validate_ref(&event_ref)?;
    let epoch = CONNECTION_EPOCH.load(Ordering::SeqCst);
    let calendar = require_write(&event_ref.calendar_id, epoch).await?;
    let event = read_event(&event_ref, epoch)
        .await?
        .ok_or("NOT_FOUND: This event was deleted from Google Calendar.")?;
    let version = require_event_version(&event_ref, &event, &calendar)?;
    let body = patch_body(&event, patch)?;
    let value = api_request(
        Method::PATCH,
        event_url(&event_ref.calendar_id, Some(&event_ref.item_id))?,
        Some(&body),
        Some(&version),
        epoch,
    )
    .await?
    .ok_or("NOT_FOUND: This event was deleted from Google Calendar.")?;
    let event = serde_json::from_value(value)
        .map_err(|_| "Google returned invalid event data.".to_owned())?;
    event_item(&event_ref.calendar_id, event)
        .ok_or_else(|| "NOT_FOUND: This event is no longer available.".into())
}

pub async fn delete(event_ref: EventRef) -> Result<(), String> {
    validate_ref(&event_ref)?;
    let epoch = CONNECTION_EPOCH.load(Ordering::SeqCst);
    let calendar = require_write(&event_ref.calendar_id, epoch).await?;
    let Some(event) = read_event(&event_ref, epoch).await? else {
        return Ok(());
    };
    if event.status.as_deref() == Some("cancelled") {
        return Ok(());
    }
    let version = require_event_version(&event_ref, &event, &calendar)?;
    api_request(
        Method::DELETE,
        event_url(&event_ref.calendar_id, Some(&event_ref.item_id))?,
        None,
        Some(&version),
        epoch,
    )
    .await?;
    Ok(())
}

fn callback_code(request: &str, state: &str, host: &str) -> Result<String, String> {
    let mut lines = request.split("\r\n");
    let mut parts = lines.next().unwrap_or_default().split_whitespace();
    if parts.next() != Some("GET") {
        return Err("Invalid callback method.".into());
    }
    let target = parts.next().ok_or("Invalid callback path.")?;
    if !target.starts_with("/oauth/google?") {
        return Err("Invalid callback path.".into());
    }
    let request_host = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.trim());
    if request_host != Some(host) {
        return Err("Invalid callback host.".into());
    }
    let url = Url::parse(&format!("http://{host}{target}")).map_err(|_| "Invalid callback URL.")?;
    let mut values = std::collections::HashMap::new();
    for (key, value) in url.query_pairs() {
        if values
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err("Duplicate callback parameter.".into());
        }
    }
    if values.get("state").map(String::as_str) != Some(state) {
        return Err("Invalid callback state.".into());
    }
    if values.contains_key("error") {
        return Err("Google Calendar access was denied.".into());
    }
    values
        .remove("code")
        .filter(|code| !code.is_empty())
        .ok_or_else(|| "Missing callback code.".into())
}

fn read_callback(stream: &mut TcpStream) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "Callback unavailable.")?;
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    while request.len() < 8192 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Callback request timed out.".into());
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| "Callback unavailable.")?;
        let count = stream
            .read(&mut buffer)
            .map_err(|_| "Could not read callback.")?;
        if count == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..count]);
        if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            return String::from_utf8(request).map_err(|_| "Invalid callback encoding.".into());
        }
    }
    Err("Invalid callback request.".into())
}

fn wait_for_callback(
    listener: TcpListener,
    state: &str,
    host: &str,
    epoch: u64,
) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|_| "Could not listen for Google sign-in.".to_owned())?;
    let deadline = Instant::now() + CALLBACK_TIMEOUT;
    while Instant::now() < deadline {
        if CONNECTION_EPOCH.load(Ordering::SeqCst) != epoch {
            return Err("Google sign-in was cancelled.".into());
        }
        match listener.accept() {
            Ok((mut stream, peer)) => {
                if !peer.ip().is_loopback() {
                    continue;
                }
                let result = read_callback(&mut stream)
                    .and_then(|request| callback_code(&request, state, host));
                let accepted = result.is_ok();
                let denied = result
                    .as_ref()
                    .err()
                    .is_some_and(|error| error == "Google Calendar access was denied.");
                let body = if accepted {
                    "Google sign-in received. You can close this window and return to Kuku."
                } else {
                    "This sign-in request was not accepted. Return to Kuku to try again."
                };
                let response = format!(
                    "HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    if accepted {
                        "200 OK"
                    } else {
                        "400 Bad Request"
                    },
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                if accepted || denied {
                    return result;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100))
            }
            Err(_) => return Err("Google sign-in callback failed.".into()),
        }
    }
    Err("Google sign-in timed out. Try connecting again.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn pkce_matches_rfc7636_vector() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn callback_requires_exact_state_host_and_unique_parameters() {
        let request =
            "GET /oauth/google?code=a%2Bb&state=expected HTTP/1.1\r\nHost: 127.0.0.1:4242\r\n\r\n";
        assert_eq!(
            callback_code(request, "expected", "127.0.0.1:4242").unwrap(),
            "a+b"
        );
        assert!(callback_code(request, "other", "127.0.0.1:4242").is_err());
        assert!(callback_code(request, "expected", "attacker.example").is_err());
        assert!(
            callback_code(
                &request.replace("state=expected", "state=expected&state=other"),
                "expected",
                "127.0.0.1:4242"
            )
            .is_err()
        );
        assert_eq!(
            callback_code(
                &request.replace("code=a%2Bb", "error=access_denied"),
                "expected",
                "127.0.0.1:4242"
            )
            .unwrap_err(),
            "Google Calendar access was denied."
        );
    }

    #[test]
    fn cancelled_sign_in_stops_before_accepting_a_callback() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let host = listener.local_addr().unwrap().to_string();
        let stale_epoch = CONNECTION_EPOCH.load(Ordering::SeqCst).wrapping_add(1);
        assert_eq!(
            wait_for_callback(listener, "unused", &host, stale_epoch).unwrap_err(),
            "Google sign-in was cancelled."
        );
        assert!(check_epoch(stale_epoch).is_err());
    }

    #[test]
    fn all_day_dates_and_moved_occurrences_are_preserved() {
        let event: GoogleEvent = serde_json::from_value(serde_json::json!({
            "id":"instance", "summary":"Travel", "start":{"date":"2026-09-04"},
            "end":{"date":"2026-09-07"}, "originalStartTime":{"date":"2026-09-03"}, "iCalUID":"series"
        })).unwrap();
        let item = event_item("calendar", event).unwrap();
        assert!(item.all_day);
        assert_eq!(item.end.as_deref(), Some("2026-09-07"));
        assert_eq!(item.occurrence.as_deref(), Some("2026-09-03"));
        assert_eq!(item.external_id.as_deref(), Some("series"));
        let cancelled =
            serde_json::from_value(serde_json::json!({"id":"cancelled", "status":"cancelled"}))
                .unwrap();
        assert!(event_item("calendar", cancelled).is_none());
    }

    #[test]
    fn timed_events_keep_offsets_and_identity_is_calendar_scoped() {
        let json = serde_json::json!({"id":"same", "start":{"dateTime":"2026-11-01T01:30:00-04:00","timeZone":"America/New_York"},"end":{"dateTime":"2026-11-01T01:30:00-05:00"}});
        let first = event_item("a", serde_json::from_value(json.clone()).unwrap()).unwrap();
        let second = event_item("b", serde_json::from_value(json).unwrap()).unwrap();
        assert_ne!(first.id, second.id);
        assert!(!first.all_day);
        assert_eq!(first.time_zone.as_deref(), Some("America/New_York"));
        assert_eq!(first.start.as_deref(), Some("2026-11-01T01:30:00-04:00"));
        assert_eq!(first.title, "Busy");
    }

    #[test]
    fn partial_google_consent_is_rejected() {
        assert!(validate_scopes(Some(EVENT_SCOPE)).is_err());
        assert!(validate_scopes(Some(&format!("{EVENT_SCOPE} {CALENDAR_SCOPE}"))).is_ok());
        assert!(validate_scopes(Some(&format!("{READ_EVENT_SCOPE} {CALENDAR_SCOPE}"))).is_ok());
        assert!(connection_scopes(Some(&format!("{READ_EVENT_SCOPE} {CALENDAR_SCOPE}"))).is_err());
        assert!(has_write_scope(&connection_scopes(None).unwrap()));
        let old: Credentials = serde_json::from_value(json!({
            "access_token": "fake", "refresh_token": "fake", "expires_at": 0, "client_id": "fake"
        }))
        .unwrap();
        assert!(!has_write_scope(&old.scopes));
    }

    fn personal_event() -> GoogleEvent {
        serde_json::from_value(
            json!({"id": "raw-instance", "summary": "Work", "etag": "v1",
            "start": {"dateTime": "2026-09-04T10:00:00+09:00", "timeZone": "Asia/Seoul"},
            "end": {"dateTime": "2026-09-04T10:30:00+09:00"}, "iCalUID": "ical-series"}),
        )
        .unwrap()
    }

    fn writable_calendar() -> GoogleCalendar {
        serde_json::from_value(json!({"id": "calendar", "accessRole": "writer"})).unwrap()
    }

    #[test]
    fn calendar_and_item_permissions_exclude_meetings_and_series() {
        assert!(calendar_can_write(Some("writerWithoutPrivateAccess")));
        assert!(calendar_can_write(Some("owner")));
        assert!(!calendar_can_write(Some("reader")));
        assert!(!calendar_can_write(None));
        let mut event = personal_event();
        assert!(event_can_write(&event));
        event.attendees.push(json!({"email": "guest@example.test"}));
        assert!(!event_can_write(&event));
        event.attendees.clear();
        event.recurrence.push("RRULE:FREQ=DAILY".into());
        assert!(!event_can_write(&event));
        event.recurrence.clear();
        event.locked = true;
        assert!(!event_can_write(&event));
        event.locked = false;
        event.event_type = Some("fromGmail".into());
        assert!(!event_can_write(&event));
    }

    #[test]
    fn raw_write_reference_does_not_change_existing_link_identity() {
        let item = event_item("calendar", personal_event()).unwrap();
        let reference = item.write_ref.unwrap();
        assert_eq!(reference.item_id, "raw-instance");
        assert_eq!(reference.external_id.as_deref(), Some("ical-series"));
        assert_eq!(
            item.id,
            format!(
                "{}:{}",
                URL_SAFE_NO_PAD.encode("calendar"),
                URL_SAFE_NO_PAD.encode("raw-instance")
            )
        );
        let url = event_url("user@example.test", Some("raw/id")).unwrap();
        assert!(url.as_str().contains("raw%2Fid"));
    }

    #[test]
    fn event_version_and_occurrence_prevent_stale_edits() {
        let mut event = personal_event();
        event.original_start_time = Some(EventTime {
            date_time: Some("2026-09-03T10:00:00+09:00".into()),
            ..Default::default()
        });
        let mut reference = event_item("calendar", personal_event())
            .unwrap()
            .write_ref
            .unwrap();
        assert!(
            require_event_version(&reference, &event, &writable_calendar())
                .unwrap_err()
                .starts_with("CONFLICT:")
        );
        reference.occurrence = event
            .original_start_time
            .as_ref()
            .and_then(EventTime::value);
        assert_eq!(
            require_event_version(&reference, &event, &writable_calendar()).unwrap(),
            "v1"
        );
        reference.version = Some("stale".into());
        assert!(require_event_version(&reference, &event, &writable_calendar()).is_err());
        reference.version = None;
        assert!(require_event_version(&reference, &event, &writable_calendar()).is_err());
    }

    #[test]
    fn missing_event_requires_confirmed_calendar_read_access() {
        assert!(
            resolved_event_item("calendar", None, Ok(writable_calendar()), true)
                .unwrap()
                .is_none()
        );
        assert!(
            resolved_event_item(
                "calendar",
                None,
                Err("NOT_FOUND: This Google calendar is no longer available.".into()),
                true,
            )
            .unwrap_err()
            .starts_with("CONFLICT:")
        );
        for calendar in [
            json!({"id": "calendar", "accessRole": "freeBusyReader"}),
            json!({"id": "calendar", "accessRole": "reader", "deleted": true}),
        ] {
            assert!(
                resolved_event_item(
                    "calendar",
                    None,
                    Ok(serde_json::from_value(calendar).unwrap()),
                    false,
                )
                .unwrap_err()
                .starts_with("CONFLICT:")
            );
        }
        assert_eq!(
            resolved_event_item("calendar", None, Err("NETWORK: unavailable".into()), false)
                .unwrap_err(),
            "NETWORK: unavailable"
        );
        let cancelled =
            serde_json::from_value(json!({"id": "gone", "status": "cancelled"})).unwrap();
        assert!(
            resolved_event_item(
                "calendar",
                Some(cancelled),
                Err("NOT_FOUND: inaccessible".into()),
                false,
            )
            .unwrap_err()
            .starts_with("CONFLICT:")
        );
    }

    #[test]
    fn forbidden_quota_errors_stay_retryable_without_claiming_read_only() {
        for reason in [
            "rateLimitExceeded",
            "userRateLimitExceeded",
            "quotaExceeded",
        ] {
            let body = json!({"error": {"errors": [{"reason": reason}]}});
            assert!(api_error(StatusCode::FORBIDDEN, Some(&body)).starts_with("RATE_LIMIT:"));
        }
        let denied = json!({"error": {"errors": [{"reason": "forbiddenForNonOrganizer"}]}});
        assert!(api_error(StatusCode::FORBIDDEN, Some(&denied)).starts_with("READ_ONLY:"));
        assert!(api_error(StatusCode::FORBIDDEN, None).starts_with("READ_ONLY:"));
        assert!(api_error(StatusCode::TOO_MANY_REQUESTS, None).starts_with("RATE_LIMIT:"));
        assert!(api_error(StatusCode::PRECONDITION_FAILED, None).starts_with("CONFLICT:"));
    }

    #[test]
    fn personal_patch_preserves_external_fields_and_clears_optional_values() {
        let event = personal_event();
        assert_eq!(
            patch_body(&event, json!({"title": "New"})).unwrap(),
            json!({"summary": "New"})
        );
        assert_eq!(
            patch_body(&event, json!({"description": null})).unwrap(),
            json!({"description": ""})
        );
        assert!(patch_body(&event, json!({"attendees": []})).is_err());
        assert!(patch_body(&event, json!({"title": null})).is_err());
        assert!(patch_body(&event, json!({"start": "2026-09-04T11:00:00+09:00"})).is_err());
        let all_day = patch_body(
            &event,
            json!({"allDay": true, "start": "2026-09-04", "end": "2026-09-06"}),
        )
        .unwrap();
        assert_eq!(all_day["start"]["date"], "2026-09-04");
        assert!(all_day["start"]["dateTime"].is_null());
        assert_eq!(all_day["end"]["date"], "2026-09-06");
        assert!(
            patch_body(
                &event,
                json!({"allDay": true, "start": "2026-09-04", "end": "2026-09-04"})
            )
            .is_err()
        );
    }

    #[test]
    fn creation_id_is_repeatable_and_google_safe() {
        let operation = "ffea1b81-33aa-4d5a-a3ef-cbcc3e76915a";
        let id = operation_event_id(operation).unwrap();
        assert_eq!(id, operation_event_id(operation).unwrap());
        assert_ne!(id, operation_event_id("next operation").unwrap());
        assert!(
            id.chars()
                .all(|character| character.is_ascii_digit() || ('a'..='v').contains(&character))
        );
        assert!(operation_event_id("").is_err());
    }

    #[test]
    fn dst_fold_and_all_day_dates_keep_distinct_semantics() {
        let mut draft = ItemDraft {
            title: "DST".into(),
            start: Some("2026-11-01T01:30:00-04:00".into()),
            end: Some("2026-11-01T01:30:00-05:00".into()),
            time_zone: Some("America/New_York".into()),
            ..Default::default()
        };
        let body = draft_body(&draft).unwrap();
        assert_eq!(body["start"]["dateTime"], "2026-11-01T01:30:00-04:00");
        assert_eq!(body["end"]["dateTime"], "2026-11-01T01:30:00-05:00");
        draft.start = Some("2026-11-01".into());
        draft.end = Some("2026-11-02".into());
        draft.all_day = true;
        assert_eq!(draft_body(&draft).unwrap()["end"]["date"], "2026-11-02");
        draft.completed = Some(true);
        assert!(draft_body(&draft).is_err());
    }

    #[test]
    fn range_requires_offsets_and_positive_duration() {
        assert!(
            validate_range(
                "2026-09-04T00:00:00+09:00",
                "2026-09-11T00:00:00+09:00",
                "Asia/Seoul"
            )
            .is_ok()
        );
        assert!(validate_range("2026-09-04", "2026-09-11", "Asia/Seoul").is_err());
        assert!(validate_range("2026-09-11T00:00:00Z", "2026-09-04T00:00:00Z", "UTC").is_err());
    }

    #[test]
    fn pagination_collects_empty_pages_and_propagates_failure_atomically() {
        runtime().block_on(async {
            let values = collect_pages(|token| async move {
                Ok::<_, String>(match token.as_deref() {
                    None => Page {
                        items: vec![1],
                        next_page_token: Some("next".into()),
                    },
                    Some("next") => Page {
                        items: vec![],
                        next_page_token: Some("last".into()),
                    },
                    Some("last") => Page {
                        items: vec![2],
                        next_page_token: None,
                    },
                    _ => panic!("unexpected page"),
                })
            })
            .await
            .unwrap();
            assert_eq!(values, vec![1, 2]);
            let failed = collect_pages(|token| async move {
                if token.is_some() {
                    Err("offline".into())
                } else {
                    Ok(Page {
                        items: vec![1],
                        next_page_token: Some("next".into()),
                    })
                }
            })
            .await;
            assert_eq!(failed.unwrap_err(), "offline");
            let repeated = collect_pages(|_| async {
                Ok(Page {
                    items: vec![1],
                    next_page_token: Some("same".into()),
                })
            })
            .await;
            assert!(repeated.is_err());
        });
    }
}
