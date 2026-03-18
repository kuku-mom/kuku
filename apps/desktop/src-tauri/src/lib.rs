mod app_settings;
mod models;
mod plugin_fs;
mod plugin_settings;
mod vault;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(vault::VaultState::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
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
            // App Settings
            app_settings::app_settings_get,
            app_settings::app_settings_set,
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
            vault::commands::vault_remove,
            vault::commands::vault_rename,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
