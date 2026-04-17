use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::secure_storage;

static PENDING_AUTH_STATE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

const SECURE_SERVICE: &str = "mom.kuku.desktop.auth";
const SECURE_ACCOUNT: &str = "tokens";
const LEGACY_EXPIRES_IN: i64 = 3600;
const DEFAULT_AUTHORIZED_PLUGIN_IDS: &[&str] = &["ai-chat"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct LegacyStoredTokens {
    access_token: String,
    refresh_token: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct AuthPermissions {
    #[serde(default)]
    requested_plugins: BTreeSet<String>,
    #[serde(default)]
    authorized_plugins: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAuthorization {
    pub plugin_id: String,
    pub authorized: bool,
}

#[derive(Debug)]
pub enum TokenError {
    State(String),
    Store(String),
    NotFound,
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TokenError::State(message) => write!(f, "{message}"),
            TokenError::Store(message) => write!(f, "{message}"),
            TokenError::NotFound => write!(f, "token not found"),
        }
    }
}

impl std::error::Error for TokenError {}

impl From<secure_storage::SecureStorageError> for TokenError {
    fn from(value: secure_storage::SecureStorageError) -> Self {
        match value {
            secure_storage::SecureStorageError::State(message) => Self::State(message),
            secure_storage::SecureStorageError::Store(message) => Self::Store(message),
            secure_storage::SecureStorageError::NotFound => Self::NotFound,
        }
    }
}

pub fn store_pending_state(state: &str) {
    let mut guard = pending_state()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    *guard = Some(state.to_string());
}

pub fn validate_auth_state(received_state: &str) -> bool {
    let mut guard = pending_state()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    let expected = guard.take();
    expected.as_deref() == Some(received_state)
}

fn clear_pending_state() {
    let mut guard = pending_state()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    *guard = None;
}

pub fn store_tokens(
    access_token: &str,
    refresh_token: &str,
    expires_in: i64,
) -> Result<(), TokenError> {
    let tokens = StoredTokens {
        access_token: access_token.to_string(),
        refresh_token: refresh_token.to_string(),
        expires_at: format_rfc3339(SystemTime::now() + Duration::from_secs(expires_in as u64)),
    };
    write_tokens(&tokens)
}

pub fn replace_tokens(tokens: StoredTokens) -> Result<(), TokenError> {
    write_tokens(&tokens)
}

pub fn read_tokens() -> Result<StoredTokens, TokenError> {
    match secure_storage::read_bytes(SECURE_SERVICE, SECURE_ACCOUNT)? {
        Some(content) => serde_json::from_slice(&content)
            .map_err(|err| TokenError::Store(format!("invalid secure token JSON: {err}"))),
        None => migrate_legacy_tokens(),
    }
}

pub fn get_access_token() -> Result<String, TokenError> {
    let tokens = read_tokens()?;
    if tokens.access_token.is_empty() {
        return Err(TokenError::NotFound);
    }
    Ok(tokens.access_token)
}

pub fn has_tokens() -> Result<bool, TokenError> {
    match read_tokens() {
        Ok(tokens) => Ok(!tokens.access_token.is_empty() && !tokens.refresh_token.is_empty()),
        Err(TokenError::NotFound) => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn token_expires_soon(tokens: &StoredTokens) -> bool {
    parse_rfc3339(&tokens.expires_at)
        .map(|expires_at| expires_at <= SystemTime::now() + Duration::from_secs(60))
        .unwrap_or(true)
}

pub fn clear_tokens() -> Result<(), TokenError> {
    match secure_storage::delete(SECURE_SERVICE, SECURE_ACCOUNT) {
        Ok(()) | Err(secure_storage::SecureStorageError::NotFound) => {}
        Err(error) => return Err(error.into()),
    }
    let legacy_path = legacy_auth_path()?;
    if legacy_path.exists() {
        fs::remove_file(legacy_path).map_err(|err| TokenError::Store(err.to_string()))?;
    }
    Ok(())
}

pub fn clear_permissions() -> Result<(), TokenError> {
    let path = permissions_path()?;
    if path.exists() {
        fs::remove_file(path).map_err(|err| TokenError::Store(err.to_string()))?;
    }
    Ok(())
}

pub fn reset_auth_state() -> Result<(), TokenError> {
    clear_pending_state();
    clear_tokens()?;
    clear_permissions()?;
    Ok(())
}

pub fn list_plugin_authorizations() -> Result<Vec<PluginAuthorization>, TokenError> {
    let permissions = load_permissions()?;
    let mut plugin_ids = permissions.requested_plugins;
    plugin_ids.extend(permissions.authorized_plugins.keys().cloned());

    Ok(plugin_ids
        .into_iter()
        .map(|plugin_id| PluginAuthorization {
            authorized: permissions
                .authorized_plugins
                .get(&plugin_id)
                .copied()
                .unwrap_or(false),
            plugin_id,
        })
        .collect())
}

pub fn is_plugin_authorized(plugin_id: &str) -> Result<bool, TokenError> {
    let mut permissions = load_permissions()?;
    // Only persist when the requested set actually changed. AI hot paths
    // (header fetch on every turn / approval) call this repeatedly with the
    // same plugin id, and writing `~/.kuku/auth-permissions.json` on each
    // call is unnecessary disk I/O.
    let inserted = permissions.requested_plugins.insert(plugin_id.to_string());
    let authorized = permissions
        .authorized_plugins
        .get(plugin_id)
        .copied()
        .unwrap_or(false);
    if inserted {
        write_permissions(&permissions)?;
    }
    Ok(authorized)
}

pub fn set_plugin_authorized(plugin_id: &str, authorized: bool) -> Result<(), TokenError> {
    let mut permissions = load_permissions()?;
    permissions.requested_plugins.insert(plugin_id.to_string());
    permissions
        .authorized_plugins
        .insert(plugin_id.to_string(), authorized);
    write_permissions(&permissions)
}

fn pending_state() -> &'static Mutex<Option<String>> {
    PENDING_AUTH_STATE.get_or_init(|| Mutex::new(None))
}

fn write_tokens(tokens: &StoredTokens) -> Result<(), TokenError> {
    let content =
        serde_json::to_vec_pretty(tokens).map_err(|err| TokenError::Store(err.to_string()))?;
    secure_storage::write_bytes(SECURE_SERVICE, SECURE_ACCOUNT, &content).map_err(Into::into)
}

fn migrate_legacy_tokens() -> Result<StoredTokens, TokenError> {
    let path = legacy_auth_path()?;
    if !path.exists() {
        return Err(TokenError::NotFound);
    }
    let content = fs::read(&path).map_err(|err| TokenError::Store(err.to_string()))?;
    let legacy: LegacyStoredTokens =
        serde_json::from_slice(&content).map_err(|err| TokenError::Store(err.to_string()))?;
    let tokens = StoredTokens {
        access_token: legacy.access_token,
        refresh_token: legacy.refresh_token,
        expires_at: format_rfc3339(
            SystemTime::now() + Duration::from_secs(LEGACY_EXPIRES_IN as u64),
        ),
    };
    write_tokens(&tokens)?;
    fs::remove_file(path).map_err(|err| TokenError::Store(err.to_string()))?;
    Ok(tokens)
}

fn read_permissions() -> Result<AuthPermissions, TokenError> {
    let path = permissions_path()?;
    if !path.exists() {
        return Ok(AuthPermissions::default());
    }
    let content = fs::read(path).map_err(|err| TokenError::Store(err.to_string()))?;
    serde_json::from_slice(&content).map_err(|err| TokenError::Store(err.to_string()))
}

fn load_permissions() -> Result<AuthPermissions, TokenError> {
    let mut permissions = read_permissions()?;
    if apply_default_plugin_permissions(&mut permissions) {
        write_permissions(&permissions)?;
    }
    Ok(permissions)
}

fn apply_default_plugin_permissions(permissions: &mut AuthPermissions) -> bool {
    let mut changed = false;

    for plugin_id in DEFAULT_AUTHORIZED_PLUGIN_IDS {
        changed |= permissions
            .requested_plugins
            .insert((*plugin_id).to_string());
        if !permissions.authorized_plugins.contains_key(*plugin_id) {
            permissions
                .authorized_plugins
                .insert((*plugin_id).to_string(), true);
            changed = true;
        }
    }

    changed
}

fn write_permissions(permissions: &AuthPermissions) -> Result<(), TokenError> {
    let path = permissions_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| TokenError::Store(err.to_string()))?;
    }
    let content =
        serde_json::to_vec_pretty(permissions).map_err(|err| TokenError::Store(err.to_string()))?;
    fs::write(path, content).map_err(|err| TokenError::Store(err.to_string()))
}

fn permissions_path() -> Result<PathBuf, TokenError> {
    Ok(kuku_root()?.join("auth-permissions.json"))
}

fn legacy_auth_path() -> Result<PathBuf, TokenError> {
    Ok(kuku_root()?.join("auth.json"))
}

fn kuku_root() -> Result<PathBuf, TokenError> {
    let home = dirs::home_dir()
        .ok_or_else(|| TokenError::State("cannot resolve the user home directory".to_string()))?;
    Ok(home.join(".kuku"))
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

fn parse_rfc3339(value: &str) -> Option<SystemTime> {
    let value = value.strip_suffix('Z')?;
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;
    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<u64>().ok()?;
    let minute = time_parts.next()?.parse::<u64>().ok()?;
    let second = time_parts.next()?.parse::<u64>().ok()?;

    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }

    let days = days_from_civil(year, month, day)?;
    let seconds = days as u64 * 86_400 + hour * 3600 + minute * 60 + second;
    Some(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
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

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    let year = year as i64 - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = month as i64;
    let day = day as i64;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    if day_of_era >= 146_097 {
        return None;
    }
    Some(era * 146_097 + day_of_era - 719_468)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_pending_state_resets_pending_auth_callback() {
        store_pending_state("pending-state");
        clear_pending_state();

        assert!(!validate_auth_state("pending-state"));
    }

    #[test]
    fn apply_default_plugin_permissions_registers_core_plugins_once() {
        let mut permissions = AuthPermissions::default();

        let changed = apply_default_plugin_permissions(&mut permissions);

        assert!(changed);
        assert!(permissions.requested_plugins.contains("ai-chat"));
        assert_eq!(permissions.authorized_plugins.get("ai-chat"), Some(&true));
        assert!(!apply_default_plugin_permissions(&mut permissions));
    }
}
