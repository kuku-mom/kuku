pub mod apple;
mod google;
pub mod types;

use tauri::{AppHandle, command};
use types::{ConnectionStatus, EventRef, ExternalCalendar, ExternalItem, ItemDraft};

#[command]
pub async fn planner_google_status() -> ConnectionStatus {
    google::status().await
}

#[command]
pub async fn planner_google_connect(app: AppHandle) -> Result<ConnectionStatus, String> {
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
    google::calendars().await
}

#[command]
pub async fn planner_google_events(
    calendar_ids: Vec<String>,
    start: String,
    end: String,
    time_zone: String,
) -> Result<Vec<ExternalItem>, String> {
    google::events(calendar_ids, start, end, time_zone).await
}

#[command]
pub async fn planner_google_get(event_ref: EventRef) -> Result<Option<ExternalItem>, String> {
    google::get(event_ref).await
}

#[command]
pub async fn planner_google_create(
    calendar_id: String,
    draft: ItemDraft,
    operation_id: String,
) -> Result<ExternalItem, String> {
    google::create(calendar_id, draft, operation_id).await
}

#[command]
pub async fn planner_google_update(
    event_ref: EventRef,
    patch: serde_json::Value,
) -> Result<ExternalItem, String> {
    google::update(event_ref, patch).await
}

#[command]
pub async fn planner_google_delete(event_ref: EventRef) -> Result<(), String> {
    google::delete(event_ref).await
}
