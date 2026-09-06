//! EventKit adapter. Native owns every EventKit object and serializes mutations;
//! JSON references include a version and exact recurring occurrence for safe edits.

use super::types::{ConnectionStatus, EventRef, ExternalCalendar, ExternalItem, ItemDraft};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn validate_kind(kind: &str) -> Result<(), String> {
    match kind {
        "calendar" | "reminders" => Ok(()),
        _ => Err("Apple source must be calendar or reminders".into()),
    }
}

fn validate_range(start: &str, end: &str) -> Result<(), String> {
    let start = chrono::DateTime::parse_from_rfc3339(start)
        .map_err(|_| "Planner start must include an RFC 3339 time zone")?;
    let end = chrono::DateTime::parse_from_rfc3339(end)
        .map_err(|_| "Planner end must include an RFC 3339 time zone")?;
    let duration = end.signed_duration_since(start);
    if duration <= chrono::Duration::zero() || duration > chrono::Duration::days(366) {
        return Err("Planner range must be positive and at most 366 days".into());
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return Err("Invalid Apple item or calendar identifier".into());
    }
    Ok(())
}

fn validate_reference(kind: &str, reference: &EventRef) -> Result<(), String> {
    validate_kind(kind)?;
    let provider = if kind == "calendar" {
        "apple-calendar"
    } else {
        "apple-reminders"
    };
    if reference.provider != provider {
        return Err("Apple item reference belongs to another provider".into());
    }
    validate_identifier(&reference.calendar_id)?;
    validate_identifier(&reference.item_id)?;
    Ok(())
}

fn validate_patch(kind: &str, patch: &Value, creating: bool) -> Result<(), String> {
    let fields = patch
        .as_object()
        .ok_or("Apple item patch must be an object")?;
    for (key, value) in fields {
        match key.as_str() {
            "title" => {
                if value
                    .as_str()
                    .is_none_or(|value| value.trim().is_empty() || value.len() > 4096)
                {
                    return Err(
                        "Apple item title is required and must be at most 4096 bytes".into(),
                    );
                }
            }
            "allDay" | "completed" => {
                if !value.is_boolean() || (key == "completed" && kind != "reminders") {
                    return Err(format!("Invalid Apple item field: {key}"));
                }
            }
            "start" | "end" | "timeZone" | "location" | "description" | "dueDate" => {
                if !value.is_null()
                    && value
                        .as_str()
                        .is_none_or(|value| value.len() > 100_000 || value.contains('\0'))
                {
                    return Err(format!("Invalid Apple item field: {key}"));
                }
                if key == "dueDate" && kind != "reminders" && !value.is_null() {
                    return Err("Calendar events do not have a reminder due date".into());
                }
            }
            _ => return Err(format!("Unsupported Apple item field: {key}")),
        }
    }
    if creating && !fields.contains_key("title") {
        return Err("Apple item title is required".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::ffi::{CStr, CString, c_char, c_void};
    use tokio::sync::oneshot;

    unsafe extern "C" {
        fn kuku_planner_apple_request(
            request: *const c_char,
            callback: extern "C" fn(*const c_char, *mut c_void),
            context: *mut c_void,
        );
    }

    extern "C" fn receive_response(response: *const c_char, context: *mut c_void) {
        // Native invokes this callback exactly once. The sender remains owned by
        // native until completion, including when a Rust request is cancelled.
        let sender =
            unsafe { Box::from_raw(context.cast::<oneshot::Sender<Result<Value, String>>>()) };
        let result = if response.is_null() {
            Err("EventKit returned no response".into())
        } else {
            let bytes = unsafe { CStr::from_ptr(response) }.to_bytes();
            serde_json::from_slice::<Value>(bytes)
                .map_err(|_| "EventKit returned an invalid response".to_string())
                .and_then(|value| {
                    if let Some(error) = value.get("error").and_then(Value::as_str) {
                        Err(error.to_string())
                    } else {
                        value
                            .get("ok")
                            .cloned()
                            .ok_or_else(|| "EventKit response is incomplete".into())
                    }
                })
        };
        let _ = sender.send(result);
    }

    pub async fn request(request: Value) -> Result<Value, String> {
        let request = CString::new(request.to_string()).map_err(|_| "Invalid EventKit request")?;
        let (sender, receiver) = oneshot::channel();
        let context = Box::into_raw(Box::new(sender)).cast::<c_void>();
        // Native copies request before returning and runs the work on its serial
        // queue. No blocking EventKit fetch runs on the Tauri UI/runtime thread.
        unsafe { kuku_planner_apple_request(request.as_ptr(), receive_response, context) };
        tokio::time::timeout(std::time::Duration::from_secs(180), receiver)
            .await
            .map_err(|_| "Apple access request timed out; check the macOS permission dialog")?
            .map_err(|_| "Apple access request was interrupted")?
    }
}

async fn request<T: DeserializeOwned>(request: Value) -> Result<T, String> {
    #[cfg(target_os = "macos")]
    {
        serde_json::from_value(native::request(request).await?)
            .map_err(|error| format!("Invalid EventKit result: {error}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Err("Apple Calendar and Reminders are available only on macOS".into())
    }
}

#[tauri::command]
pub async fn planner_apple_status(kind: String) -> Result<ConnectionStatus, String> {
    validate_kind(&kind)?;
    #[cfg(not(target_os = "macos"))]
    return Ok(ConnectionStatus {
        provider: if kind == "calendar" {
            "apple-calendar"
        } else {
            "apple-reminders"
        }
        .into(),
        connected: false,
        configured: false,
        error: Some("Apple Calendar and Reminders are available only on macOS".into()),
        ..Default::default()
    });
    #[cfg(target_os = "macos")]
    request(json!({ "operation": "status", "kind": kind })).await
}

#[tauri::command]
pub async fn planner_apple_connect(kind: String) -> Result<ConnectionStatus, String> {
    validate_kind(&kind)?;
    request(json!({ "operation": "connect", "kind": kind })).await
}

#[tauri::command]
pub async fn planner_apple_calendars(kind: String) -> Result<Vec<ExternalCalendar>, String> {
    validate_kind(&kind)?;
    request(json!({ "operation": "calendars", "kind": kind })).await
}

#[tauri::command]
pub async fn planner_apple_items(
    kind: String,
    calendar_ids: Vec<String>,
    start: String,
    end: String,
    time_zone: String,
) -> Result<Vec<ExternalItem>, String> {
    validate_kind(&kind)?;
    validate_range(&start, &end)?;
    if calendar_ids.len() > 500
        || calendar_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > 4096)
    {
        return Err("Invalid Apple calendar selection".into());
    }
    request(json!({
        "operation": "items", "kind": kind, "calendarIds": calendar_ids,
        "start": start, "end": end, "timeZone": time_zone,
    }))
    .await
}

#[tauri::command]
pub async fn planner_apple_get(
    kind: String,
    event_ref: EventRef,
) -> Result<Option<ExternalItem>, String> {
    validate_reference(&kind, &event_ref)?;
    request(json!({ "operation": "get", "kind": kind, "ref": event_ref })).await
}

#[tauri::command]
pub async fn planner_apple_create(
    kind: String,
    calendar_id: String,
    draft: ItemDraft,
    operation_id: String,
) -> Result<ExternalItem, String> {
    validate_kind(&kind)?;
    validate_identifier(&calendar_id)?;
    uuid::Uuid::parse_str(&operation_id)
        .map_err(|_| "Apple creation requires a UUID operation ID")?;
    let mut draft = serde_json::to_value(draft).map_err(|_| "Invalid Apple item draft")?;
    if let Some(fields) = draft.as_object_mut() {
        fields.retain(|_, value| !value.is_null());
    }
    validate_patch(&kind, &draft, true)?;
    request(json!({ "operation": "create", "kind": kind, "calendarId": calendar_id, "draft": draft, "operationId": operation_id })).await
}

#[tauri::command]
pub async fn planner_apple_update(
    kind: String,
    event_ref: EventRef,
    patch: Value,
) -> Result<ExternalItem, String> {
    validate_reference(&kind, &event_ref)?;
    validate_patch(&kind, &patch, false)?;
    if event_ref.version.as_deref().is_none_or(str::is_empty) {
        return Err("CONFLICT: Refresh this Apple item before editing it".into());
    }
    request(json!({ "operation": "update", "kind": kind, "ref": event_ref, "patch": patch })).await
}

#[tauri::command]
pub async fn planner_apple_delete(kind: String, event_ref: EventRef) -> Result<(), String> {
    validate_reference(&kind, &event_ref)?;
    if event_ref.version.as_deref().is_none_or(str::is_empty) {
        return Err("CONFLICT: Refresh this Apple item before deleting it".into());
    }
    request(json!({ "operation": "delete", "kind": kind, "ref": event_ref })).await
}

#[tauri::command]
pub async fn planner_apple_disconnect(kind: String) -> Result<(), String> {
    validate_kind(&kind)?;
    request(json!({ "operation": "disconnect", "kind": kind })).await
}

/// Poll only while Planner is active. No calendar data or observer is created
/// by polling until a source is explicitly connected.
#[tauri::command]
pub async fn planner_apple_revision() -> Result<u64, String> {
    request(json!({ "operation": "revision" })).await
}

/// Stop native observation when the Planner plugin is disabled, without
/// disconnecting accounts or changing the user's saved connection choices.
#[tauri::command]
pub async fn planner_apple_suspend() -> Result<(), String> {
    request(json!({ "operation": "suspend" })).await
}

/// Open the original Apple application without interpreting an event URL or
/// accepting a caller-provided application path/bundle identifier.
#[tauri::command]
pub async fn planner_apple_open_app(kind: String) -> Result<(), String> {
    validate_kind(&kind)?;
    request(json!({ "operation": "open-app", "kind": kind })).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_supported_entity_types() {
        assert!(validate_kind("calendar").is_ok());
        assert!(validate_kind("reminders").is_ok());
        assert!(validate_kind("events-write").is_err());
    }

    #[test]
    fn range_validation_handles_dst_and_rejects_ambiguous_dates() {
        assert!(validate_range("2026-03-08T00:00:00-08:00", "2026-03-09T00:00:00-07:00").is_ok());
        assert!(validate_range("2026-03-08", "2026-03-09").is_err());
        assert!(validate_range("2026-03-09T00:00:00Z", "2026-03-08T00:00:00Z").is_err());
        assert!(validate_range("2026-01-01T00:00:00Z", "2031-01-01T00:00:00Z").is_err());
    }

    #[test]
    fn references_cannot_cross_provider_or_use_empty_identity() {
        let mut reference = EventRef {
            provider: "apple-calendar".into(),
            calendar_id: "calendar-1".into(),
            item_id: "local-item-1".into(),
            ..Default::default()
        };
        assert!(validate_reference("calendar", &reference).is_ok());
        assert!(validate_reference("reminders", &reference).is_err());
        reference.item_id.clear();
        assert!(validate_reference("calendar", &reference).is_err());
    }

    #[test]
    fn narrow_patches_allow_clearing_but_reject_external_side_effect_fields() {
        assert!(
            validate_patch(
                "calendar",
                &json!({"title":"Plan", "location":null, "description":null}),
                false
            )
            .is_ok()
        );
        assert!(
            validate_patch(
                "reminders",
                &json!({"completed":true, "dueDate":null}),
                false
            )
            .is_ok()
        );
        assert!(validate_patch("calendar", &json!({"attendees":[]}), false).is_err());
        assert!(validate_patch("calendar", &json!({"completed":true}), false).is_err());
        assert!(validate_patch("calendar", &json!({"recurrenceRules":[]}), false).is_err());
        assert!(validate_patch("calendar", &json!({"title":"   "}), false).is_err());
        assert!(validate_patch("calendar", &json!({"allDay":null}), false).is_err());
        assert!(validate_patch("calendar", &json!({}), true).is_err());
    }

    #[tokio::test]
    async fn destructive_commands_reject_missing_versions_before_native_access() {
        let reference = EventRef {
            provider: "apple-calendar".into(),
            calendar_id: "calendar-1".into(),
            item_id: "item-1".into(),
            ..Default::default()
        };
        assert!(
            planner_apple_update(
                "calendar".into(),
                reference.clone(),
                json!({"title":"Updated"})
            )
            .await
            .unwrap_err()
            .starts_with("CONFLICT:")
        );
        assert!(
            planner_apple_delete("calendar".into(), reference)
                .await
                .unwrap_err()
                .starts_with("CONFLICT:")
        );
    }
}
