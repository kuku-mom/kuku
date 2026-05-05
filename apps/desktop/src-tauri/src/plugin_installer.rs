use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, command};

use crate::variant;

pub const MANIFEST_FILE: &str = ".kuku-plugin.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThirdPartyPluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub kind: String,
    #[serde(default)]
    pub permissions: PluginPermissions,
    #[serde(default)]
    pub sidecars: serde_json::Map<String, Value>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub ai_tools: Vec<Value>,
    #[serde(default)]
    pub settings_schema: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPermissions {
    #[serde(default)]
    pub sidecar: bool,
    #[serde(default)]
    pub vault_read: bool,
    #[serde(default)]
    pub vault_write: bool,
    #[serde(default)]
    pub network: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginInfo {
    pub manifest: ThirdPartyPluginManifest,
    pub installed_path: String,
    pub package_path: String,
}

fn plugins_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    Ok(variant::data_root(&home).join("plugins"))
}

pub fn plugin_root(plugin_id: &str) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;
    Ok(plugins_root()?.join(plugin_id))
}

pub fn package_root(plugin_id: &str) -> Result<PathBuf, String> {
    Ok(plugin_root(plugin_id)?.join("package"))
}

pub fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    if plugin_id.is_empty() || plugin_id.len() > 64 {
        return Err("Plugin id must be 1-64 characters".into());
    }
    if !plugin_id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("Plugin id may only contain lowercase letters, numbers, and '-'".into());
    }
    if plugin_id.starts_with('-') || plugin_id.ends_with('-') || plugin_id.contains("--") {
        return Err("Plugin id must be hyphen-case without leading/trailing '-'".into());
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\0') {
        return Err("Path must be a non-empty relative path".into());
    }
    for component in Path::new(path).components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("Invalid relative path: {path}")),
        }
    }
    Ok(())
}

pub fn resolve_package_path(plugin_id: &str, relative_path: &str) -> Result<PathBuf, String> {
    validate_relative_path(relative_path)?;
    let root = package_root(plugin_id)?;
    let resolved = root.join(relative_path);
    if !resolved.starts_with(&root) {
        return Err("Path escapes plugin package".into());
    }
    Ok(resolved)
}

fn manifest_path_from_install_source(source: &Path) -> PathBuf {
    if source.is_file() {
        source.to_path_buf()
    } else {
        source.join(MANIFEST_FILE)
    }
}

pub fn read_manifest_at(path: &Path) -> Result<ThirdPartyPluginManifest, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read manifest '{}': {error}", path.display()))?;
    let manifest: ThirdPartyPluginManifest = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid plugin manifest '{}': {error}", path.display()))?;
    validate_manifest(&manifest, path.parent().unwrap_or_else(|| Path::new(".")))?;
    Ok(manifest)
}

fn validate_manifest(
    manifest: &ThirdPartyPluginManifest,
    package_dir: &Path,
) -> Result<(), String> {
    validate_plugin_id(&manifest.id)?;
    if manifest.kind != "third-party" {
        return Err("Plugin manifest kind must be 'third-party'".into());
    }
    if manifest.name.trim().is_empty()
        || manifest.version.trim().is_empty()
        || manifest.description.trim().is_empty()
        || manifest.author.trim().is_empty()
    {
        return Err(
            "Plugin manifest requires non-empty name, version, description, and author".into(),
        );
    }

    for (name, value) in &manifest.sidecars {
        validate_plugin_id(name)?;
        let path = value
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Sidecar '{name}' requires a string path"))?;
        validate_relative_path(path)?;
        let sidecar_path = package_dir.join(path);
        if !sidecar_path.exists() {
            return Err(format!("Sidecar '{name}' not found at {path}"));
        }
        if !value
            .get("commands")
            .map(|commands| commands.is_object())
            .unwrap_or(false)
        {
            return Err(format!("Sidecar '{name}' requires a commands object"));
        }
    }

    for skill in &manifest.skills {
        validate_relative_path(skill)?;
    }

    Ok(())
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to)
        .map_err(|error| format!("Failed to create '{}': {error}", to.display()))?;
    for entry in fs::read_dir(from)
        .map_err(|error| format!("Failed to read '{}': {error}", from.display()))?
    {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let source_path = entry.path();
        let target_path = to.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect '{}': {error}", source_path.display()))?;

        if file_type.is_symlink() {
            return Err(format!(
                "Symlinks are not allowed in plugin packages: {}",
                source_path.display()
            ));
        }
        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path).map_err(|error| {
                format!(
                    "Failed to copy '{}' to '{}': {error}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn install_from_package_source(source: &Path) -> Result<InstalledPluginInfo, String> {
    let manifest_path = manifest_path_from_install_source(source);
    let package_source = manifest_path
        .parent()
        .ok_or("Manifest must have a parent directory")?;
    let manifest = read_manifest_at(&manifest_path)?;

    let root = plugin_root(&manifest.id)?;
    let package = root.join("package");
    let tmp = root.join("package.tmp");

    fs::create_dir_all(&root).map_err(|error| format!("Failed to create plugin dir: {error}"))?;
    if tmp.exists() {
        fs::remove_dir_all(&tmp)
            .map_err(|error| format!("Failed to clear temp package: {error}"))?;
    }
    copy_dir_recursive(package_source, &tmp)?;
    let copied_manifest = read_manifest_at(&tmp.join(MANIFEST_FILE))?;
    if copied_manifest.id != manifest.id {
        return Err("Copied manifest id changed during install".into());
    }
    if package.exists() {
        fs::remove_dir_all(&package)
            .map_err(|error| format!("Failed to replace existing package: {error}"))?;
    }
    fs::rename(&tmp, &package).map_err(|error| format!("Failed to activate package: {error}"))?;

    Ok(InstalledPluginInfo {
        manifest,
        installed_path: root.to_string_lossy().into_owned(),
        package_path: package.to_string_lossy().into_owned(),
    })
}

fn bundled_plugin_source(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;

    if let Ok(path) = app.path().resolve(
        format!("plugins/{plugin_id}"),
        tauri::path::BaseDirectory::Resource,
    ) && path.join(MANIFEST_FILE).exists()
    {
        return Ok(path);
    }

    let cwd = std::env::current_dir().map_err(|error| format!("Failed to resolve cwd: {error}"))?;
    for ancestor in cwd.ancestors() {
        let candidate = ancestor.join("plugins").join(plugin_id);
        if candidate.join(MANIFEST_FILE).exists() {
            return Ok(candidate);
        }
    }

    Err(format!("Bundled plugin '{plugin_id}' was not found"))
}

#[command]
pub async fn plugin_install_from_directory(path: String) -> Result<InstalledPluginInfo, String> {
    install_from_package_source(&PathBuf::from(path))
}

#[command]
pub async fn plugin_install_bundled(
    app: AppHandle,
    plugin_id: String,
) -> Result<InstalledPluginInfo, String> {
    let source = bundled_plugin_source(&app, &plugin_id)?;
    install_from_package_source(&source)
}

#[command]
pub async fn plugin_list_installed() -> Result<Vec<InstalledPluginInfo>, String> {
    let root = plugins_root()?;
    fs::create_dir_all(&root).map_err(|error| format!("Failed to create plugins dir: {error}"))?;
    let mut installed = Vec::new();

    for entry in
        fs::read_dir(&root).map_err(|error| format!("Failed to read plugins dir: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Failed to read plugin entry: {error}"))?;
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let package = entry.path().join("package");
        let manifest_path = package.join(MANIFEST_FILE);
        if !manifest_path.exists() {
            continue;
        }
        match read_manifest_at(&manifest_path) {
            Ok(manifest) => installed.push(InstalledPluginInfo {
                manifest,
                installed_path: entry.path().to_string_lossy().into_owned(),
                package_path: package.to_string_lossy().into_owned(),
            }),
            Err(error) => {
                eprintln!("[plugin_installer] skipping invalid plugin: {error}");
            }
        }
    }

    installed.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    Ok(installed)
}

#[command]
pub async fn plugin_uninstall(plugin_id: String, keep_data: bool) -> Result<(), String> {
    let root = plugin_root(&plugin_id)?;
    if !root.exists() {
        return Ok(());
    }
    if keep_data {
        let package = root.join("package");
        if package.exists() {
            fs::remove_dir_all(&package)
                .map_err(|error| format!("Failed to remove plugin package: {error}"))?;
        }
    } else {
        fs::remove_dir_all(&root)
            .map_err(|error| format!("Failed to uninstall plugin: {error}"))?;
    }
    Ok(())
}

#[command]
pub async fn plugin_read_manifest(path: String) -> Result<ThirdPartyPluginManifest, String> {
    let manifest_path = manifest_path_from_install_source(&PathBuf::from(path));
    read_manifest_at(&manifest_path)
}
