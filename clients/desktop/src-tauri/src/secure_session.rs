use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::hkdf::{KeyType, Salt, HKDF_SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use uuid::Uuid;

const VAULT_DIR_NAME: &str = "auth-vault";
const MASTER_KEY_FILE_NAME: &str = "master.key";
const SESSION_VAULT_FILE_NAME: &str = "session-vault.json";
const CREDENTIALS_VAULT_FILE_NAME: &str = "credentials-vault.json";
const MASTER_KEY_LEN: usize = 32;
const HKDF_SALT_LEN: usize = 16;
const CIPHER_VERSION: u8 = 1;

static VAULT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedEnvelope {
    version: u8,
    salt_hex: String,
    nonce_hex: String,
    ciphertext_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredIdentityRecord {
    enterprise: String,
    account: String,
    updated_at: u64,
    envelope: EncryptedEnvelope,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SessionVaultFile {
    active_key: Option<String>,
    active_envelope: Option<EncryptedEnvelope>,
    #[serde(default)]
    sessions: BTreeMap<String, StoredIdentityRecord>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CredentialsVaultFile {
    last_active_key: Option<String>,
    #[serde(default)]
    entries: BTreeMap<String, StoredIdentityRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedCredentialProfileSummary {
    pub enterprise: String,
    pub account: String,
    pub updated_at: u64,
}

#[derive(Debug, Deserialize)]
struct CredentialIdentityExtract {
    #[serde(default)]
    enterprise: String,
    #[serde(default)]
    account: String,
}

#[derive(Debug, Deserialize)]
struct SessionIdentityExtract {
    #[serde(default, rename = "tenantId")]
    tenant_id: String,
    #[serde(default)]
    enterprise: String,
    #[serde(default)]
    account: String,
}

struct Aes256GcmKeyLen;

impl KeyType for Aes256GcmKeyLen {
    fn len(&self) -> usize {
        32
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_segment(value: &str) -> String {
    value.trim().to_lowercase()
}

pub fn build_identity_key(enterprise: &str, account: &str) -> String {
    format!(
        "{}::{}",
        normalize_segment(enterprise),
        normalize_segment(account)
    )
}

fn resolve_vault_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
    Ok(app_data_dir.join(VAULT_DIR_NAME))
}

fn ensure_vault_dir(vault_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(vault_dir)
        .map_err(|error| format!("failed to create sandbox vault dir: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o700);
        let _ = fs::set_permissions(vault_dir, permissions);
    }
    Ok(())
}

fn write_atomic_private(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "invalid vault target path".to_string())?;
    ensure_vault_dir(parent)?;

    let tmp_path = parent.join(format!(
        ".{}.tmp-{}",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("vault"),
        Uuid::new_v4()
    ));

    let write_result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&tmp_path)
            .map_err(|error| format!("failed to create temporary vault file: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("failed to write temporary vault file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to flush temporary vault file: {error}"))?;
        drop(file);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600));
        }

        fs::rename(&tmp_path, target)
            .map_err(|error| format!("failed to commit vault file: {error}"))?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_result
}

/// Marks a master key file wrapped with Windows DPAPI (current-user scope).
const DPAPI_PREFIX: &str = "dpapi:";

fn key_from_bytes(bytes: &[u8]) -> Option<[u8; MASTER_KEY_LEN]> {
    <[u8; MASTER_KEY_LEN]>::try_from(bytes).ok()
}

/// On-disk form of the master key. Unix relies on the 0600 file in a 0700 directory. Windows has no
/// mode bits, so the key is wrapped with DPAPI: a copied `master.key` cannot be opened by another
/// Windows account or on another machine.
fn seal_master_key(key: &[u8; MASTER_KEY_LEN]) -> Result<String, String> {
    #[cfg(windows)]
    {
        dpapi::protect(key).map(|blob| format!("{DPAPI_PREFIX}{}", hex::encode(blob)))
    }
    #[cfg(not(windows))]
    {
        Ok(hex::encode(key))
    }
}

/// Why a stored master key could not be read. The two cases need different user guidance:
/// a corrupt file only needs a fresh sign-in, while a foreign DPAPI blob means the profile moved
/// and every saved account must be re-added.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MasterKeyUnsealFailure {
    /// The file is not a key this build can read (garbage, wrong length, bad hex, truncated blob).
    Corrupt,
    /// The file is a well-formed DPAPI blob this Windows account/machine cannot open: it was
    /// written by another account, or copied here from another machine.
    #[cfg_attr(not(windows), allow(dead_code))]
    ForeignDpapi,
}

/// Reads a stored master key. The flag asks the caller to rewrite it sealed: a plaintext key left by
/// an earlier Windows build. `Err` means the file is unusable here and a new key is generated.
fn unseal_master_key(raw: &[u8]) -> Result<([u8; MASTER_KEY_LEN], bool), MasterKeyUnsealFailure> {
    let text = String::from_utf8_lossy(raw).trim().to_string();
    if let Some(sealed) = text.strip_prefix(DPAPI_PREFIX) {
        #[cfg(windows)]
        {
            let blob = hex::decode(sealed).map_err(|_| MasterKeyUnsealFailure::Corrupt)?;
            return match dpapi::unprotect(&blob) {
                Ok(bytes) => match key_from_bytes(&bytes) {
                    Some(key) => Ok((key, false)),
                    None => Err(MasterKeyUnsealFailure::Corrupt),
                },
                // A blob this build wrote but cannot open is bound to another Windows account or
                // another machine; a merely truncated file is reported as `Corrupt` above.
                Err(_) => Err(MasterKeyUnsealFailure::ForeignDpapi),
            };
        }
        #[cfg(not(windows))]
        {
            let _ = sealed;
            return Err(MasterKeyUnsealFailure::Corrupt);
        }
    }
    let plain = hex::decode(&text)
        .ok()
        .and_then(|decoded| key_from_bytes(&decoded))
        .or_else(|| key_from_bytes(raw))
        .ok_or(MasterKeyUnsealFailure::Corrupt)?;
    Ok((plain, cfg!(windows)))
}

/// Record why the master key was replaced. Without this, a profile moved between accounts or
/// machines silently invalidates every saved account with no trace after the fact.
fn log_master_key_replaced(vault_dir: &Path, failure: MasterKeyUnsealFailure) {
    // `vault_dir` is always `<app data dir>/auth-vault` (see `resolve_vault_dir`), so its parent is
    // the diagnostics root. Best effort: login must not fail because the log could not be written.
    let Some(root) = vault_dir.parent() else {
        return;
    };
    let code = match failure {
        MasterKeyUnsealFailure::Corrupt => "master_key_corrupt",
        MasterKeyUnsealFailure::ForeignDpapi => "dpapi_foreign_user_or_machine",
    };
    crate::diagnostics::host_event_fields(
        root,
        "auth.master_key_replaced",
        "error",
        serde_json::json!({ "code": code }),
    );
}

fn load_or_create_master_key(vault_dir: &Path) -> Result<[u8; MASTER_KEY_LEN], String> {
    ensure_vault_dir(vault_dir)?;
    let key_path = vault_dir.join(MASTER_KEY_FILE_NAME);

    if key_path.exists() {
        let raw = fs::read(&key_path)
            .map_err(|error| format!("failed to read sandbox master key: {error}"))?;
        match unseal_master_key(&raw) {
            Ok((key, reseal)) => {
                if reseal {
                    // Best effort: the plaintext key still works, so a failed upgrade must not block login.
                    if let Ok(sealed) = seal_master_key(&key) {
                        let _ = write_atomic_private(&key_path, sealed.as_bytes());
                    }
                }
                return Ok(key);
            }
            Err(failure) => log_master_key_replaced(vault_dir, failure),
        }
    }

    let rng = SystemRandom::new();
    let mut key = [0u8; MASTER_KEY_LEN];
    rng.fill(&mut key)
        .map_err(|_| "failed to generate sandbox master key".to_string())?;
    write_atomic_private(&key_path, seal_master_key(&key)?.as_bytes())?;
    Ok(key)
}

#[cfg(windows)]
mod dpapi {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    /// Binds the blob to this app, so another program of the same user cannot unwrap it by accident.
    const ENTROPY: &[u8] = b"com.aiteam.desktop/auth-vault/master-key";

    pub(super) fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        run(data, true)
    }

    pub(super) fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        run(data, false)
    }

    fn blob(bytes: &[u8]) -> Result<CRYPT_INTEGER_BLOB, String> {
        let len = u32::try_from(bytes.len()).map_err(|_| "DPAPI input is too large".to_string())?;
        Ok(CRYPT_INTEGER_BLOB {
            cbData: len,
            pbData: bytes.as_ptr() as *mut u8,
        })
    }

    fn run(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let input = blob(data)?;
        let entropy = blob(ENTROPY)?;
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        // SAFETY: `input` and `entropy` borrow live slices that DPAPI only reads during the call;
        // `output` is written by DPAPI with a LocalAlloc buffer that is freed below.
        let ok = unsafe {
            if protect {
                CryptProtectData(
                    &input,
                    ptr::null(),
                    &entropy,
                    ptr::null(),
                    ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    ptr::null_mut(),
                    &entropy,
                    ptr::null(),
                    ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if ok == 0 || output.pbData.is_null() {
            return Err(if protect {
                "DPAPI failed to protect the vault key"
            } else {
                "DPAPI failed to unprotect the vault key"
            }
            .to_string());
        }
        let len = output.cbData as usize;
        // SAFETY: on success `output` holds `cbData` bytes owned by us until LocalFree; the buffer is
        // zeroed (it may hold the plaintext key) and freed exactly once.
        unsafe {
            let bytes = std::slice::from_raw_parts(output.pbData, len).to_vec();
            ptr::write_bytes(output.pbData, 0, len);
            LocalFree(output.pbData as _);
            Ok(bytes)
        }
    }
}

fn derive_record_key(
    master_key: &[u8; MASTER_KEY_LEN],
    salt: &[u8],
    aad_context: &str,
) -> Result<LessSafeKey, String> {
    let hkdf_salt = Salt::new(HKDF_SHA256, salt);
    let prk = hkdf_salt.extract(master_key);
    let info = [aad_context.as_bytes()];
    let okm = prk
        .expand(&info, Aes256GcmKeyLen)
        .map_err(|_| "failed to expand per-record encryption key".to_string())?;
    let mut derived = [0u8; 32];
    okm.fill(&mut derived)
        .map_err(|_| "failed to fill derived encryption key".to_string())?;
    let unbound = UnboundKey::new(&AES_256_GCM, &derived)
        .map_err(|_| "failed to initialize AES-256-GCM key".to_string())?;
    Ok(LessSafeKey::new(unbound))
}

fn encrypt_payload(
    master_key: &[u8; MASTER_KEY_LEN],
    aad_context: &str,
    plaintext: &str,
) -> Result<EncryptedEnvelope, String> {
    let rng = SystemRandom::new();
    let mut salt = [0u8; HKDF_SALT_LEN];
    rng.fill(&mut salt)
        .map_err(|_| "failed to generate encryption salt".to_string())?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill(&mut nonce_bytes)
        .map_err(|_| "failed to generate encryption nonce".to_string())?;

    let key = derive_record_key(master_key, &salt, aad_context)?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let mut in_out = plaintext.as_bytes().to_vec();
    key.seal_in_place_append_tag(nonce, Aad::from(aad_context.as_bytes()), &mut in_out)
        .map_err(|_| "failed to encrypt sandbox payload".to_string())?;

    Ok(EncryptedEnvelope {
        version: CIPHER_VERSION,
        salt_hex: hex::encode(salt),
        nonce_hex: hex::encode(nonce_bytes),
        ciphertext_hex: hex::encode(in_out),
    })
}

fn decrypt_payload(
    master_key: &[u8; MASTER_KEY_LEN],
    aad_context: &str,
    envelope: &EncryptedEnvelope,
) -> Result<String, String> {
    if envelope.version != CIPHER_VERSION {
        return Err("unsupported sandbox cipher version".to_string());
    }
    let salt = hex::decode(&envelope.salt_hex)
        .map_err(|_| "invalid encryption salt encoding".to_string())?;
    let nonce_vec = hex::decode(&envelope.nonce_hex)
        .map_err(|_| "invalid encryption nonce encoding".to_string())?;
    if nonce_vec.len() != NONCE_LEN {
        return Err("invalid encryption nonce length".to_string());
    }
    let mut nonce_bytes = [0u8; NONCE_LEN];
    nonce_bytes.copy_from_slice(&nonce_vec);

    let mut ciphertext = hex::decode(&envelope.ciphertext_hex)
        .map_err(|_| "invalid ciphertext encoding".to_string())?;

    let key = derive_record_key(master_key, &salt, aad_context)?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let decrypted = key
        .open_in_place(nonce, Aad::from(aad_context.as_bytes()), &mut ciphertext)
        .map_err(|_| "failed to authenticate and decrypt sandbox payload".to_string())?;

    String::from_utf8(decrypted.to_vec())
        .map_err(|_| "decrypted sandbox payload is not valid UTF-8".to_string())
}

fn read_json_file_or_default<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("failed to read sandbox vault file: {error}"))?;
    if raw.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str::<T>(&raw)
        .map_err(|error| format!("failed to parse sandbox vault file: {error}"))
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to serialize sandbox vault file: {error}"))?;
    write_atomic_private(path, &serialized)
}

pub fn session_read_in_dir(
    vault_dir: &Path,
    enterprise: Option<&str>,
    account: Option<&str>,
) -> Result<Option<String>, String> {
    let _guard = VAULT_LOCK
        .lock()
        .map_err(|_| "sandbox vault lock poisoned".to_string())?;
    let vault_path = vault_dir.join(SESSION_VAULT_FILE_NAME);
    if !vault_path.exists() {
        return Ok(None);
    }

    let master_key = load_or_create_master_key(vault_dir)?;
    let vault: SessionVaultFile = read_json_file_or_default(&vault_path)?;

    let filter_enterprise = enterprise.map(str::trim).unwrap_or("");
    let filter_account = account.map(str::trim).unwrap_or("");

    if !filter_enterprise.is_empty() || !filter_account.is_empty() {
        let target_key = build_identity_key(filter_enterprise, filter_account);
        if let Some(record) = vault.sessions.get(&target_key) {
            let aad = format!("session:{target_key}");
            return decrypt_payload(&master_key, &aad, &record.envelope).map(Some);
        }
        if !filter_account.is_empty() {
            let norm_account = normalize_segment(filter_account);
            if let Some((matched_key, record)) = vault
                .sessions
                .iter()
                .filter(|(_, item)| normalize_segment(&item.account) == norm_account)
                .max_by_key(|(_, item)| item.updated_at)
            {
                let aad = format!("session:{matched_key}");
                return decrypt_payload(&master_key, &aad, &record.envelope).map(Some);
            }
        }
        return Ok(None);
    }

    if let Some(active_key) = &vault.active_key {
        if let Some(record) = vault.sessions.get(active_key) {
            let aad = format!("session:{active_key}");
            return decrypt_payload(&master_key, &aad, &record.envelope).map(Some);
        }
    }

    if let Some(envelope) = &vault.active_envelope {
        return decrypt_payload(&master_key, "session:active", envelope).map(Some);
    }

    Ok(None)
}

pub fn session_write_in_dir(vault_dir: &Path, session: &str) -> Result<(), String> {
    let _guard = VAULT_LOCK
        .lock()
        .map_err(|_| "sandbox vault lock poisoned".to_string())?;
    let vault_path = vault_dir.join(SESSION_VAULT_FILE_NAME);
    let master_key = load_or_create_master_key(vault_dir)?;
    let mut vault: SessionVaultFile = read_json_file_or_default(&vault_path).unwrap_or_default();

    if session.is_empty() {
        if let Some(active_key) = vault.active_key.take() {
            vault.sessions.remove(&active_key);
        }
        vault.active_envelope = Some(encrypt_payload(&master_key, "session:active", "")?);
        write_json_file(&vault_path, &vault)?;
        return Ok(());
    }

    if let Ok(extracted) = serde_json::from_str::<SessionIdentityExtract>(session) {
        let scope_enterprise = if !extracted.enterprise.trim().is_empty() {
            extracted.enterprise.trim()
        } else {
            extracted.tenant_id.trim()
        };
        let scope_account = extracted.account.trim();
        if !scope_account.is_empty() {
            let key = build_identity_key(scope_enterprise, scope_account);
            let aad = format!("session:{key}");
            let envelope = encrypt_payload(&master_key, &aad, session)?;
            vault.sessions.insert(
                key.clone(),
                StoredIdentityRecord {
                    enterprise: scope_enterprise.to_string(),
                    account: scope_account.to_string(),
                    updated_at: now_millis(),
                    envelope,
                },
            );
            vault.active_key = Some(key);
            vault.active_envelope = None;
            write_json_file(&vault_path, &vault)?;
            return Ok(());
        }
    }

    vault.active_key = None;
    vault.active_envelope = Some(encrypt_payload(&master_key, "session:active", session)?);
    write_json_file(&vault_path, &vault)
}

pub fn session_delete_in_dir(
    vault_dir: &Path,
    enterprise: Option<&str>,
    account: Option<&str>,
) -> Result<(), String> {
    let _guard = VAULT_LOCK
        .lock()
        .map_err(|_| "sandbox vault lock poisoned".to_string())?;
    let vault_path = vault_dir.join(SESSION_VAULT_FILE_NAME);
    if !vault_path.exists() {
        return Ok(());
    }

    let mut vault: SessionVaultFile = read_json_file_or_default(&vault_path).unwrap_or_default();
    let filter_enterprise = enterprise.map(str::trim).unwrap_or("");
    let filter_account = account.map(str::trim).unwrap_or("");

    if !filter_enterprise.is_empty() || !filter_account.is_empty() {
        let key = build_identity_key(filter_enterprise, filter_account);
        vault.sessions.remove(&key);
        if vault.active_key.as_deref() == Some(key.as_str()) {
            vault.active_key = None;
        }
    } else {
        if let Some(active_key) = vault.active_key.take() {
            vault.sessions.remove(&active_key);
        }
        vault.active_envelope = None;
    }

    write_json_file(&vault_path, &vault)
}

pub fn credentials_read_in_dir(
    vault_dir: &Path,
    enterprise: Option<&str>,
    account: Option<&str>,
) -> Result<Option<String>, String> {
    let _guard = VAULT_LOCK
        .lock()
        .map_err(|_| "sandbox vault lock poisoned".to_string())?;
    let vault_path = vault_dir.join(CREDENTIALS_VAULT_FILE_NAME);
    if !vault_path.exists() {
        return Ok(None);
    }

    let master_key = load_or_create_master_key(vault_dir)?;
    let vault: CredentialsVaultFile = read_json_file_or_default(&vault_path)?;

    let filter_enterprise = enterprise.map(str::trim).unwrap_or("");
    let filter_account = account.map(str::trim).unwrap_or("");

    let selected: Option<(&String, &StoredIdentityRecord)> =
        if !filter_enterprise.is_empty() && !filter_account.is_empty() {
            let exact_key = build_identity_key(filter_enterprise, filter_account);
            vault.entries.get_key_value(&exact_key).or_else(|| {
                let fallback_empty_enterprise_key = build_identity_key("", filter_account);
                vault.entries.get_key_value(&fallback_empty_enterprise_key)
            })
        } else if !filter_account.is_empty() {
            let norm_account = normalize_segment(filter_account);
            let active_match = vault
                .last_active_key
                .as_ref()
                .and_then(|key| vault.entries.get_key_value(key))
                .filter(|(_, record)| normalize_segment(&record.account) == norm_account);
            active_match.or_else(|| {
                vault
                    .entries
                    .iter()
                    .filter(|(_, record)| normalize_segment(&record.account) == norm_account)
                    .max_by_key(|(_, record)| record.updated_at)
            })
        } else if !filter_enterprise.is_empty() {
            let norm_enterprise = normalize_segment(filter_enterprise);
            let active_match = vault
                .last_active_key
                .as_ref()
                .and_then(|key| vault.entries.get_key_value(key))
                .filter(|(_, record)| normalize_segment(&record.enterprise) == norm_enterprise);
            active_match.or_else(|| {
                vault
                    .entries
                    .iter()
                    .filter(|(_, record)| normalize_segment(&record.enterprise) == norm_enterprise)
                    .max_by_key(|(_, record)| record.updated_at)
            })
        } else {
            vault
                .last_active_key
                .as_ref()
                .and_then(|key| vault.entries.get_key_value(key))
                .or_else(|| {
                    vault
                        .entries
                        .iter()
                        .max_by_key(|(_, record)| record.updated_at)
                })
        };

    let Some((key, record)) = selected else {
        return Ok(None);
    };

    let aad = format!("credentials:{key}");
    decrypt_payload(&master_key, &aad, &record.envelope).map(Some)
}

pub fn credentials_write_in_dir(vault_dir: &Path, credentials: &str) -> Result<(), String> {
    let _guard = VAULT_LOCK
        .lock()
        .map_err(|_| "sandbox vault lock poisoned".to_string())?;
    let vault_path = vault_dir.join(CREDENTIALS_VAULT_FILE_NAME);
    let master_key = load_or_create_master_key(vault_dir)?;
    let mut vault: CredentialsVaultFile =
        read_json_file_or_default(&vault_path).unwrap_or_default();

    if credentials.is_empty() {
        let tombstone_key = vault
            .last_active_key
            .clone()
            .unwrap_or_else(|| build_identity_key("", "__tombstone__"));
        let aad = format!("credentials:{tombstone_key}");
        let envelope = encrypt_payload(&master_key, &aad, "")?;
        vault.entries.insert(
            tombstone_key.clone(),
            StoredIdentityRecord {
                enterprise: String::new(),
                account: String::new(),
                updated_at: now_millis(),
                envelope,
            },
        );
        vault.last_active_key = Some(tombstone_key);
        write_json_file(&vault_path, &vault)?;
        return Ok(());
    }

    let extracted = serde_json::from_str::<CredentialIdentityExtract>(credentials)
        .map_err(|_| "invalid login credentials payload".to_string())?;
    let enterprise = extracted.enterprise.trim().to_string();
    let account = extracted.account.trim().to_string();
    if account.is_empty() {
        return Err("login credentials account cannot be empty".to_string());
    }

    // Clean up any temporary tombstone entry if present.
    vault
        .entries
        .retain(|_, record| !record.account.trim().is_empty());

    let key = build_identity_key(&enterprise, &account);
    let aad = format!("credentials:{key}");
    let envelope = encrypt_payload(&master_key, &aad, credentials)?;

    vault.entries.insert(
        key.clone(),
        StoredIdentityRecord {
            enterprise,
            account,
            updated_at: now_millis(),
            envelope,
        },
    );
    vault.last_active_key = Some(key);
    write_json_file(&vault_path, &vault)
}

pub fn credentials_delete_in_dir(
    vault_dir: &Path,
    enterprise: Option<&str>,
    account: Option<&str>,
) -> Result<(), String> {
    let _guard = VAULT_LOCK
        .lock()
        .map_err(|_| "sandbox vault lock poisoned".to_string())?;
    let vault_path = vault_dir.join(CREDENTIALS_VAULT_FILE_NAME);
    if !vault_path.exists() {
        return Ok(());
    }

    let mut vault: CredentialsVaultFile =
        read_json_file_or_default(&vault_path).unwrap_or_default();
    let filter_enterprise = enterprise.map(str::trim).unwrap_or("");
    let filter_account = account.map(str::trim).unwrap_or("");

    if !filter_enterprise.is_empty() && !filter_account.is_empty() {
        let key = build_identity_key(filter_enterprise, filter_account);
        vault.entries.remove(&key);
        if vault.last_active_key.as_deref() == Some(key.as_str()) {
            vault.last_active_key = vault
                .entries
                .iter()
                .filter(|(_, item)| !item.account.trim().is_empty())
                .max_by_key(|(_, item)| item.updated_at)
                .map(|(k, _)| k.clone());
        }
    } else if !filter_account.is_empty() {
        let norm_account = normalize_segment(filter_account);
        vault
            .entries
            .retain(|_, item| normalize_segment(&item.account) != norm_account);
        if vault
            .last_active_key
            .as_ref()
            .is_some_and(|k| !vault.entries.contains_key(k))
        {
            vault.last_active_key = vault
                .entries
                .iter()
                .filter(|(_, item)| !item.account.trim().is_empty())
                .max_by_key(|(_, item)| item.updated_at)
                .map(|(k, _)| k.clone());
        }
    } else if let Some(active_key) = vault.last_active_key.take() {
        vault.entries.remove(&active_key);
        vault.last_active_key = vault
            .entries
            .iter()
            .filter(|(_, item)| !item.account.trim().is_empty())
            .max_by_key(|(_, item)| item.updated_at)
            .map(|(k, _)| k.clone());
    }

    // Also remove any empty tombstone records.
    vault
        .entries
        .retain(|_, record| !record.account.trim().is_empty());

    write_json_file(&vault_path, &vault)
}

pub fn credentials_list_in_dir(
    vault_dir: &Path,
) -> Result<Vec<SavedCredentialProfileSummary>, String> {
    let _guard = VAULT_LOCK
        .lock()
        .map_err(|_| "sandbox vault lock poisoned".to_string())?;
    let vault_path = vault_dir.join(CREDENTIALS_VAULT_FILE_NAME);
    if !vault_path.exists() {
        return Ok(Vec::new());
    }

    let vault: CredentialsVaultFile = read_json_file_or_default(&vault_path)?;
    let mut list: Vec<SavedCredentialProfileSummary> = vault
        .entries
        .values()
        .filter(|record| !record.account.trim().is_empty())
        .map(|record| SavedCredentialProfileSummary {
            enterprise: record.enterprise.clone(),
            account: record.account.clone(),
            updated_at: record.updated_at,
        })
        .collect();
    list.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
    Ok(list)
}

/// Read the serialized session from the encrypted local app sandbox vault.
#[tauri::command]
pub fn secure_session_read(
    app: tauri::AppHandle,
    enterprise: Option<String>,
    account: Option<String>,
) -> Result<Option<String>, String> {
    let vault_dir = resolve_vault_dir(&app)?;
    session_read_in_dir(&vault_dir, enterprise.as_deref(), account.as_deref())
}

/// Write and encrypt the active session into the local app sandbox vault.
#[tauri::command]
pub fn secure_session_write(app: tauri::AppHandle, session: String) -> Result<(), String> {
    let vault_dir = resolve_vault_dir(&app)?;
    session_write_in_dir(&vault_dir, &session)
}

#[tauri::command]
pub fn secure_session_delete(
    app: tauri::AppHandle,
    enterprise: Option<String>,
    account: Option<String>,
) -> Result<(), String> {
    let vault_dir = resolve_vault_dir(&app)?;
    session_delete_in_dir(&vault_dir, enterprise.as_deref(), account.as_deref())
}

/// Read encrypted login credentials from the local app sandbox vault,
/// optionally filtered by `enterprise` and/or `account`.
#[tauri::command]
pub fn secure_login_credentials_read(
    app: tauri::AppHandle,
    enterprise: Option<String>,
    account: Option<String>,
) -> Result<Option<String>, String> {
    let vault_dir = resolve_vault_dir(&app)?;
    credentials_read_in_dir(&vault_dir, enterprise.as_deref(), account.as_deref())
}

/// Encrypt and store login credentials indexed by `(enterprise, account)` in the local sandbox.
#[tauri::command]
pub fn secure_login_credentials_write(
    app: tauri::AppHandle,
    credentials: String,
) -> Result<(), String> {
    let vault_dir = resolve_vault_dir(&app)?;
    credentials_write_in_dir(&vault_dir, &credentials)
}

#[tauri::command]
pub fn secure_login_credentials_delete(
    app: tauri::AppHandle,
    enterprise: Option<String>,
    account: Option<String>,
) -> Result<(), String> {
    let vault_dir = resolve_vault_dir(&app)?;
    credentials_delete_in_dir(&vault_dir, enterprise.as_deref(), account.as_deref())
}

#[tauri::command]
pub fn secure_login_credentials_list(
    app: tauri::AppHandle,
) -> Result<Vec<SavedCredentialProfileSummary>, String> {
    let vault_dir = resolve_vault_dir(&app)?;
    credentials_list_in_dir(&vault_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault_dir() -> PathBuf {
        std::env::temp_dir().join(format!("aifred-vault-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn master_key_is_stable_and_stored_in_the_platform_form() {
        let vault_dir = temp_vault_dir();
        let first = load_or_create_master_key(&vault_dir).expect("create key");
        let second = load_or_create_master_key(&vault_dir).expect("reload key");
        assert_eq!(first, second);
        let stored =
            fs::read_to_string(vault_dir.join(MASTER_KEY_FILE_NAME)).expect("read key file");
        assert_eq!(stored.starts_with(DPAPI_PREFIX), cfg!(windows));
        assert_eq!(
            stored.contains(&hex::encode(first)),
            !cfg!(windows),
            "Windows must not store the key in plaintext"
        );
        let _ = fs::remove_dir_all(&vault_dir);
    }

    #[test]
    fn legacy_plaintext_key_keeps_working_and_is_resealed_only_on_windows() {
        let vault_dir = temp_vault_dir();
        ensure_vault_dir(&vault_dir).expect("vault dir");
        let legacy = [7u8; MASTER_KEY_LEN];
        fs::write(vault_dir.join(MASTER_KEY_FILE_NAME), hex::encode(legacy))
            .expect("write legacy key");
        assert_eq!(
            load_or_create_master_key(&vault_dir).expect("load legacy key"),
            legacy
        );
        let stored =
            fs::read_to_string(vault_dir.join(MASTER_KEY_FILE_NAME)).expect("read key file");
        assert_eq!(stored.starts_with(DPAPI_PREFIX), cfg!(windows));
        // Still the same key after the Windows upgrade, so existing vault records stay readable.
        assert_eq!(
            load_or_create_master_key(&vault_dir).expect("reload"),
            legacy
        );
        let _ = fs::remove_dir_all(&vault_dir);
    }

    #[test]
    fn unusable_key_files_are_replaced_instead_of_trusted() {
        assert_eq!(
            unseal_master_key(b"not a key"),
            Err(MasterKeyUnsealFailure::Corrupt)
        );
        assert_eq!(
            unseal_master_key(b"dpapi:zz"),
            Err(MasterKeyUnsealFailure::Corrupt)
        );
        #[cfg(not(windows))]
        assert_eq!(
            unseal_master_key(format!("{DPAPI_PREFIX}{}", "00".repeat(200)).as_bytes()),
            Err(MasterKeyUnsealFailure::Corrupt)
        );
        assert_eq!(
            unseal_master_key(&[9u8; MASTER_KEY_LEN]).map(|(key, _)| key),
            Ok([9u8; MASTER_KEY_LEN])
        );
    }

    #[test]
    fn master_key_replacement_is_recorded_in_the_diagnostics_log() {
        let root = std::env::temp_dir().join(format!("aifred-vault-root-{}", Uuid::new_v4()));
        let vault_dir = root.join(VAULT_DIR_NAME);
        fs::create_dir_all(&vault_dir).unwrap();
        log_master_key_replaced(&vault_dir, MasterKeyUnsealFailure::ForeignDpapi);
        let log = fs::read_to_string(root.join("logs/desktop.jsonl")).unwrap();
        assert!(log.contains("auth.master_key_replaced"), "{log}");
        assert!(log.contains("dpapi_foreign_user_or_machine"), "{log}");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip_and_tamper_rejection() {
        let sealed = dpapi::protect(&[1u8; MASTER_KEY_LEN]).expect("protect");
        assert_ne!(sealed, vec![1u8; MASTER_KEY_LEN]);
        assert_eq!(
            dpapi::unprotect(&sealed).expect("unprotect"),
            vec![1u8; MASTER_KEY_LEN]
        );
        let mut tampered = sealed.clone();
        *tampered.last_mut().unwrap() ^= 0xff;
        assert!(dpapi::unprotect(&tampered).is_err());
    }

    // A DPAPI blob this build cannot open is a moved profile (another Windows account or machine),
    // not a corrupt file: the two need different user guidance, so the unseal path must keep them
    // apart. Only Windows can produce a real blob, so this contract is checked by the Windows CI.
    #[cfg(windows)]
    #[test]
    fn an_unopenable_dpapi_blob_is_reported_as_foreign_not_corrupt() {
        let sealed = dpapi::protect(&[3u8; MASTER_KEY_LEN]).expect("protect");
        let mut tampered = sealed;
        *tampered.last_mut().unwrap() ^= 0xff;
        assert!(matches!(
            unseal_master_key(format!("{DPAPI_PREFIX}{}", hex::encode(&tampered)).as_bytes()),
            Err(MasterKeyUnsealFailure::ForeignDpapi)
        ));
    }

    #[test]
    fn stores_and_reads_multiple_accounts_and_enterprises_encrypted() {
        let vault_dir = temp_vault_dir();

        let cred_a =
            r#"{"enterprise":"acme","account":"alice@acme.com","password":"Secret-Alice-1!"}"#;
        let cred_b =
            r#"{"enterprise":"globex","account":"bob@globex.com","password":"Secret-Bob-2!"}"#;
        let cred_c =
            r#"{"enterprise":"acme","account":"charlie@acme.com","password":"Secret-Charlie-3!"}"#;

        credentials_write_in_dir(&vault_dir, cred_a).expect("write cred_a");
        credentials_write_in_dir(&vault_dir, cred_b).expect("write cred_b");
        credentials_write_in_dir(&vault_dir, cred_c).expect("write cred_c");

        // Verify the on-disk file never contains plaintext passwords.
        let raw_disk = fs::read_to_string(vault_dir.join(CREDENTIALS_VAULT_FILE_NAME))
            .expect("read raw vault file");
        assert!(!raw_disk.contains("Secret-Alice-1!"));
        assert!(!raw_disk.contains("Secret-Bob-2!"));
        assert!(!raw_disk.contains("Secret-Charlie-3!"));

        // Default read returns the most recently written active credential (cred_c).
        assert_eq!(
            credentials_read_in_dir(&vault_dir, None, None)
                .expect("read default")
                .as_deref(),
            Some(cred_c)
        );

        // Query by (enterprise, account) returns each specific user's credentials.
        assert_eq!(
            credentials_read_in_dir(&vault_dir, Some("acme"), Some("alice@acme.com"))
                .expect("read alice")
                .as_deref(),
            Some(cred_a)
        );
        assert_eq!(
            credentials_read_in_dir(&vault_dir, Some("GLOBEX"), Some("Bob@Globex.com"))
                .expect("read bob case-insensitive")
                .as_deref(),
            Some(cred_b)
        );

        // Query by account only or enterprise only also resolves accurately.
        assert_eq!(
            credentials_read_in_dir(&vault_dir, None, Some("alice@acme.com"))
                .expect("read by account only")
                .as_deref(),
            Some(cred_a)
        );
        assert_eq!(
            credentials_read_in_dir(&vault_dir, Some("globex"), None)
                .expect("read by enterprise only")
                .as_deref(),
            Some(cred_b)
        );

        // Deleting one specific (enterprise, account) preserves the others.
        credentials_delete_in_dir(&vault_dir, Some("acme"), Some("alice@acme.com"))
            .expect("delete alice");
        assert_eq!(
            credentials_read_in_dir(&vault_dir, Some("acme"), Some("alice@acme.com"))
                .expect("read deleted alice"),
            None
        );
        assert_eq!(
            credentials_read_in_dir(&vault_dir, Some("globex"), Some("bob@globex.com"))
                .expect("bob still exists")
                .as_deref(),
            Some(cred_b)
        );

        let profiles = credentials_list_in_dir(&vault_dir).expect("list profiles");
        assert_eq!(profiles.len(), 2);

        let _ = fs::remove_dir_all(&vault_dir);
    }

    #[test]
    fn rejects_tampered_ciphertext_or_cross_account_aad_swap() {
        let vault_dir = temp_vault_dir();
        let cred_a =
            r#"{"enterprise":"acme","account":"alice@acme.com","password":"Secret-Alice-1!"}"#;
        let cred_b =
            r#"{"enterprise":"globex","account":"bob@globex.com","password":"Secret-Bob-2!"}"#;

        credentials_write_in_dir(&vault_dir, cred_a).expect("write cred_a");
        credentials_write_in_dir(&vault_dir, cred_b).expect("write cred_b");

        let vault_path = vault_dir.join(CREDENTIALS_VAULT_FILE_NAME);
        let mut vault: CredentialsVaultFile =
            read_json_file_or_default(&vault_path).expect("parse vault");

        // Swap Alice's encrypted envelope into Bob's entry; AAD binding must reject it!
        let alice_key = build_identity_key("acme", "alice@acme.com");
        let bob_key = build_identity_key("globex", "bob@globex.com");
        let alice_env = vault.entries.get(&alice_key).unwrap().envelope.clone();
        vault.entries.get_mut(&bob_key).unwrap().envelope = alice_env;
        write_json_file(&vault_path, &vault).expect("write swapped vault");

        let swapped_result =
            credentials_read_in_dir(&vault_dir, Some("globex"), Some("bob@globex.com"));
        assert!(swapped_result.is_err());

        let _ = fs::remove_dir_all(&vault_dir);
    }

    #[test]
    fn stores_and_deletes_encrypted_sessions_per_identity() {
        let vault_dir = temp_vault_dir();
        let session_a = r#"{"token":"tok-a","tenantId":"tenant-acme","account":"alice@acme.com","claims":{"user_id":"u1","tenant_id":"tenant-acme","roles":["member"]}}"#;
        let session_b = r#"{"token":"tok-b","tenantId":"tenant-globex","account":"bob@globex.com","claims":{"user_id":"u2","tenant_id":"tenant-globex","roles":["admin"]}}"#;

        session_write_in_dir(&vault_dir, session_a).expect("write session_a");
        session_write_in_dir(&vault_dir, session_b).expect("write session_b");

        let raw_disk = fs::read_to_string(vault_dir.join(SESSION_VAULT_FILE_NAME))
            .expect("read raw session vault");
        assert!(!raw_disk.contains("tok-a"));
        assert!(!raw_disk.contains("tok-b"));

        // Default read returns active session (session_b).
        assert_eq!(
            session_read_in_dir(&vault_dir, None, None)
                .expect("read active session")
                .as_deref(),
            Some(session_b)
        );
        // Specific lookup returns session_a.
        assert_eq!(
            session_read_in_dir(&vault_dir, Some("tenant-acme"), Some("alice@acme.com"))
                .expect("read session_a by identity")
                .as_deref(),
            Some(session_a)
        );

        // Tombstone write + delete clears active session.
        session_write_in_dir(&vault_dir, "").expect("write session tombstone");
        session_delete_in_dir(&vault_dir, None, None).expect("delete active session");
        assert_eq!(
            session_read_in_dir(&vault_dir, None, None).expect("read after delete"),
            None
        );

        let _ = fs::remove_dir_all(&vault_dir);
    }
}
