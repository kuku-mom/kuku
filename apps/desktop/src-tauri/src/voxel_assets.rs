use std::fs;
use std::path::PathBuf;

use tauri::command;

use crate::variant;

const CACHE_DIR_NAME: &str = "voxel-assets";

fn cache_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    Ok(variant::data_root(&home).join(CACHE_DIR_NAME))
}

fn validate_file_name(file_name: &str) -> Result<(), String> {
    let allowed = file_name.ends_with(".glb")
        && !file_name.is_empty()
        && !file_name.contains('/')
        && !file_name.contains('\\')
        && !file_name.contains("..")
        && file_name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'));

    if allowed {
        Ok(())
    } else {
        Err(format!("Invalid voxel asset file name: {file_name}"))
    }
}

fn validate_source_url(source_url: &str) -> Result<reqwest::Url, String> {
    let url =
        reqwest::Url::parse(source_url).map_err(|error| format!("Invalid source URL: {error}"))?;
    match url.scheme() {
        "https" => Ok(url),
        "http" if matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")) => Ok(url),
        _ => Err("Voxel assets must be fetched from https or localhost".into()),
    }
}

/// Ensure a GLB asset exists under the variant-aware global Kuku data root:
/// `~/.kuku/voxel-assets`, `~/.kuku.preview/voxel-assets`, or
/// `~/.kuku.dev/voxel-assets`. Returns the local filesystem path for
/// `convertFileSrc`.
#[command]
pub async fn voxel_ensure_asset(file_name: String, source_url: String) -> Result<String, String> {
    validate_file_name(&file_name)?;
    let source_url = validate_source_url(&source_url)?;

    let dir = cache_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create voxel asset cache: {error}"))?;

    let path = dir.join(&file_name);
    if path.metadata().map(|meta| meta.len() > 0).unwrap_or(false) {
        return path
            .to_str()
            .map(|value| value.to_string())
            .ok_or_else(|| "Voxel asset cache path contains invalid UTF-8".into());
    }

    let tmp_path = dir.join(format!(".{file_name}.download"));
    let response = reqwest::get(source_url)
        .await
        .map_err(|error| format!("Failed to download voxel asset '{file_name}': {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Failed to download voxel asset '{file_name}': HTTP {status}"
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read voxel asset '{file_name}': {error}"))?;
    if bytes.is_empty() {
        return Err(format!("Downloaded voxel asset '{file_name}' was empty"));
    }

    tokio::fs::write(&tmp_path, &bytes)
        .await
        .map_err(|error| format!("Failed to write voxel asset '{file_name}': {error}"))?;
    tokio::fs::rename(&tmp_path, &path)
        .await
        .map_err(|error| format!("Failed to move voxel asset '{file_name}' into cache: {error}"))?;

    path.to_str()
        .map(|value| value.to_string())
        .ok_or_else(|| "Voxel asset cache path contains invalid UTF-8".into())
}

#[cfg(test)]
mod tests {
    use super::validate_file_name;

    #[test]
    fn accepts_expected_glb_names() {
        assert!(validate_file_name("kuku-red.glb").is_ok());
        assert!(validate_file_name("kuku-house-1.glb").is_ok());
    }

    #[test]
    fn rejects_path_traversal_and_non_glb_names() {
        assert!(validate_file_name("../kuku-red.glb").is_err());
        assert!(validate_file_name("nested/kuku-red.glb").is_err());
        assert!(validate_file_name("kuku-red.png").is_err());
    }
}
