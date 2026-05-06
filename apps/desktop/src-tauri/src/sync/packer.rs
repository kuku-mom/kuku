#![allow(dead_code)]

use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use tar::{Archive, Builder, EntryType, Header};

use super::crypto::{
    EncryptedBlobMetadata, PackAad, SymmetricKey, decrypt_blob, encrypt_blob,
    encrypted_blob_metadata,
};
use super::errors::{SyncError, SyncResult};
use super::keys;

const PACK_INDEX_PATH: &str = "pack-index.json";
const ENTRIES_DIR: &str = "entries";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackEntryInput {
    pub entry_id: String,
    pub plaintext: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PackIndex {
    pub format: String,
    pub version: u8,
    pub pack_id: String,
    pub entries: Vec<PackIndexEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PackIndexEntry {
    pub entry_id: String,
    pub plaintext_hash: String,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnpackedPack {
    pub index: PackIndex,
    pub entries: BTreeMap<String, Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedPack {
    pub object_id: String,
    pub metadata: EncryptedBlobMetadata,
    pub blob: Vec<u8>,
}

pub fn encrypt_pack(
    workspace_key: &SymmetricKey,
    workspace_id: &str,
    object_id: &str,
    object_kind: &str,
    commit_id: &str,
    entries: Vec<PackEntryInput>,
) -> SyncResult<EncryptedPack> {
    let pack = create_plain_pack(object_id, entries)?;
    let compressed = zstd::stream::encode_all(Cursor::new(pack), 0)?;
    let key = object_key(workspace_key, workspace_id, object_kind)?;
    let aad = PackAad::new(workspace_id, object_id, object_kind, commit_id);
    let blob = encrypt_blob(&key, &aad, &compressed)?;
    Ok(EncryptedPack {
        object_id: object_id.into(),
        metadata: encrypted_blob_metadata(&blob),
        blob,
    })
}

pub fn decrypt_pack(
    workspace_key: &SymmetricKey,
    workspace_id: &str,
    object_id: &str,
    object_kind: &str,
    commit_id: &str,
    blob: &[u8],
) -> SyncResult<UnpackedPack> {
    let key = object_key(workspace_key, workspace_id, object_kind)?;
    let aad = PackAad::new(workspace_id, object_id, object_kind, commit_id);
    let compressed = decrypt_blob(&key, &aad, blob)?;
    let plain = zstd::stream::decode_all(Cursor::new(compressed))?;
    let unpacked = unpack_plain_pack(&plain)?;
    if unpacked.index.pack_id != object_id {
        return Err(SyncError::Crypto("pack id mismatch".into()));
    }
    Ok(unpacked)
}

pub fn create_plain_pack(pack_id: &str, mut entries: Vec<PackEntryInput>) -> SyncResult<Vec<u8>> {
    entries.sort_by(|left, right| left.entry_id.cmp(&right.entry_id));
    for entry in &entries {
        validate_entry_id(&entry.entry_id)?;
    }
    if entries
        .windows(2)
        .any(|pair| pair[0].entry_id == pair[1].entry_id)
    {
        return Err(SyncError::InvalidArgument("duplicate pack entry id".into()));
    }

    let index = PackIndex {
        format: "kuku.sync.pack".into(),
        version: 1,
        pack_id: pack_id.into(),
        entries: entries
            .iter()
            .map(|entry| PackIndexEntry {
                entry_id: entry.entry_id.clone(),
                plaintext_hash: blake3::hash(&entry.plaintext).to_hex().to_string(),
                size_bytes: entry.plaintext.len().min(i64::MAX as usize) as i64,
            })
            .collect(),
    };
    let index_json = serde_json::to_vec(&index)?;

    let mut out = Vec::new();
    {
        let mut builder = Builder::new(&mut out);
        append_canonical_file(&mut builder, PACK_INDEX_PATH, &index_json)?;
        for entry in entries {
            append_canonical_file(
                &mut builder,
                &format!("{ENTRIES_DIR}/{}", entry.entry_id),
                &entry.plaintext,
            )?;
        }
        builder.finish()?;
    }
    Ok(out)
}

pub fn unpack_plain_pack(pack: &[u8]) -> SyncResult<UnpackedPack> {
    let files = read_canonical_tar_files(pack)?;
    let index_bytes = files
        .get(PACK_INDEX_PATH)
        .ok_or_else(|| SyncError::Crypto("pack index missing".into()))?;
    let index: PackIndex = serde_json::from_slice(index_bytes)?;
    if index.format != "kuku.sync.pack" || index.version != 1 {
        return Err(SyncError::UnsupportedVersion(index.version));
    }

    let mut entries = BTreeMap::new();
    for item in &index.entries {
        validate_entry_id(&item.entry_id)?;
        let path = format!("{ENTRIES_DIR}/{}", item.entry_id);
        let bytes = files
            .get(&path)
            .ok_or_else(|| SyncError::Crypto(format!("pack entry missing: {}", item.entry_id)))?;
        if bytes.len().min(i64::MAX as usize) as i64 != item.size_bytes {
            return Err(SyncError::Crypto(format!(
                "pack entry size mismatch: {}",
                item.entry_id
            )));
        }
        let hash = blake3::hash(bytes).to_hex().to_string();
        if hash != item.plaintext_hash {
            return Err(SyncError::Crypto(format!(
                "pack entry hash mismatch: {}",
                item.entry_id
            )));
        }
        entries.insert(item.entry_id.clone(), bytes.clone());
    }

    let expected_file_count = index.entries.len() + 1;
    if files.len() != expected_file_count {
        return Err(SyncError::Crypto(
            "pack contains unreferenced entries".into(),
        ));
    }

    Ok(UnpackedPack { index, entries })
}

fn object_key(
    workspace_key: &SymmetricKey,
    workspace_id: &str,
    object_kind: &str,
) -> SyncResult<SymmetricKey> {
    match object_kind {
        "content_pack" => Ok(keys::pack_key(workspace_key, workspace_id)),
        "checkpoint_pack" => Ok(keys::checkpoint_key(workspace_key, workspace_id)),
        _ => Err(SyncError::InvalidArgument(
            "unsupported pack object kind".into(),
        )),
    }
}

fn append_canonical_file(
    builder: &mut Builder<&mut Vec<u8>>,
    path: &str,
    bytes: &[u8],
) -> SyncResult<()> {
    let mut header = Header::new_ustar();
    header.set_entry_type(EntryType::Regular);
    header.set_size(bytes.len().try_into().unwrap_or(u64::MAX));
    header.set_mode(0o600);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header.set_cksum();
    builder.append_data(&mut header, path, Cursor::new(bytes))?;
    Ok(())
}

fn read_canonical_tar_files(pack: &[u8]) -> SyncResult<BTreeMap<String, Vec<u8>>> {
    let mut archive = Archive::new(Cursor::new(pack));
    let mut files = BTreeMap::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() {
            return Err(SyncError::Crypto("pack contains non-file tar entry".into()));
        }
        let path = validate_tar_path(&entry.path()?)?;
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        if files.insert(path.clone(), bytes).is_some() {
            return Err(SyncError::Crypto(format!(
                "duplicate pack tar path: {path}"
            )));
        }
    }
    Ok(files)
}

fn validate_tar_path(path: &Path) -> SyncResult<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| SyncError::Crypto("pack tar path is not utf-8".into()))?;
                if value.is_empty() {
                    return Err(SyncError::Crypto("pack tar path has empty segment".into()));
                }
                parts.push(value.to_string());
            }
            _ => {
                return Err(SyncError::Crypto(
                    "pack tar path traversal is not allowed".into(),
                ));
            }
        }
    }
    if parts.is_empty() {
        return Err(SyncError::Crypto("pack tar path is empty".into()));
    }
    if parts.len() == 1 && parts[0] == PACK_INDEX_PATH {
        return Ok(PACK_INDEX_PATH.into());
    }
    if parts.len() == 2 && parts[0] == ENTRIES_DIR {
        validate_entry_id(&parts[1])?;
        return Ok(format!("{ENTRIES_DIR}/{}", parts[1]));
    }
    Err(SyncError::Crypto("unexpected pack tar path".into()))
}

fn validate_entry_id(entry_id: &str) -> SyncResult<()> {
    if entry_id.is_empty()
        || entry_id == "."
        || entry_id == ".."
        || entry_id.contains('/')
        || entry_id.contains('\\')
        || !entry_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(SyncError::InvalidArgument("invalid pack entry id".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_key() -> SymmetricKey {
        [8u8; 32]
    }

    fn entries() -> Vec<PackEntryInput> {
        vec![
            PackEntryInput {
                entry_id: "entry_b".into(),
                plaintext: b"# Second\n".to_vec(),
            },
            PackEntryInput {
                entry_id: "entry_a".into(),
                plaintext: b"# First\n".to_vec(),
            },
        ]
    }

    #[test]
    fn pack_encrypt_decrypt_unpack_roundtrips() {
        let encrypted = encrypt_pack(
            &workspace_key(),
            "workspace-1",
            "object-1",
            "content_pack",
            "commit-1",
            entries(),
        )
        .unwrap();

        let unpacked = decrypt_pack(
            &workspace_key(),
            "workspace-1",
            "object-1",
            "content_pack",
            "commit-1",
            &encrypted.blob,
        )
        .unwrap();

        assert_eq!(encrypted.object_id, "object-1");
        assert_eq!(encrypted.metadata.size_bytes, encrypted.blob.len() as i64);
        assert_eq!(unpacked.index.pack_id, "object-1");
        assert_eq!(unpacked.entries["entry_a"], b"# First\n");
        assert_eq!(unpacked.entries["entry_b"], b"# Second\n");
    }

    #[test]
    fn pack_decrypt_with_wrong_object_id_fails() {
        let encrypted = encrypt_pack(
            &workspace_key(),
            "workspace-1",
            "object-1",
            "content_pack",
            "commit-1",
            entries(),
        )
        .unwrap();

        let err = decrypt_pack(
            &workspace_key(),
            "workspace-1",
            "object-2",
            "content_pack",
            "commit-1",
            &encrypted.blob,
        )
        .unwrap_err();

        assert!(matches!(err, SyncError::Crypto(message) if message == "aad hash mismatch"));
    }

    #[test]
    fn pack_decrypt_with_wrong_workspace_id_fails() {
        let encrypted = encrypt_pack(
            &workspace_key(),
            "workspace-1",
            "object-1",
            "content_pack",
            "commit-1",
            entries(),
        )
        .unwrap();

        let err = decrypt_pack(
            &workspace_key(),
            "workspace-2",
            "object-1",
            "content_pack",
            "commit-1",
            &encrypted.blob,
        )
        .unwrap_err();

        assert!(matches!(err, SyncError::Crypto(_)));
    }

    #[test]
    fn pack_decrypt_rejects_pack_id_mismatch() {
        let plain = create_plain_pack("object-2", entries()).unwrap();
        let compressed = zstd::stream::encode_all(Cursor::new(plain), 0).unwrap();
        let key = keys::pack_key(&workspace_key(), "workspace-1");
        let aad = PackAad::new("workspace-1", "object-1", "content_pack", "commit-1");
        let blob = encrypt_blob(&key, &aad, &compressed).unwrap();

        let err = decrypt_pack(
            &workspace_key(),
            "workspace-1",
            "object-1",
            "content_pack",
            "commit-1",
            &blob,
        )
        .unwrap_err();

        assert!(matches!(err, SyncError::Crypto(message) if message == "pack id mismatch"));
    }

    #[test]
    fn duplicate_pack_entry_id_is_rejected() {
        let err = create_plain_pack(
            "pack-1",
            vec![
                PackEntryInput {
                    entry_id: "entry".into(),
                    plaintext: b"first".to_vec(),
                },
                PackEntryInput {
                    entry_id: "entry".into(),
                    plaintext: b"second".to_vec(),
                },
            ],
        )
        .unwrap_err();

        assert!(
            matches!(err, SyncError::InvalidArgument(message) if message == "duplicate pack entry id")
        );
    }

    #[test]
    fn canonical_tar_metadata_is_stable() {
        let first = create_plain_pack("pack-1", entries()).unwrap();
        let second = create_plain_pack("pack-1", entries()).unwrap();

        assert_eq!(first, second);
    }

    #[test]
    fn tar_path_traversal_is_rejected() {
        let tar = raw_tar_regular_file("../evil", b"nope");

        let err = unpack_plain_pack(&tar).unwrap_err();

        assert!(
            matches!(err, SyncError::Crypto(message) if message == "pack tar path traversal is not allowed")
        );
    }

    #[test]
    fn tar_symlink_entry_is_rejected() {
        let mut tar = Vec::new();
        {
            let mut builder = Builder::new(&mut tar);
            let mut header = Header::new_ustar();
            header.set_entry_type(EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o600);
            header.set_uid(0);
            header.set_gid(0);
            header.set_mtime(0);
            header.set_link_name("target").unwrap();
            header.set_cksum();
            builder
                .append_data(&mut header, "entries/link", Cursor::new(Vec::<u8>::new()))
                .unwrap();
            builder.finish().unwrap();
        }

        let err = unpack_plain_pack(&tar).unwrap_err();

        assert!(
            matches!(err, SyncError::Crypto(message) if message == "pack contains non-file tar entry")
        );
    }

    fn raw_tar_regular_file(path: &str, content: &[u8]) -> Vec<u8> {
        let mut header = [0u8; 512];
        let path_bytes = path.as_bytes();
        assert!(path_bytes.len() <= 100);

        header[..path_bytes.len()].copy_from_slice(path_bytes);
        write_octal(&mut header[100..108], 0o600);
        write_octal(&mut header[108..116], 0);
        write_octal(&mut header[116..124], 0);
        write_octal(&mut header[124..136], content.len() as u64);
        write_octal(&mut header[136..148], 0);
        header[148..156].fill(b' ');
        header[156] = b'0';
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");

        let checksum: u32 = header.iter().map(|byte| *byte as u32).sum();
        let checksum = format!("{checksum:06o}\0 ");
        header[148..156].copy_from_slice(checksum.as_bytes());

        let mut out = Vec::new();
        out.extend_from_slice(&header);
        out.extend_from_slice(content);
        let padding = (512 - (content.len() % 512)) % 512;
        out.resize(out.len() + padding, 0);
        out.resize(out.len() + 1024, 0);
        out
    }

    fn write_octal(field: &mut [u8], value: u64) {
        let width = field.len() - 1;
        let value = format!("{value:0width$o}");
        field[..width].copy_from_slice(value.as_bytes());
        field[width] = 0;
    }
}
