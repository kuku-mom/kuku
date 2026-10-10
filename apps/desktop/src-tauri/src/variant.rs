//! Variant-aware storage naming.
//!
//! Every on-disk directory (`~/.kuku*`) and keychain service
//! (`mom.kuku.desktop.*`) routes through this module so preview, dev,
//! and prod builds never share auth tokens, settings, or plugin secrets
//! on the same machine. The bundle identifier is captured once at app
//! startup via [`init`] and looked up statelessly thereafter.
//!
//! Before `init` runs (e.g. in unit tests that never boot Tauri) the
//! suffix resolves to the empty string, which matches the legacy
//! prod layout. That keeps existing prod user data at `~/.kuku` and
//! `mom.kuku.desktop.*` accessible without migration.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static IDENTIFIER: OnceLock<String> = OnceLock::new();

/// Capture the Tauri bundle identifier (`app.config().identifier`).
/// Call once from the Tauri `setup` closure; subsequent calls are
/// ignored so the runtime view of the variant can't drift.
pub fn init(identifier: String) {
    let _ = IDENTIFIER.set(identifier);
}

fn variant_suffix() -> &'static str {
    match IDENTIFIER.get().map(String::as_str) {
        #[cfg(feature = "native-smoke")]
        Some("mom.kuku.app.native-smoke") => ".native-smoke",
        Some("mom.kuku.app.dev") => ".dev",
        Some("mom.kuku.app.preview") => ".preview",
        // Prod bundle, any unrecognized identifier, and the pre-init
        // fallback all collapse to the legacy suffix-less layout.
        _ => "",
    }
}

/// Home-relative app data root:
///   prod    → `~/.kuku`
///   preview → `~/.kuku.preview`
///   dev     → `~/.kuku.dev`
pub fn data_root(home: &Path) -> PathBuf {
    #[cfg(feature = "native-smoke")]
    if variant_suffix() == ".native-smoke" {
        return PathBuf::from(
            std::env::var("KUKU_NATIVE_SMOKE_ROOT")
                .expect("Native smoke requires an isolated data root"),
        );
    }
    let suffix = variant_suffix();
    if suffix.is_empty() {
        home.join(".kuku")
    } else {
        home.join(format!(".kuku{suffix}"))
    }
}

/// Keychain service name for a given logical component (`auth`,
/// `plugin-secrets`, …):
///   prod    → `mom.kuku.desktop.auth`
///   preview → `mom.kuku.desktop.auth.preview`
///   dev     → `mom.kuku.desktop.auth.dev`
pub fn keychain_service(base: &str) -> String {
    format!("mom.kuku.desktop.{base}{}", variant_suffix())
}
