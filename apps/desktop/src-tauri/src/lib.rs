mod ai_host;
mod ai_tools;
mod app_settings;
mod auth;
mod auth_commands;
mod config;
mod contract_client;
mod knowledge;
mod models;
mod plugin_fs;
#[allow(dead_code)]
mod plugin_secrets;
mod plugin_settings;
mod search;
mod secure_storage;
mod sync;
mod variant;
mod vault;

use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(vault::VaultState::new())
        .manage(search::SearchState::new())
        .manage(sync::SyncState::new())
        .plugin(kuku_ai::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .on_window_event(|window, event| {
            // Standard macOS: red button hides the window; the app stays in
            // the Dock. ⌘Q still quits because it fires ExitRequested, not
            // CloseRequested.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .setup(|app| {
            // Capture the bundle identifier before anything that touches
            // on-disk paths or the keychain runs — preview/dev/prod must
            // land in separate storage (~/.kuku[.variant],
            // mom.kuku.desktop.*[.variant]).
            variant::init(app.config().identifier.clone());
            kuku_ai::register_host(
                app.handle(),
                Arc::new(ai_host::DesktopAiHost::new(app.handle().clone())),
            );
            ai_tools::register_all(app.handle());
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    // Accept every registered scheme variant — prod, dev, and
                    // preview binaries share this code but are each registered
                    // for a different scheme pair in their bundle config.
                    let is_auth_url = matches!(
                        url.scheme(),
                        "kuku" | "com.kuku.app" | "kuku-preview" | "com.kuku.app.preview"
                    ) && url.host_str() == Some("auth");
                    if !is_auth_url {
                        continue;
                    }
                    let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
                    if let (Some(token), Some(state)) = (query.get("token"), query.get("state")) {
                        let token = token.to_string();
                        let state = state.to_string();
                        let app_handle = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            auth_commands::handle_auth_deep_link(&app_handle, &token, &state).await;
                        });
                    }
                }
            });

            #[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
            if let Err(error) = app.deep_link().register_all() {
                eprintln!("failed to register deep link schemes: {error}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Auth
            auth_commands::auth_check_status,
            auth_commands::auth_get_user,
            auth_commands::auth_list_plugin_authorizations,
            auth_commands::auth_logout,
            auth_commands::auth_open_login,
            auth_commands::auth_reset,
            auth_commands::auth_refresh,
            auth_commands::auth_set_plugin_authorized,
            auth_commands::auth_authorization_headers,
            // Plugin FS (sandboxed)
            plugin_fs::plugin_fs_read_text,
            plugin_fs::plugin_fs_write_text,
            plugin_fs::plugin_fs_read_binary,
            plugin_fs::plugin_fs_write_binary,
            plugin_fs::plugin_fs_exists,
            plugin_fs::plugin_fs_mkdir,
            plugin_fs::plugin_fs_read_dir,
            plugin_fs::plugin_fs_remove,
            // Plugin Settings
            plugin_settings::plugin_ensure_root_dirs,
            plugin_settings::plugin_get_settings,
            plugin_settings::plugin_save_settings,
            plugin_settings::plugin_get_settings_with_secrets,
            plugin_settings::plugin_save_settings_with_secrets,
            plugin_settings::plugin_clear_settings_with_secrets,
            plugin_settings::plugin_clear_all_settings,
            // App Settings
            app_settings::app_settings_get,
            app_settings::app_settings_set,
            app_settings::app_restart,
            // Vault FS
            vault::commands::vault_choose_directory,
            vault::commands::vault_open,
            vault::commands::vault_close,
            vault::commands::vault_get_current,
            vault::commands::vault_read_text,
            vault::commands::vault_write_text,
            vault::commands::vault_read_binary,
            vault::commands::vault_write_binary,
            vault::commands::vault_read_with_checksum,
            vault::commands::vault_write_with_checksum,
            vault::commands::vault_exists,
            vault::commands::vault_list_dir,
            vault::commands::vault_mkdir,
            vault::commands::vault_delete,
            vault::commands::vault_empty_trash,
            vault::commands::vault_get_trash_path,
            vault::commands::vault_remove,
            vault::commands::vault_rename,
            // Knowledge
            knowledge::commands::knowledge_status,
            knowledge::commands::knowledge_init,
            knowledge::commands::knowledge_create_decision_document,
            knowledge::commands::knowledge_create_wiki_decision_document,
            knowledge::commands::knowledge_read_decision_document,
            knowledge::commands::knowledge_read_memory,
            knowledge::commands::knowledge_read_wiki_page,
            knowledge::commands::knowledge_apply_decision_document,
            knowledge::commands::knowledge_search_memory,
            knowledge::commands::knowledge_search_wiki,
            knowledge::commands::knowledge_memory_context,
            knowledge::commands::knowledge_context,
            knowledge::commands::memory_propose,
            knowledge::commands::wiki_propose_page,
            knowledge::commands::wiki_propose_update,
            // Search
            search::commands::search_query_simple,
            search::commands::search_query_advanced,
            search::commands::search_get_status,
            search::commands::search_get_debug_status,
            search::commands::search_request_rebuild,
            search::commands::search_get_graph_snapshot,
            search::commands::search_resolve_wikilink,
            search::commands::search_get_config,
            search::commands::search_set_config,
            // Sync
            sync::commands::sync_get_status,
            sync::commands::sync_get_remote_status,
            sync::commands::sync_configure_vault,
            sync::commands::sync_set_enabled,
            sync::commands::sync_run_once,
            sync::commands::sync_list_conflicts,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS: when the user clicks the Dock icon after hiding the
            // window with the red traffic-light, bring it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                for (_, window) in app_handle.webview_windows() {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            let _ = (app_handle, event);
        });
}
