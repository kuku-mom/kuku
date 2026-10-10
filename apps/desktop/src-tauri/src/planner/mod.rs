pub mod apple;
mod google;
pub mod types;

use tauri::{AppHandle, command};
use types::{ConnectionStatus, EventRef, ExternalCalendar, ExternalItem, ItemDraft};

// Temporarily paused pending Google Calendar OAuth scope verification.
// This gate does not affect the server's Google account sign-in.
const GOOGLE_CALENDAR_ENABLED: bool = false;
const GOOGLE_DISABLED: &str = "Google Calendar is temporarily unavailable.";

fn require_google_calendar() -> Result<(), String> {
    if GOOGLE_CALENDAR_ENABLED {
        Ok(())
    } else {
        Err(GOOGLE_DISABLED.into())
    }
}

#[command]
pub async fn planner_google_status() -> ConnectionStatus {
    if !GOOGLE_CALENDAR_ENABLED {
        return ConnectionStatus {
            provider: "google".into(),
            writable: Some(false),
            ..Default::default()
        };
    }
    google::status().await
}

#[command]
pub async fn planner_google_connect(app: AppHandle) -> Result<ConnectionStatus, String> {
    require_google_calendar()?;
    google::connect(&app).await
}

#[command]
pub async fn planner_google_disconnect() -> Result<ConnectionStatus, String> {
    google::disconnect().await
}

#[command]
pub fn planner_google_suspend() {
    google::suspend();
}

#[command]
pub async fn planner_google_calendars() -> Result<Vec<ExternalCalendar>, String> {
    require_google_calendar()?;
    google::calendars().await
}

#[command]
pub async fn planner_google_events(
    calendar_ids: Vec<String>,
    start: String,
    end: String,
    time_zone: String,
) -> Result<Vec<ExternalItem>, String> {
    require_google_calendar()?;
    google::events(calendar_ids, start, end, time_zone).await
}

#[command]
pub async fn planner_google_get(event_ref: EventRef) -> Result<Option<ExternalItem>, String> {
    require_google_calendar()?;
    google::get(event_ref).await
}

#[command]
pub async fn planner_google_create(
    calendar_id: String,
    draft: ItemDraft,
    operation_id: String,
) -> Result<ExternalItem, String> {
    require_google_calendar()?;
    google::create(calendar_id, draft, operation_id).await
}

#[command]
pub async fn planner_google_update(
    event_ref: EventRef,
    patch: serde_json::Value,
) -> Result<ExternalItem, String> {
    require_google_calendar()?;
    google::update(event_ref, patch).await
}

#[command]
pub async fn planner_google_delete(event_ref: EventRef) -> Result<(), String> {
    require_google_calendar()?;
    google::delete(event_ref).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn paused_google_calendar_blocks_native_reads_and_writes() {
        let status = planner_google_status().await;
        assert!(!status.configured && !status.connected);
        assert_eq!(status.writable, Some(false));
        assert_eq!(require_google_calendar().unwrap_err(), GOOGLE_DISABLED);
        assert_eq!(
            planner_google_calendars().await.unwrap_err(),
            GOOGLE_DISABLED
        );
        assert_eq!(
            planner_google_events(vec![], String::new(), String::new(), String::new())
                .await
                .unwrap_err(),
            GOOGLE_DISABLED
        );
        assert_eq!(
            planner_google_get(EventRef::default()).await.unwrap_err(),
            GOOGLE_DISABLED
        );
        assert_eq!(
            planner_google_create(String::new(), ItemDraft::default(), String::new())
                .await
                .unwrap_err(),
            GOOGLE_DISABLED
        );
        assert_eq!(
            planner_google_update(EventRef::default(), serde_json::Value::Null)
                .await
                .unwrap_err(),
            GOOGLE_DISABLED
        );
        assert_eq!(
            planner_google_delete(EventRef::default())
                .await
                .unwrap_err(),
            GOOGLE_DISABLED
        );
    }
}
